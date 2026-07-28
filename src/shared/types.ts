/** Shared between main, preload and renderer. Keep it dependency-free. */

export type ChangeStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T'

/** How the "before" side of the diff is chosen. */
export type BaselineKind =
  | 'worktree' // everything not yet committed (staged + unstaged + untracked) vs HEAD
  | 'staged' // index vs HEAD
  | 'snapshot' // worktree vs a marked point in time
  | 'commit' // a single commit vs its parent

export interface Baseline {
  kind: BaselineKind
  /** snapshot: tree sha written by markSnapshot. commit: the commit sha. */
  ref?: string
  /** Human label for the toolbar, e.g. "marked 14:02" or "a1b2c3d fix parser". */
  label?: string
}

export interface FileChange {
  /** Path relative to repo root, as git reports it. */
  path: string
  /** Set for renames/copies. */
  oldPath?: string
  status: ChangeStatus
  additions: number
  deletions: number
  binary: boolean
  /** Not known to git at all — only appears in worktree mode. */
  untracked: boolean
}

export interface RepoInfo {
  root: string
  name: string
  branch: string
  head: string
  /** false for a freshly `git init`ed repo with no commits yet. */
  hasCommits: boolean
}

export interface CommitInfo {
  sha: string
  shortSha: string
  subject: string
  author: string
  relativeDate: string
}

export type DiffPayload =
  | { kind: 'text'; original: string; modified: string; originalPath: string }
  | { kind: 'binary'; reason: string }
  | { kind: 'image'; originalDataUrl: string | null; modifiedDataUrl: string | null }
  | { kind: 'too-large'; bytes: number }

export interface FileDiff {
  path: string
  status: ChangeStatus
  payload: DiffPayload
}

/** A repo the user asked for from outside the UI — the CLI, or a Finder drop. */
export interface OpenRepoRequest {
  repo: RepoInfo | null
  error: string | null
}

/**
 * A mermaid diagram held by the app. Usually written by a coding agent through
 * `gitdiff flow`, but also editable in place — the source is the document, and
 * the rendered picture is derived from it.
 */
export interface FlowDoc {
  id: string
  title: string
  /** Mermaid source text. */
  source: string
  /** Where it came from — a file path, or null when typed into the app. */
  origin: string | null
  createdAt: number
  updatedAt: number
}

/** Diagrams handed to the app from outside the UI — i.e. the CLI. */
export interface OpenFlowRequest {
  flows: FlowDoc[]
  error: string | null
}

export interface ChangeSet {
  files: FileChange[]
  repo: RepoInfo
  /** Wall-clock of the scan, used by the renderer to dedupe stale responses. */
  scannedAt: number
}

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
