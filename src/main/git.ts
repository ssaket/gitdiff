import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { EMPTY_TREE, type ChangeStatus, type FileChange, type RepoInfo } from '@shared/types'

const MAX_BUFFER = 128 * 1024 * 1024

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly stderr: string
  ) {
    super(message)
  }
}

interface RunOpts {
  env?: NodeJS.ProcessEnv
  /** Resolve with empty output instead of throwing (e.g. `git show` on a path that doesn't exist). */
  allowFailure?: boolean
}

function run(cwd: string, args: string[], opts: RunOpts = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        maxBuffer: MAX_BUFFER,
        encoding: 'buffer',
        env: { ...process.env, ...opts.env, GIT_OPTIONAL_LOCKS: '0' }
      },
      (err, stdout, stderr) => {
        if (err) {
          if (opts.allowFailure) return resolve(Buffer.alloc(0))
          const msg = stderr?.toString().trim() || err.message
          return reject(new GitError(msg, args, stderr?.toString() ?? ''))
        }
        resolve(stdout)
      }
    )
  })
}

export async function gitText(cwd: string, args: string[], opts: RunOpts = {}): Promise<string> {
  return (await run(cwd, args, opts)).toString('utf8')
}

export async function gitBuffer(cwd: string, args: string[], opts: RunOpts = {}): Promise<Buffer> {
  return run(cwd, args, opts)
}

export async function gitLine(cwd: string, args: string[], opts: RunOpts = {}): Promise<string> {
  return (await gitText(cwd, args, opts)).trim()
}

/** Splits git's NUL-delimited output, dropping the trailing empty element. */
function splitZ(out: string): string[] {
  const parts = out.split('\0')
  if (parts.length && parts[parts.length - 1] === '') parts.pop()
  return parts
}

export async function resolveRepo(anyPathInside: string): Promise<RepoInfo> {
  const stat = await fs.stat(anyPathInside).catch(() => null)
  const dir = stat?.isDirectory() ? anyPathInside : path.dirname(anyPathInside)
  const root = await gitLine(dir, ['rev-parse', '--show-toplevel'])
  if (!root) throw new Error(`${anyPathInside} is not inside a git repository`)

  const hasCommits = (await gitLine(root, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true })) !== ''
  const branch = hasCommits
    ? await gitLine(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
    : await gitLine(root, ['symbolic-ref', '--short', 'HEAD'], { allowFailure: true })
  const head = hasCommits ? await gitLine(root, ['rev-parse', '--short', 'HEAD']) : ''

  return {
    root,
    name: path.basename(root),
    branch: branch === 'HEAD' ? '(detached)' : branch || '(no branch)',
    head,
    hasCommits
  }
}

function normaliseStatus(raw: string): ChangeStatus {
  const c = raw[0]?.toUpperCase()
  if (c === 'A' || c === 'M' || c === 'D' || c === 'R' || c === 'C' || c === 'T') return c
  return 'M'
}

/**
 * Parses `git diff --name-status -z`. Rename/copy entries occupy three fields
 * (status, source, destination) rather than two.
 */
function parseNameStatus(out: string): Map<string, { status: ChangeStatus; oldPath?: string }> {
  const fields = splitZ(out)
  const result = new Map<string, { status: ChangeStatus; oldPath?: string }>()
  for (let i = 0; i < fields.length; ) {
    const raw = fields[i++]
    const status = normaliseStatus(raw)
    if (status === 'R' || status === 'C') {
      const oldPath = fields[i++]
      const newPath = fields[i++]
      if (newPath === undefined) break
      result.set(newPath, { status, oldPath })
    } else {
      const p = fields[i++]
      if (p === undefined) break
      result.set(p, { status })
    }
  }
  return result
}

/**
 * Parses `git diff --numstat -z`. A rename emits "adds\tdels\t" followed by two
 * extra NUL-separated fields; binary files report "-" for both counts.
 */
function parseNumstat(out: string): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const fields = splitZ(out)
  const result = new Map<string, { additions: number; deletions: number; binary: boolean }>()
  for (let i = 0; i < fields.length; ) {
    const entry = fields[i++]
    const parts = entry.split('\t')
    if (parts.length < 3) continue
    const binary = parts[0] === '-' || parts[1] === '-'
    const additions = binary ? 0 : Number(parts[0]) || 0
    const deletions = binary ? 0 : Number(parts[1]) || 0
    let target = parts[2]
    if (target === '') {
      i++ // source path of the rename — the destination is what we key on
      target = fields[i++]
      if (target === undefined) break
    }
    result.set(target, { additions, deletions, binary })
  }
  return result
}

/** The `git diff` revision arguments that produce a given baseline's change list. */
export async function diffRevArgs(
  repo: string,
  baseline: { kind: string; ref?: string },
  currentTreeRef?: string
): Promise<string[]> {
  switch (baseline.kind) {
    case 'worktree':
      return ['HEAD']
    case 'staged':
      return ['--cached', 'HEAD']
    case 'snapshot':
      // Both sides are trees, so untracked files are covered on both ends and
      // a file that was untracked before and is unchanged now stays quiet.
      return [baseline.ref!, currentTreeRef!]
    case 'commit': {
      const parent = await gitLine(repo, ['rev-parse', '--verify', `${baseline.ref}^`], {
        allowFailure: true
      })
      return [parent || EMPTY_TREE, baseline.ref!]
    }
    default:
      throw new Error(`unknown baseline ${baseline.kind}`)
  }
}

/**
 * Rename detection threshold, deliberately below git's default 50%.
 *
 * Agents rename a file and rewrite most of its body in the same breath, which
 * lands well under 50% similarity — git then reports an unrelated delete plus
 * add, and you lose the ability to diff old against new. Pairing them up is
 * far more useful here than the occasional spurious match.
 */
const RENAME_SIMILARITY = '30%'

export async function listChanges(repo: string, revArgs: string[]): Promise<FileChange[]> {
  const common = [`--find-renames=${RENAME_SIMILARITY}`, '--no-color', '-z', ...revArgs]
  const [nameStatusOut, numstatOut] = await Promise.all([
    gitText(repo, ['diff', '--name-status', ...common]),
    gitText(repo, ['diff', '--numstat', ...common])
  ])

  const statuses = parseNameStatus(nameStatusOut)
  const counts = parseNumstat(numstatOut)

  const files: FileChange[] = []
  for (const [p, { status, oldPath }] of statuses) {
    const c = counts.get(p) ?? { additions: 0, deletions: 0, binary: false }
    files.push({
      path: p,
      oldPath,
      status,
      additions: c.additions,
      deletions: c.deletions,
      binary: c.binary,
      untracked: false
    })
  }
  return files
}

const UNTRACKED_LIMIT = 1000
const LINE_COUNT_LIMIT = 2 * 1024 * 1024

export async function listUntracked(repo: string): Promise<FileChange[]> {
  const out = await gitText(repo, ['ls-files', '--others', '--exclude-standard', '-z'])
  const paths = splitZ(out).slice(0, UNTRACKED_LIMIT)

  return Promise.all(
    paths.map(async (p) => {
      let additions = 0
      let binary = false
      try {
        const stat = await fs.stat(path.join(repo, p))
        if (stat.size <= LINE_COUNT_LIMIT) {
          const buf = await fs.readFile(path.join(repo, p))
          binary = looksBinary(buf)
          if (!binary) additions = countLines(buf)
        } else {
          binary = true
        }
      } catch {
        // raced with the agent deleting it; report it as an empty add
      }
      return { path: p, status: 'A' as ChangeStatus, additions, deletions: 0, binary, untracked: true }
    })
  )
}

export function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0)
}

function countLines(buf: Buffer): number {
  if (buf.length === 0) return 0
  let n = 0
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++
  // a final line without a trailing newline still counts
  if (buf[buf.length - 1] !== 0x0a) n++
  return n
}

/** Content of `path` at a revision. `null` when the path doesn't exist there. */
export async function readBlob(repo: string, rev: string, filePath: string): Promise<Buffer | null> {
  const spec = rev === 'INDEX' ? `:${filePath}` : `${rev}:${filePath}`
  const out = await gitBuffer(repo, ['show', spec], { allowFailure: true })
  if (out.length > 0) return out
  // Empty output is ambiguous: a genuinely empty blob, or a path that isn't
  // there at all. Only the latter should render as "no previous version".
  try {
    await run(repo, ['cat-file', '-e', spec])
    return out
  } catch {
    return null
  }
}

export async function readWorktreeFile(repo: string, filePath: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(path.join(repo, filePath))
  } catch {
    return null
  }
}

export async function recentCommits(repo: string, limit = 60): Promise<
  { sha: string; shortSha: string; subject: string; author: string; relativeDate: string }[]
> {
  const out = await gitText(
    repo,
    ['log', `-${limit}`, '--no-color', `--pretty=format:%H%x00%h%x00%s%x00%an%x00%ar%x00`],
    { allowFailure: true }
  )
  const fields = splitZ(out)
  const commits: { sha: string; shortSha: string; subject: string; author: string; relativeDate: string }[] = []
  for (let i = 0; i + 5 <= fields.length; i += 5) {
    commits.push({
      // git log separates records with a newline, which lands at the head of
      // the next record's first field
      sha: fields[i].replace(/^\n/, ''),
      shortSha: fields[i + 1] ?? '',
      subject: fields[i + 2] ?? '',
      author: fields[i + 3] ?? '',
      relativeDate: fields[i + 4] ?? ''
    })
  }
  return commits
}

export async function stageFile(repo: string, filePath: string): Promise<void> {
  await gitText(repo, ['add', '--', filePath])
}

export async function unstageFile(repo: string, filePath: string): Promise<void> {
  await gitText(repo, ['restore', '--staged', '--', filePath], { allowFailure: true })
}

export async function checkoutFile(repo: string, filePath: string): Promise<void> {
  await gitText(repo, ['checkout', 'HEAD', '--', filePath])
}
