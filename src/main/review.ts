import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  commentsAsMarkdown,
  locate,
  sanitizeReview,
  type LocatedComment,
  type ReviewState
} from '@shared/review'
import { gitLine } from './git'

/**
 * Review comments and rounds live in the repository's git directory —
 * `.git/gitdiff/review.json` — so they're never committed, stay with the
 * working tree they describe (a linked worktree gets its own), and the
 * `gitdiff comments` CLI can read them without the app running.
 *
 * Plain Node only: the CLI imports this under ELECTRON_RUN_AS_NODE, where
 * there is no Electron API to reach for.
 */

async function reviewPath(root: string): Promise<string> {
  const gitDir = await gitLine(root, ['rev-parse', '--absolute-git-dir'])
  return path.join(gitDir, 'gitdiff', 'review.json')
}

/**
 * Saves run one after another. Each is async, so two quick edits could
 * otherwise land on disk in the wrong order — and a read straight after a save
 * (sending comments right after writing one) has to see it.
 */
let pending: Promise<unknown> = Promise.resolve()

export async function loadReview(root: string): Promise<ReviewState> {
  await pending
  try {
    return sanitizeReview(JSON.parse(await fs.readFile(await reviewPath(root), 'utf8')))
  } catch {
    return { comments: [], rounds: [] }
  }
}

/** Written to a temp file and renamed into place, so a reader never sees half of it. */
export function saveReview(root: string, state: ReviewState): Promise<void> {
  const write = pending.then(async () => {
    const file = await reviewPath(root)
    await fs.mkdir(path.dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`
    await fs.writeFile(temp, JSON.stringify(sanitizeReview(state), null, 2))
    await fs.rename(temp, file)
  })
  pending = write.catch(() => {})
  return write
}

/** Where each open comment's lines are in the files on disk now. */
export async function locateOpen(root: string, state: ReviewState, onlyPath?: string): Promise<LocatedComment[]> {
  const open = state.comments.filter((c) => !c.resolved && (!onlyPath || c.path === onlyPath))
  const texts = new Map<string, string | null>()
  for (const c of open) {
    if (!texts.has(c.path)) {
      texts.set(c.path, await fs.readFile(path.join(root, c.path), 'utf8').catch(() => null))
    }
  }
  return open
    .map((comment) => {
      const text = texts.get(comment.path)
      return { comment, at: text == null ? null : locate(text, comment) }
    })
    .sort((a, b) => a.comment.path.localeCompare(b.comment.path) || a.comment.startLine - b.comment.startLine)
}

export async function reviewPrompt(root: string, opts: { intro?: boolean } = {}): Promise<string> {
  return commentsAsMarkdown(await locateOpen(root, await loadReview(root)), opts)
}
