import path from 'node:path'
import { promises as fs } from 'node:fs'
import { BrowserWindow, clipboard, dialog, ipcMain, nativeImage, shell } from 'electron'
import type {
  Baseline,
  ChangeSet,
  FileChange,
  FileDiff,
  FlowDoc,
  OpenFlowRequest,
  OpenRepoRequest,
  RepoInfo
} from '@shared/types'
import {
  checkoutFile,
  diffRevArgs,
  listChanges,
  listUntracked,
  recentCommits,
  resolveRepo,
  stageFile,
  unstageFile
} from './git'
import { currentTree, disposeRepoIndexes, markSnapshot } from './snapshot'
import { loadFileDiff } from './diff'
import { RepoWatcher } from './watcher'
import { consumePendingFlows, createFlow, updateFlow } from './flows'
import { forgetRepo, listFlows, listRecentRepos, rememberRepo, removeFlow } from './store'

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
      const cur = baseline.kind === 'snapshot' ? await currentTree(root) : undefined
      const revArgs = await diffRevArgs(root, baseline, cur)
      files = await listChanges(root, revArgs)
      // `git diff` only reports paths git already knows about; in worktree mode
      // the agent's brand-new files are exactly the ones you most want to see.
      if (baseline.kind === 'worktree') files = files.concat(await listUntracked(root))
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

  handle<{ root: string; path: string }, void>('file:stage', async ({ root, path: p }) => {
    assertAuthorized(root)
    safeJoin(root, p)
    await stageFile(root, p)
  })

  handle<{ root: string; path: string }, void>('file:unstage', async ({ root, path: p }) => {
    assertAuthorized(root)
    safeJoin(root, p)
    await unstageFile(root, p)
  })

  handle<{ root: string; path: string; untracked: boolean }, boolean>(
    'file:revert',
    async ({ root, path: p, untracked }) => {
      assertAuthorized(root)
      const full = safeJoin(root, p)
      const win = getWindow()

      const { response } = await dialog.showMessageBox(win!, {
        type: 'warning',
        buttons: ['Cancel', untracked ? 'Move to Trash' : 'Discard Changes'],
        defaultId: 0,
        cancelId: 0,
        message: untracked ? `Move ${p} to the Trash?` : `Discard all changes to ${p}?`,
        detail: untracked
          ? 'The file is untracked, so git has no copy of it. It will go to the Trash.'
          : 'The file will be restored to its committed state. This cannot be undone.'
      })
      if (response !== 1) return false

      if (untracked) {
        await shell.trashItem(full)
      } else {
        await checkoutFile(root, p)
      }
      return true
    }
  )

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
