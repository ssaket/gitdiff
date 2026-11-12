import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  EMPTY_TREE,
  type Baseline,
  type ChangeStatus,
  type CommitInfo,
  type FileChange,
  type RepoInfo
} from '@shared/types'

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
  /** Written to stdin — commit messages, mostly. */
  input?: string
  /** Kill the process after this long. Network operations only; local ones are fast. */
  timeoutMs?: number
}

function run(cwd: string, args: string[], opts: RunOpts = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      {
        cwd,
        maxBuffer: MAX_BUFFER,
        encoding: 'buffer',
        timeout: opts.timeoutMs ?? 0,
        // There is no terminal behind this process, so a credential prompt
        // would wait forever. Fail instead and let the error say why.
        env: { ...process.env, ...opts.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
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
    if (opts.input !== undefined) child.stdin?.end(opts.input)
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

// ------------------------------------------------------- branch and PR base

export async function refExists(repo: string, ref: string): Promise<boolean> {
  return (await gitLine(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFailure: true })) !== ''
}

/** The remote PRs get pushed to: `origin` when there is one, else whatever exists. */
export async function remoteName(repo: string): Promise<string | null> {
  const remotes = (await gitText(repo, ['remote'], { allowFailure: true }))
    .split('\n')
    .map((r) => r.trim())
    .filter(Boolean)
  if (remotes.includes('origin')) return 'origin'
  return remotes[0] ?? null
}

/**
 * The branch a PR from here would target. The remote's own idea of its default
 * branch wins — `refs/remotes/origin/HEAD`, set by clone — and failing that,
 * the usual names.
 */
export async function defaultBaseBranch(repo: string, remote: string | null): Promise<string | null> {
  if (remote) {
    const sym = await gitLine(repo, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`], {
      allowFailure: true
    })
    if (sym.startsWith(`${remote}/`)) return sym.slice(remote.length + 1)
  }
  for (const name of ['main', 'master', 'trunk', 'develop']) {
    if (remote && (await refExists(repo, `refs/remotes/${remote}/${name}`))) return name
    if (await refExists(repo, `refs/heads/${name}`)) return name
  }
  return null
}

/**
 * The ref a base branch name stands for. The remote copy is preferred — that is
 * what GitHub diffs a PR against — so a stale local `main` doesn't drag commits
 * that already landed upstream into the review.
 */
export async function resolveBaseRef(repo: string, remote: string | null, base: string): Promise<string | null> {
  if (remote && (await refExists(repo, `refs/remotes/${remote}/${base}`))) return `refs/remotes/${remote}/${base}`
  if (await refExists(repo, `refs/heads/${base}`)) return `refs/heads/${base}`
  return null
}

/** Per repo and base branch: what the base resolved to, and the merge-base last computed for it. */
const forkPoints = new Map<string, { ref: string; head: string; baseSha: string; mergeBase: string }>()

async function headAndBase(repo: string, ref: string): Promise<[string, string] | null> {
  const [head, baseSha] = (await gitText(repo, ['rev-parse', 'HEAD', ref], { allowFailure: true })).trim().split('\n')
  return head && baseSha ? [head, baseSha] : null
}

/**
 * Where this branch forked from `base`. Diffing from here rather than from the
 * base's tip is what GitHub's "Files changed" does: work that landed on the base
 * since you branched doesn't show up as something you deleted.
 *
 * Asked for on every scan and again for every file opened, so the answer is
 * kept, and reused for as long as neither HEAD nor the base has moved — one
 * `rev-parse` to check, instead of resolving the base and walking history.
 */
export async function mergeBaseWith(repo: string, base: string): Promise<string> {
  const key = `${repo}\0${base}`
  const known = forkPoints.get(key)
  if (known) {
    const now = await headAndBase(repo, known.ref)
    if (now && now[0] === known.head && now[1] === known.baseSha) return known.mergeBase
    forkPoints.delete(key)
  }
  const ref = await resolveBaseRef(repo, await remoteName(repo), base)
  if (!ref) throw new Error(`There's no branch called ${base} to compare against.`)
  const now = await headAndBase(repo, ref)
  const mergeBase = now ? await gitLine(repo, ['merge-base', now[0], now[1]], { allowFailure: true }) : ''
  if (!now || !mergeBase) throw new Error(`This branch shares no history with ${base}.`)
  forkPoints.set(key, { ref, head: now[0], baseSha: now[1], mergeBase })
  return mergeBase
}

/** Branch names for the base picker: local ones plus the remote's, deduplicated. */
export async function listBranches(repo: string, remote: string | null): Promise<string[]> {
  const out = await gitText(
    repo,
    ['for-each-ref', '--format=%(refname)', 'refs/heads', ...(remote ? [`refs/remotes/${remote}`] : [])],
    { allowFailure: true }
  )
  const remotePrefix = remote ? `refs/remotes/${remote}/` : null
  const names = new Set<string>()
  for (const ref of out.split('\n')) {
    if (ref.startsWith('refs/heads/')) names.add(ref.slice('refs/heads/'.length))
    else if (remotePrefix && ref.startsWith(remotePrefix)) {
      const name = ref.slice(remotePrefix.length)
      if (name !== 'HEAD') names.add(name)
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b))
}

/** The diff's "before" side for scopes measured from the merge-base. */
async function forkPoint(repo: string, baseline: Baseline): Promise<string> {
  if (!baseline.base) throw new Error('No base branch to compare against.')
  return mergeBaseWith(repo, baseline.base)
}

export async function parentOf(repo: string, commit: string): Promise<string> {
  const parent = await gitLine(repo, ['rev-parse', '--verify', '--quiet', `${commit}^`], { allowFailure: true })
  return parent || EMPTY_TREE
}

/** The `git diff` revision arguments that produce a given baseline's change list. */
export async function diffRevArgs(repo: string, baseline: Baseline, currentTreeRef?: string): Promise<string[]> {
  switch (baseline.kind) {
    case 'branch':
      // Tree against tree, like snapshot below: untracked files are in the
      // current tree, so the agent's brand-new files are part of the PR.
      return [await forkPoint(repo, baseline), currentTreeRef!]
    case 'worktree':
      return ['HEAD']
    case 'snapshot':
      // Both sides are trees, so untracked files are covered on both ends and
      // a file that was untracked before and is unchanged now stays quiet.
      return [baseline.ref!, currentTreeRef!]
    case 'commit': {
      const before = baseline.cumulative
        ? await forkPoint(repo, baseline)
        : await parentOf(repo, baseline.ref!)
      return [before, baseline.ref!]
    }
    default:
      throw new Error(`unknown baseline ${(baseline as Baseline).kind}`)
  }
}

/** Paths a single commit touched — the dots in the file list in a cumulative view. */
export async function pathsChangedIn(repo: string, commit: string): Promise<Set<string>> {
  const out = await gitText(repo, [
    'diff',
    '--name-only',
    `--find-renames=${RENAME_SIMILARITY}`,
    '--no-color',
    '-z',
    await parentOf(repo, commit),
    commit
  ])
  return new Set(splitZ(out))
}

/**
 * Line ranges, on the commit's side, that one commit changed in one file.
 *
 * In a cumulative view the right-hand side is the file *as of that commit*, so
 * these line numbers land on exactly the lines shown there. Pure deletions have
 * no lines on that side and are skipped.
 */
export async function linesChangedIn(repo: string, commit: string, filePath: string): Promise<[number, number][]> {
  const out = await gitText(
    repo,
    ['diff', '-U0', '--no-color', '--no-ext-diff', await parentOf(repo, commit), commit, '--', filePath],
    { env: { GIT_LITERAL_PATHSPECS: '1' }, allowFailure: true }
  )
  const ranges: [number, number][] = []
  for (const m of out.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1])
    const count = m[2] === undefined ? 1 : Number(m[2])
    if (count > 0) ranges.push([start, start + count - 1])
  }
  return ranges
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
        const stat = await fs.lstat(path.join(repo, p))
        if (stat.isSymbolicLink()) {
          // git keeps a symlink as the path it points to: one line.
          additions = 1
        } else if (stat.size <= LINE_COUNT_LIMIT) {
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

/** Whether these bytes are valid UTF-8 — i.e. decoding and re-encoding them changes nothing. */
export function isUtf8(buf: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf)
    return true
  } catch {
    return false
  }
}

/** A plain file on disk — not a symlink, not missing. */
export async function isRegularFile(repo: string, filePath: string): Promise<boolean> {
  return (await fs.lstat(path.join(repo, filePath)).catch(() => null))?.isFile() ?? false
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
  const full = path.join(repo, filePath)
  try {
    // A symlink is shown the way git stores it — the path it points to — not
    // as whatever it points at, which may be anywhere on the machine.
    if ((await fs.lstat(full)).isSymbolicLink()) return Buffer.from(await fs.readlink(full))
    return await fs.readFile(full)
  } catch {
    return null
  }
}

export function recentCommits(repo: string, limit = 60): Promise<CommitInfo[]> {
  return logCommits(repo, [`-${limit}`])
}

/** Commits on HEAD that the merge-base doesn't have — the PR's commits — newest first. */
export function commitsSince(repo: string, mergeBase: string, limit = 200): Promise<CommitInfo[]> {
  return logCommits(repo, [`-${limit}`, `${mergeBase}..HEAD`])
}

async function logCommits(repo: string, range: string[]): Promise<CommitInfo[]> {
  const out = await gitText(
    repo,
    ['log', ...range, '--no-color', `--pretty=format:%H%x00%h%x00%s%x00%an%x00%ar%x00`],
    { allowFailure: true }
  )
  const fields = splitZ(out)
  const commits: CommitInfo[] = []
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

/** Whether `filePath` exists in a commit or tree. */
export async function existsAt(repo: string, rev: string, filePath: string): Promise<boolean> {
  try {
    await run(repo, ['cat-file', '-e', `${rev}:${filePath}`])
    return true
  } catch {
    return false
  }
}

// Paths go to git as data, never as patterns: a file literally named `*.ts`
// must not restore every TypeScript file in the repo.
const LITERAL = { GIT_LITERAL_PATHSPECS: '1' }

/**
 * Puts one file back the way it was at `rev`, on disk. With `alsoIndex` the
 * index follows too — right for HEAD, where a leftover staged copy would just
 * resurface the change; wrong for anything older, where it would stage a revert.
 */
export async function restoreFromRev(repo: string, rev: string, filePath: string, alsoIndex: boolean): Promise<void> {
  const args = ['restore', `--source=${rev}`, '--worktree', ...(alsoIndex ? ['--staged'] : []), '--', filePath]
  await gitText(repo, args, { env: LITERAL })
}

/** Drops a path from the index without touching the file — for a staged add being discarded. */
export async function forgetFromIndex(repo: string, filePath: string): Promise<void> {
  await gitText(repo, ['rm', '--cached', '--quiet', '--ignore-unmatch', '--', filePath], { env: LITERAL })
}
