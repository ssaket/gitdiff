/** Shared between main, preload and renderer. Keep it dependency-free. */

export type ChangeStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T'

/**
 * What the diff is showing — the "before" and "after" sides.
 *
 * Everything is framed around the pull request this branch will become: the
 * default is the whole PR, and the rest narrow it down to part of it.
 */
export type BaselineKind =
  | 'branch' // the whole PR: merge-base with the base branch → worktree, committed or not
  | 'worktree' // uncommitted: worktree (staged + unstaged + untracked) vs HEAD
  | 'snapshot' // since a round: worktree vs a tree captured with ⌘M
  | 'commit' // one commit — on its own, or on top of everything before it on the branch

export interface Baseline {
  kind: BaselineKind
  /** snapshot: the round's tree sha. commit: the commit sha. */
  ref?: string
  /** Human label: "round 2", or a commit's subject line. */
  label?: string
  /** branch, and commit when cumulative: the branch the PR targets, e.g. "main". */
  base?: string
  /**
   * commit only. false: the commit against its parent — just what it changed.
   * true: the commit against the merge-base — the PR as it stood once it landed.
   */
  cumulative?: boolean
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
  /** Cumulative commit view only: the commit itself touched this file. */
  inCommit?: boolean
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
  | {
      kind: 'text'
      original: string
      modified: string
      originalPath: string
      /**
       * The right side is a regular file on disk whose bytes are valid UTF-8,
       * so it can be edited and saved back without changing anything else.
       * Not a commit, not a symlink, not Latin-1.
       */
      editable: boolean
    }
  | { kind: 'binary'; reason: string }
  | { kind: 'image'; originalDataUrl: string | null; modifiedDataUrl: string | null }
  | { kind: 'too-large'; bytes: number }

export interface FileDiff {
  path: string
  status: ChangeStatus
  payload: DiffPayload
  /**
   * Cumulative commit view only: 1-based, inclusive line ranges on the modified
   * side that the commit itself changed, so they stand out from the context
   * that earlier commits contributed.
   */
  commitLines?: [number, number][]
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

/** Where this branch stands relative to the branch its PR will target. */
export interface BranchInfo {
  /** The branch PRs target, e.g. "main". Null when nothing sensible exists to compare against. */
  base: string | null
  /** What `base` resolved to — "origin/main", or just "main" when there's no remote copy. */
  baseRef: string | null
  mergeBase: string | null
  /** The remote PRs are pushed to; null for a repo with no remotes. */
  remote: string | null
  /** Commits on this branch that aren't on the base, newest first. */
  commits: CommitInfo[]
  /** Candidates for the base picker. */
  branches: string[]
  /** HEAD is on the base branch, or detached, so opening a PR needs a new branch. */
  needsNewBranch: boolean
}

export interface PullRequestInfo {
  number: number
  url: string
  title: string
  body: string
  isDraft: boolean
  /** How many reviews it has had. Force-pushing after the first one rewrites what reviewers saw. */
  reviewCount: number
  /** The commit GitHub has at the head — the lease for a force-push. */
  headSha: string
}

export interface PrLookup {
  /** The open PR for the current branch, if there is one. */
  pr: PullRequestInfo | null
  /** Why GitHub couldn't be asked — gh missing, not logged in, not a GitHub remote. */
  ghError: string | null
}

/**
 * squash: one commit on top of the merge-base, holding everything. Keeps the
 *   PR to a single clean commit; updating it is a force-push.
 * stack: the branch's commits as they are, plus one commit for whatever is
 *   still uncommitted. Updating it is a plain push.
 */
export type PublishStrategy = 'squash' | 'stack'

export interface PublishRequest {
  root: string
  /** The branch the PR targets. */
  base: string
  /** The branch the PR comes from — created if HEAD isn't already on it. */
  branch: string
  strategy: PublishStrategy
  /** Message for the commit that gets created. */
  message: string
  /** Only used when no PR exists yet. */
  title: string
  body: string
  draft: boolean
  /** Paths to leave out of the PR, as they are on the base. Renames list both sides. */
  exclude: string[]
  /** The remote head the caller last saw, so a force-push can't clobber someone else's push. */
  expectedHead?: string
}

export interface PublishResult {
  pr: PullRequestInfo | null
  url: string | null
  branch: string
  sha: string
  created: boolean
  /** The push worked but something after it didn't — the PR is fine, the local branch may not be. */
  warning: string | null
}

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
