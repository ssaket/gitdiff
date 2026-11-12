import path from 'node:path'
import type { Baseline, ChangeStatus, DiffPayload, FileDiff } from '@shared/types'
import {
  isRegularFile,
  isUtf8,
  linesChangedIn,
  looksBinary,
  mergeBaseWith,
  parentOf,
  readBlob,
  readWorktreeFile
} from './git'
import { currentTree } from './snapshot'

const MAX_DIFF_BYTES = 3 * 1024 * 1024

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif'
}

/** Where each side of the diff comes from, per baseline. */
interface Sides {
  before: string | null // a revision, or null for "nothing existed here"
  after: string | 'WORKTREE'
}

export async function sidesFor(repo: string, baseline: Baseline): Promise<Sides> {
  switch (baseline.kind) {
    case 'branch':
      return { before: await mergeBaseWith(repo, baseline.base!), after: 'WORKTREE' }
    case 'worktree':
      return { before: 'HEAD', after: 'WORKTREE' }
    case 'snapshot':
      return { before: baseline.ref!, after: 'WORKTREE' }
    case 'commit': {
      const before = baseline.cumulative
        ? await mergeBaseWith(repo, baseline.base!)
        : await parentOf(repo, baseline.ref!)
      return { before, after: baseline.ref! }
    }
  }
}

async function readSide(
  repo: string,
  rev: string | null,
  filePath: string,
  baseline: Baseline
): Promise<Buffer | null> {
  if (rev === null) return null
  if (rev !== 'WORKTREE') return readBlob(repo, rev, filePath)

  const onDisk = await readWorktreeFile(repo, filePath)
  if (onDisk) return onDisk
  // In snapshot and branch modes the change list comes from a tree pair, so a
  // file can be listed after the agent has already moved it again. Fall back
  // to the tree.
  if (baseline.kind === 'snapshot' || baseline.kind === 'branch') {
    return readBlob(repo, await currentTree(repo), filePath)
  }
  return null
}

function toDataUrl(buf: Buffer, ext: string): string | null {
  const mime = IMAGE_MIME[ext]
  if (!mime) return null
  return `data:${mime};base64,${buf.toString('base64')}`
}

export async function loadFileDiff(
  repo: string,
  baseline: Baseline,
  file: { path: string; oldPath?: string; status: ChangeStatus; untracked: boolean; inCommit?: boolean }
): Promise<FileDiff> {
  const sides = await sidesFor(repo, baseline)

  // Untracked files and adds have no previous version; deletes have no new one.
  const beforeRev = file.untracked || file.status === 'A' ? null : sides.before
  const beforePath = file.oldPath ?? file.path
  const afterRev = file.status === 'D' ? null : sides.after

  const [beforeBuf, afterBuf] = await Promise.all([
    readSide(repo, beforeRev, beforePath, baseline),
    afterRev === null ? Promise.resolve(null) : readSide(repo, afterRev, file.path, baseline)
  ])

  const ext = path.extname(file.path).toLowerCase()
  // Editing writes the text straight back to disk, so only offer it when that
  // round trip is exact: a regular file (a symlink would be written through)
  // holding valid UTF-8 (anything else would come back as U+FFFD).
  const editable =
    afterRev === 'WORKTREE' &&
    afterBuf !== null &&
    isUtf8(afterBuf) &&
    (await isRegularFile(repo, file.path))
  const payload = buildPayload(beforeBuf, afterBuf, ext, beforePath, editable)
  const result: FileDiff = { path: file.path, status: file.status, payload }

  // Only files the commit touched have lines of its own to mark.
  if (baseline.kind === 'commit' && baseline.cumulative && file.inCommit && payload.kind === 'text' && afterRev !== null) {
    result.commitLines = await linesChangedIn(repo, baseline.ref!, file.path)
  }
  return result
}

function buildPayload(
  before: Buffer | null,
  after: Buffer | null,
  ext: string,
  originalPath: string,
  editable: boolean
): DiffPayload {
  const bytes = Math.max(before?.length ?? 0, after?.length ?? 0)

  if (ext in IMAGE_MIME) {
    return {
      kind: 'image',
      originalDataUrl: before ? toDataUrl(before, ext) : null,
      modifiedDataUrl: after ? toDataUrl(after, ext) : null
    }
  }

  if (bytes > MAX_DIFF_BYTES) return { kind: 'too-large', bytes }

  const binary = (before !== null && looksBinary(before)) || (after !== null && looksBinary(after))
  if (binary) {
    return {
      kind: 'binary',
      reason: `Binary file (${formatBytes(before?.length ?? 0)} → ${formatBytes(after?.length ?? 0)})`
    }
  }

  return {
    kind: 'text',
    original: before?.toString('utf8') ?? '',
    modified: after?.toString('utf8') ?? '',
    originalPath,
    editable
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
