import path from 'node:path'
import { promises as fs } from 'node:fs'
import { BrowserWindow, clipboard, dialog, ipcMain, nativeImage, shell } from 'electron'
import type {
  Baseline,
  BranchInfo,
  ChangeSet,
  FileChange,
  FileDiff,
  FlowDoc,
  OpenFlowRequest,
  OpenRepoRequest,
  PrLookup,
  PublishRequest,
  PublishResult,
  RepoInfo
} from '@shared/types'
import {
  diffRevArgs,
  existsAt,
  forgetFromIndex,
  isUtf8,
  listChanges,
  listUntracked,
  pathsChangedIn,
  recentCommits,
  resolveRepo,
  restoreFromRev
} from './git'
import { currentTree, disposeRepoIndexes, markSnapshot } from './snapshot'
import { loadFileDiff, sidesFor } from './diff'
import { RepoWatcher } from './watcher'
import { consumePendingFlows, createFlow, updateFlow } from './flows'
import { branchInfo, lookupPr, publish } from './pr'
import { loadReview, locateOpen, reviewPrompt, saveReview } from './review'
import type { LocatedComment, ReviewState } from '@shared/review'
import { forgetRepo, getPrExcludes, listFlows, listRecentRepos, rememberRepo, removeFlow } from './store'

/**
 * The renderer names repos by absolute path, so the main process only honours
 * paths the user has actually opened — via the picker, a drop, or the recents
 * list. Anything else is refused rather than handed to `git -C`.
 */
const authorized = new Set<string>()

async function authorize(anyPath: string): Promise<RepoInfo> {
  const info = await resolveRepo(anyPath)
  authorized.add(info.root)
  await rememberRepo(info.root)
  return info
}

function assertAuthorized(root: string): void {
  if (!authorized.has(root)) throw new Error(`Repository not open: ${root}`)
}

/** Rejects paths that try to escape the repo via `..` or an absolute prefix. */
function safeJoin(root: string, relPath: string): string {
  const full = path.resolve(root, relPath)
  const rel = path.relative(root, full)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes repository: ${relPath}`)
  }
  return full
}

/**
 * safeJoin only checks the path as written; a symlinked directory inside the
 * repo can still lead out of it. Before writing, resolve the real location of
 * the nearest directory that exists and check that's inside the real repo.
 */
async function assertWritableInside(root: string, full: string, relPath: string): Promise<void> {
  const realRoot = await fs.realpath(root)
  let dir = path.dirname(full)
  let real: string | null = null
  while (!(real = await fs.realpath(dir).catch(() => null))) {
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const rel = real === null ? '..' : path.relative(realRoot, real)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`${relPath} is outside the repository (through a symlink), so it can't be saved from here.`)
  }
}

let watcher: RepoWatcher | null = null

/**
 * A repo requested before the UI could receive it. `gitdiff ~/proj` launches the
 * app and hands over a path in the same breath, so the request usually lands
 * while the renderer is still booting and has nobody listening yet. Parking it
 * here lets the renderer collect it on mount instead of racing for it.
 */
let pendingRequest: OpenRepoRequest | null = null

/** Opens a repo named from outside the UI: the CLI, or a Finder drop. */
export async function requestOpenRepo(root: string, win: BrowserWindow | null): Promise<void> {
  let payload: OpenRepoRequest
  try {
    payload = { repo: await authorize(root), error: null }
  } catch (e) {
    payload = { repo: null, error: e instanceof Error ? e.message : String(e) }
  }

  pendingRequest = payload
  // Also push it, for the already-running case (a second `gitdiff` invocation).
  // Whichever arrives first wins; applying the same repo twice is a no-op.
  win?.webContents.send('repo:openRequest', payload)
}

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  const handle = <A, R>(channel: string, fn: (arg: A) => Promise<R>): void => {
    ipcMain.handle(channel, async (_e, arg: A) => fn(arg))
  }

  handle<void, RepoInfo | null>('repo:pick', async () => {
    const win = getWindow()
    const result = await dialog.showOpenDialog(win!, {
      title: 'Open a git repository',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    return authorize(result.filePaths[0])
  })

  handle<string, RepoInfo>('repo:open', (p) => authorize(p))

  handle<void, OpenRepoRequest | null>('repo:consumePending', async () => {
    const pending = pendingRequest
    pendingRequest = null
    return pending
  })

  handle<void, { root: string; name: string }[]>('repo:recent', () => listRecentRepos())

  handle<string, void>('repo:forget', async (root) => {
    await forgetRepo(root)
  })

  handle<string, RepoInfo>('repo:refreshInfo', async (root) => {
    assertAuthorized(root)
    return resolveRepo(root)
  })

  handle<{ root: string; baseline: Baseline }, ChangeSet>('changes:list', async ({ root, baseline }) => {
    assertAuthorized(root)
    const repo = await resolveRepo(root)

    let files: FileChange[]
    if (!repo.hasCommits && baseline.kind !== 'snapshot') {
      // Nothing is committed yet, so everything on disk is new.
      files = await listUntracked(root)
    } else {
      const fromTrees = baseline.kind === 'snapshot' || baseline.kind === 'branch'
      const cur = fromTrees ? await currentTree(root) : undefined
      const revArgs = await diffRevArgs(root, baseline, cur)
      files = await listChanges(root, revArgs)
      // `git diff` only reports paths git already knows about; in worktree mode
      // the agent's brand-new files are exactly the ones you most want to see.
      if (baseline.kind === 'worktree') files = files.concat(await listUntracked(root))
      if (baseline.kind === 'commit' && baseline.cumulative) {
        const touched = await pathsChangedIn(root, baseline.ref!)
        files = files.map((f) => (touched.has(f.path) ? { ...f, inCommit: true } : f))
      }
    }

    files.sort((a, b) => a.path.localeCompare(b.path))
    return { files, repo, scannedAt: Date.now() }
  })

  handle<{ root: string; baseline: Baseline; file: FileChange }, FileDiff>(
    'diff:file',
    async ({ root, baseline, file }) => {
      assertAuthorized(root)
      safeJoin(root, file.path)
      return loadFileDiff(root, baseline, file)
    }
  )

  handle<string, string>('snapshot:mark', async (root) => {
    assertAuthorized(root)
    return markSnapshot(root)
  })

  handle<string, Awaited<ReturnType<typeof recentCommits>>>('commits:list', async (root) => {
    assertAuthorized(root)
    return recentCommits(root)
  })

  handle<{ root: string; base?: string }, BranchInfo>('branch:info', async ({ root, base }) => {
    assertAuthorized(root)
    return branchInfo(root, await resolveRepo(root), base)
  })

  handle<string, PrLookup>('pr:lookup', async (root) => {
    assertAuthorized(root)
    return lookupPr(root, (await resolveRepo(root)).branch)
  })

  handle<string, string[]>('pr:excludes', async (root) => {
    assertAuthorized(root)
    return getPrExcludes(root)
  })

  handle<PublishRequest, PublishResult>('pr:publish', async (req) => {
    assertAuthorized(req.root)
    for (const p of req.exclude) safeJoin(req.root, p)
    return publish(req, await resolveRepo(req.root))
  })

  /**
   * Throws away what the current view shows for one file — which depends on the
   * view. "Uncommitted" puts it back to HEAD; the whole-PR view puts it back to
   * the base branch, so it drops out of the PR even if the agent committed it;
   * "since round" puts it back to the round's start.
   */
  handle<{ root: string; baseline: Baseline; file: FileChange; where: string }, boolean>(
    'file:discard',
    async ({ root, baseline, file, where }) => {
      assertAuthorized(root)
      if (baseline.kind === 'commit') throw new Error("A commit's changes can't be discarded from here.")
      const full = safeJoin(root, file.path)
      if (file.oldPath) safeJoin(root, file.oldPath)

      const { before } = await sidesFor(root, baseline)
      // A rename's old side is a different path; a copy's source is still there
      // and untouched, so only the copy itself goes.
      const beforePath = file.status === 'R' && file.oldPath ? file.oldPath : file.path
      const hadIt = !file.untracked && before !== null && (await existsAt(root, before, beforePath))
      const onDisk = !!(await fs.lstat(full).catch(() => null))
      const trashes = onDisk && (!hadIt || beforePath !== file.path)
      const isHead = before === 'HEAD'
      // Gone from disk and not in the base either: against HEAD that can only
      // be a staged add the agent has since deleted, and unstaging is all
      // that's left to do. Anywhere else, there's nothing to throw away.
      const unstageOnly = !hadIt && !onDisk
      if (unstageOnly && !isHead) return false

      const { response } = await dialog.showMessageBox(getWindow()!, {
        type: 'warning',
        buttons: ['Cancel', hadIt ? 'Discard Changes' : unstageOnly ? 'Unstage' : 'Move to Trash'],
        defaultId: 0,
        cancelId: 0,
        message: hadIt
          ? `Discard the changes to ${file.path}?`
          : unstageOnly
            ? `Unstage ${file.path}?`
            : `Move ${file.path} to the Trash?`,
        detail: hadIt
          ? `It goes back to how it was ${where}.` +
            (trashes ? ` ${file.path} goes to the Trash and ${beforePath} comes back.` : '') +
            ' This cannot be undone.'
          : unstageOnly
            ? "It's staged as a new file but no longer on disk; this takes it out of the index."
            : `It didn't exist ${where}, so it goes to the Trash` +
              (file.untracked ? ' — git has no copy of it.' : '.')
      })
      if (response !== 1) return false

      if (hadIt) await restoreFromRev(root, before!, beforePath, isHead)
      if (trashes) await shell.trashItem(full)
      // Against HEAD a staged add would otherwise survive in the index with
      // nothing on disk behind it.
      if (isHead && (trashes || unstageOnly)) await forgetFromIndex(root, file.path)
      return true
    }
  )

  /**
   * Saves an edit made in the diff view. `expected` is what the file held when
   * editing began; if the agent has written it since, ask before overwriting
   * rather than silently dropping its change.
   */
  handle<{ root: string; path: string; text: string; expected: string }, boolean>(
    'file:write',
    async ({ root, path: p, text, expected }) => {
      assertAuthorized(root)
      const full = safeJoin(root, p)
      await assertWritableInside(root, full, p)
      // The diff view only offers editing for regular UTF-8 files; refuse the
      // rest here too, since writing through a symlink, or re-encoding Latin-1
      // as UTF-8, would damage something.
      const stat = await fs.lstat(full).catch(() => null)
      if (stat?.isSymbolicLink()) throw new Error(`${p} is a symlink; edit the file it points to instead.`)
      if (stat && !stat.isFile()) throw new Error(`${p} isn't a regular file.`)
      const bytes = stat ? await fs.readFile(full) : null
      if (bytes && !isUtf8(bytes)) {
        throw new Error(`${p} isn't UTF-8 text, so saving it from here would mangle it. Edit it in your editor.`)
      }
      const current = bytes?.toString('utf8') ?? null
      if (current !== null && current !== expected) {
        const { response } = await dialog.showMessageBox(getWindow()!, {
          type: 'warning',
          buttons: ['Cancel', 'Overwrite'],
          defaultId: 0,
          cancelId: 0,
          message: `${p} changed on disk while you were editing it.`,
          detail: 'Saving replaces what is on disk now — probably the agent\'s latest change — with your version.'
        })
        if (response !== 1) return false
      }
      await fs.mkdir(path.dirname(full), { recursive: true })
      await fs.writeFile(full, text, 'utf8')
      return true
    }
  )

  // ---------------------------------------------------------------- review

  handle<string, ReviewState>('review:load', async (root) => {
    assertAuthorized(root)
    return loadReview(root)
  })

  handle<{ root: string; state: ReviewState }, void>('review:save', async ({ root, state }) => {
    assertAuthorized(root)
    await saveReview(root, state)
  })

  handle<string, LocatedComment[]>('review:located', async (root) => {
    assertAuthorized(root)
    return locateOpen(root, await loadReview(root))
  })

  handle<string, string>('review:prompt', async (root) => {
    assertAuthorized(root)
    return reviewPrompt(root, { intro: true })
  })

  handle<string, void>('clipboard:writeText', async (text) => {
    clipboard.writeText(text)
  })

  handle<{ root: string; path: string }, void>('file:reveal', async ({ root, path: p }) => {
    assertAuthorized(root)
    shell.showItemInFolder(safeJoin(root, p))
  })

  handle<{ root: string; path: string }, void>('file:openExternal', async ({ root, path: p }) => {
    assertAuthorized(root)
    const full = safeJoin(root, p)
    if (await fs.stat(full).catch(() => null)) await shell.openPath(full)
  })

  // ------------------------------------------------------------------ flows

  handle<void, FlowDoc[]>('flow:list', () => listFlows())

  handle<{ title: string; source: string }, FlowDoc>('flow:create', ({ title, source }) =>
    createFlow({ title, source })
  )

  handle<{ id: string; title?: string; source?: string }, FlowDoc>('flow:update', (patch) =>
    updateFlow(patch)
  )

  handle<string, void>('flow:delete', (id) => removeFlow(id))

  handle<void, OpenFlowRequest | null>('flow:consumePending', async () => consumePendingFlows())

  handle<{ name: string; svg: string; png: string | null }, boolean>(
    'flow:export',
    async ({ name, svg, png }) => {
      const win = getWindow()
      const { canceled, filePath } = await dialog.showSaveDialog(win!, {
        title: 'Export diagram',
        defaultPath: `${name.replace(/[/\\:*?"<>|]+/g, '-').trim() || 'diagram'}.svg`,
        filters: [
          { name: 'SVG', extensions: ['svg'] },
          { name: 'PNG', extensions: ['png'] }
        ]
      })
      if (canceled || !filePath) return false

      // The dialog's file type follows whatever extension the user typed or
      // picked, so the extension is the only thing that decides the format.
      if (filePath.toLowerCase().endsWith('.png')) {
        if (!png) throw new Error('Could not rasterize this diagram — export it as SVG.')
        await fs.writeFile(filePath, Buffer.from(png.replace(/^data:.*?;base64,/, ''), 'base64'))
      } else {
        await fs.writeFile(filePath, svg, 'utf8')
      }
      return true
    }
  )

  handle<string, void>('flow:copyImage', async (dataUrl) => {
    const image = nativeImage.createFromDataURL(dataUrl)
    if (image.isEmpty()) throw new Error('Could not rasterize this diagram.')
    clipboard.writeImage(image)
  })

  handle<string, void>('watch:start', async (root) => {
    assertAuthorized(root)
    watcher?.stop()
    watcher = new RepoWatcher(root, () => {
      getWindow()?.webContents.send('repo:changed', root)
    })
    watcher.start()
  })

  handle<void, void>('watch:stop', async () => {
    watcher?.stop()
    watcher = null
  })
}

export function disposeIpc(): void {
  watcher?.stop()
  watcher = null
  for (const root of authorized) void disposeRepoIndexes(root)
}
