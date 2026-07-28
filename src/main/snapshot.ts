import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { gitLine, gitText } from './git'

/**
 * Snapshots capture the *whole* worktree — tracked, staged and untracked alike —
 * as a git tree object, without touching the user's index, stash or HEAD.
 *
 * The trick is GIT_INDEX_FILE: pointing git at a scratch index means `git add -A`
 * stages into that file instead of `.git/index`, and `git write-tree` turns it
 * into a real tree object we can diff against later. The blobs it writes are
 * unreferenced, so a future `git gc` reclaims them.
 */

const indexDir = path.join(os.tmpdir(), 'gitdiff-indexes')

async function scratchIndexPath(key: string): Promise<string> {
  await fs.mkdir(indexDir, { recursive: true })
  return path.join(indexDir, key)
}

function keyFor(repo: string): string {
  return crypto.createHash('sha1').update(repo).digest('hex').slice(0, 16)
}

async function writeTreeWithIndex(repo: string, indexFile: string): Promise<string> {
  const env = { GIT_INDEX_FILE: indexFile }
  const seeded = await fs
    .stat(indexFile)
    .then((s) => s.size > 0)
    .catch(() => false)

  if (!seeded) {
    // Seeding from HEAD keeps file modes intact and lets `add -A` record deletions.
    const hasHead = (await gitLine(repo, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true })) !== ''
    await gitText(repo, hasHead ? ['read-tree', 'HEAD'] : ['read-tree', '--empty'], { env })
  }
  // On a reused index this is the cheap path: git's stat cache means only files
  // whose mtime/size moved get re-hashed. Re-seeding from HEAD would throw that
  // cache away, so we deliberately don't.
  await gitText(repo, ['add', '-A'], { env })
  return gitLine(repo, ['write-tree'], { env })
}

/** Marks "everything as it stands right now" and returns the tree sha. */
export async function markSnapshot(repo: string): Promise<string> {
  const indexFile = await scratchIndexPath(`snap-${keyFor(repo)}-${Date.now()}`)
  try {
    return await writeTreeWithIndex(repo, indexFile)
  } finally {
    await fs.rm(indexFile, { force: true })
  }
}

/**
 * The current worktree as a tree object, for diffing against a snapshot.
 *
 * The scratch index is deliberately reused between refreshes: git's stat cache
 * then means `add -A` only re-hashes files that actually changed, which keeps
 * live refresh cheap on large repos.
 */
export async function currentTree(repo: string): Promise<string> {
  const indexFile = await scratchIndexPath(`cur-${keyFor(repo)}`)
  return writeTreeWithIndex(repo, indexFile)
}

export async function disposeRepoIndexes(repo: string): Promise<void> {
  await fs.rm(await scratchIndexPath(`cur-${keyFor(repo)}`), { force: true }).catch(() => {})
}
