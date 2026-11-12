import { execFile } from 'node:child_process'
import type {
  BranchInfo,
  PrLookup,
  PublishRequest,
  PublishResult,
  PullRequestInfo,
  RepoInfo
} from '@shared/types'
import {
  commitsSince,
  defaultBaseBranch,
  gitLine,
  gitText,
  listBranches,
  mergeBaseWith,
  refExists,
  remoteName,
  resolveBaseRef
} from './git'
import { markSnapshot, withScratchIndex } from './snapshot'
import { setPrExcludes } from './store'

/**
 * Turning the reviewed working tree into a pull request.
 *
 * The rule throughout is that nothing in the user's repository moves until the
 * push has succeeded. The PR's commit is built off to the side — a tree from a
 * scratch index, a commit from `commit-tree` — and pushed by sha. Only then are
 * the local branch and HEAD brought along, and even that never rewrites a file
 * on disk: the working tree already holds exactly what was published.
 */

// ------------------------------------------------------------------- PATH

/**
 * A Mac app launched from Finder or the Dock inherits launchd's PATH
 * (/usr/bin:/bin:/usr/sbin:/sbin), not your shell's. git lives in /usr/bin and
 * is fine; gh, installed by Homebrew into /opt/homebrew/bin, is not. So ask the
 * login shell once what PATH it would give a terminal, and adopt it.
 */
let shellPathReady: Promise<void> | null = null

export function ensureShellPath(): Promise<void> {
  if (!shellPathReady) shellPathReady = loadShellPath()
  return shellPathReady
}

const PATH_MARK = '__GITDIFF_PATH__'

async function loadShellPath(): Promise<void> {
  if (process.platform === 'win32') return
  const shell = process.env.SHELL || '/bin/zsh'
  const fromShell = await new Promise<string>((resolve) => {
    // -i as well as -l: plenty of people set PATH in .zshrc, which only an
    // interactive shell reads. The markers fence the answer off from anything
    // the rc files print on the way, and the timeout covers an rc file that
    // waits for input.
    execFile(
      shell,
      ['-ilc', `printf '${PATH_MARK}%s${PATH_MARK}' "$PATH"`],
      { timeout: 5000, encoding: 'utf8' },
      (_err, stdout) => {
        const m = new RegExp(`${PATH_MARK}(.*)${PATH_MARK}`).exec(stdout ?? '')
        resolve(m ? m[1] : '')
      }
    )
  })
  const dirs = [
    ...fromShell.split(':'),
    ...(process.env.PATH ?? '').split(':'),
    // In case the shell timed out or said nothing useful.
    '/opt/homebrew/bin',
    '/usr/local/bin'
  ]
  process.env.PATH = [...new Set(dirs.filter(Boolean))].join(':')
}

// --------------------------------------------------------------------- gh

const GH_MISSING = 'GitHub CLI (gh) not found. Install it with `brew install gh`, then run `gh auth login`.'

async function gh(cwd: string, args: string[], input?: string): Promise<string> {
  await ensureShellPath()
  return new Promise((resolve, reject) => {
    const child = execFile(
      'gh',
      args,
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        timeout: 60_000,
        env: {
          ...process.env,
          // No terminal to answer a question on: fail rather than hang.
          GH_PROMPT_DISABLED: '1',
          GH_NO_UPDATE_NOTIFIER: '1',
          NO_COLOR: '1',
          GIT_TERMINAL_PROMPT: '0'
        }
      },
      (err, stdout, stderr) => {
        if (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') return reject(new Error(GH_MISSING))
          return reject(new Error(stderr.trim() || err.message))
        }
        resolve(stdout)
      }
    )
    if (input !== undefined) child.stdin?.end(input)
  })
}

const PR_FIELDS = 'number,url,title,body,state,isDraft,reviews,headRefOid'

interface RawPr {
  number: number
  url: string
  title: string
  body?: string
  state: string
  isDraft?: boolean
  reviews?: unknown[]
  headRefOid?: string
}

function toPr(raw: RawPr): PullRequestInfo {
  return {
    number: raw.number,
    url: raw.url,
    title: raw.title,
    body: raw.body ?? '',
    isDraft: !!raw.isDraft,
    reviewCount: Array.isArray(raw.reviews) ? raw.reviews.length : 0,
    headSha: raw.headRefOid ?? ''
  }
}

/** resolveRepo's stand-ins for "not on a branch". */
function isRealBranch(branch: string): boolean {
  return branch !== '' && branch !== '(detached)' && branch !== '(no branch)'
}

/** The open PR whose head is `branch`. A merged or closed one counts as none. */
export async function lookupPr(root: string, branch: string): Promise<PrLookup> {
  if (!isRealBranch(branch)) return { pr: null, ghError: null }
  try {
    const raw = JSON.parse(await gh(root, ['pr', 'view', branch, '--json', PR_FIELDS])) as RawPr
    return { pr: raw.state === 'OPEN' ? toPr(raw) : null, ghError: null }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/no (open )?pull requests? found/i.test(msg)) return { pr: null, ghError: null }
    return { pr: null, ghError: msg }
  }
}

// ------------------------------------------------------------- branch info

function shortRef(ref: string): string {
  return ref.replace(/^refs\/(remotes|heads)\//, '')
}

/**
 * Everything the toolbar needs to frame the review as a PR: what it targets,
 * where the branch forked, and the commits so far. Purely local — no network —
 * so it is cheap enough to run on every refresh.
 */
export async function branchInfo(root: string, repo: RepoInfo, requestedBase?: string): Promise<BranchInfo> {
  const remote = await remoteName(root)
  const branches = await listBranches(root, remote)
  const none: BranchInfo = {
    base: null,
    baseRef: null,
    mergeBase: null,
    remote,
    commits: [],
    branches,
    needsNewBranch: true
  }
  if (!repo.hasCommits) return none

  // A base picked earlier may have been deleted since; fall back to the default.
  let base = requestedBase ?? null
  let baseRef = base ? await resolveBaseRef(root, remote, base) : null
  if (!baseRef) {
    base = await defaultBaseBranch(root, remote)
    baseRef = base ? await resolveBaseRef(root, remote, base) : null
  }
  if (!base || !baseRef) return none

  const mergeBase = await mergeBaseWith(root, base).catch(() => '')
  if (!mergeBase) return { ...none, base, baseRef: shortRef(baseRef) }

  return {
    base,
    baseRef: shortRef(baseRef),
    mergeBase,
    remote,
    commits: await commitsSince(root, mergeBase),
    branches,
    needsNewBranch: !isRealBranch(repo.branch) || repo.branch === base
  }
}

// ----------------------------------------------------------------- publish

const REFLOG_MESSAGE = 'gitdiff: publish pull request'

/**
 * The tree the PR will hold: the working tree as it stands, untracked files
 * included, with excluded paths put back the way they are on the merge-base.
 *
 * The merge-base rather than HEAD, so that excluding a file the agent already
 * committed takes it out of the PR too, not just its uncommitted edits. And a
 * fresh snapshot rather than the live-refresh index, so a refresh racing the
 * publish can't trip over the same index lock.
 */
async function prTree(root: string, mergeBase: string, exclude: string[]): Promise<string> {
  const tree = await markSnapshot(root)
  if (exclude.length === 0) return tree
  return withScratchIndex(root, 'pr', async (env) => {
    await gitText(root, ['read-tree', tree], { env })
    await gitText(root, ['reset', '--quiet', mergeBase, '--', ...exclude], {
      env: { ...env, GIT_LITERAL_PATHSPECS: '1' }
    })
    return gitLine(root, ['write-tree'], { env })
  })
}

/**
 * Whether publishing would change nothing. A squash always mints a new sha —
 * commit-tree stamps the time — so compare content instead: same tree, and the
 * PR is already one commit on the merge-base.
 */
async function alreadyPublished(
  root: string,
  prHead: string,
  next: { tree: string; sha: string; mergeBase: string; strategy: PublishRequest['strategy'] }
): Promise<boolean> {
  if (next.strategy === 'stack') return next.sha === prHead
  // The PR head may only exist on GitHub; then we can't tell, and pushing is harmless.
  const [headTree, headParent] = await Promise.all([
    gitLine(root, ['rev-parse', '--verify', '--quiet', `${prHead}^{tree}`], { allowFailure: true }),
    gitLine(root, ['rev-parse', '--verify', '--quiet', `${prHead}^`], { allowFailure: true })
  ])
  return headTree === next.tree && headParent === next.mergeBase
}

function explainPushError(e: unknown, branch: string): Error {
  const msg = e instanceof Error ? e.message : String(e)
  if (/stale info/.test(msg)) {
    return new Error(
      `${branch} on the remote has commits this app hasn't seen — pushed from somewhere else, or by someone else. ` +
        `Fetch and look at them before publishing over them.`
    )
  }
  if (/non-fast-forward|fetch first/.test(msg)) {
    return new Error(
      `${branch} on the remote has moved on since your last push. Pull it in first, or choose to amend and force-push.`
    )
  }
  return new Error(`Push failed: ${msg}`)
}

export async function publish(req: PublishRequest, repo: RepoInfo): Promise<PublishResult> {
  const root = req.root
  const branch = req.branch.trim()
  const message = req.message.trim()

  // ---- check everything that can be checked before anything leaves the machine

  if (!message) throw new Error('The commit needs a message.')
  const remote = await remoteName(root)
  if (!remote) throw new Error('This repository has no remote to push to.')
  const baseRef = await resolveBaseRef(root, remote, req.base)
  if (!baseRef) throw new Error(`There's no branch called ${req.base} to open a PR against.`)
  try {
    await gitLine(root, ['check-ref-format', '--branch', branch])
  } catch {
    throw new Error(`"${branch}" isn't a valid branch name.`)
  }
  if (branch === req.base) {
    throw new Error(`The PR can't come from ${req.base} itself. Pick a name for a new branch.`)
  }

  const onBranch = repo.branch === branch
  if (!onBranch && (await refExists(root, `refs/heads/${branch}`))) {
    throw new Error(`A local branch called ${branch} already exists. Switch to it first, or pick another name.`)
  }

  const head = await gitLine(root, ['rev-parse', 'HEAD'])
  const mergeBase = await gitLine(root, ['merge-base', 'HEAD', baseRef])

  // Asking GitHub first doubles as the check that gh works at all — far better
  // to find out it's missing before the push than after it.
  const lookup = await lookupPr(root, branch)
  if (lookup.ghError) throw new Error(lookup.ghError)
  let pr = lookup.pr
  if (!pr && !req.title.trim()) throw new Error('The pull request needs a title.')

  const tracking = await gitLine(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${branch}`], {
    allowFailure: true
  })
  // A new branch must be new on the remote too. Otherwise "Create PR" would
  // quietly take over someone's branch — and with squash, force-push over it.
  // A remote branch this clone hasn't fetched is caught by the push instead:
  // the lease expects no branch there, and a plain push won't fast-forward.
  if (!onBranch && pr) {
    throw new Error(
      `${branch} already has an open PR (#${pr.number}). Pick another name, or check that branch out to update it.`
    )
  }
  if (!onBranch && tracking) {
    throw new Error(`A branch called ${branch} already exists on ${remote}. Pick another name.`)
  }

  // ---- build the commit off to the side

  const tree = await prTree(root, mergeBase, req.exclude)
  const parent = req.strategy === 'squash' ? mergeBase : head
  const parentTree = await gitLine(root, ['rev-parse', `${parent}^{tree}`])
  const sha =
    tree === parentTree
      ? parent // stacking with nothing uncommitted: publish the commits as they are
      : await gitLine(root, ['commit-tree', tree, '-p', parent, '-F', '-'], { input: `${message}\n` })
  if (sha === mergeBase) {
    throw new Error('Nothing to publish: there are no changes, or every one of them is excluded.')
  }
  if (pr?.headSha && (await alreadyPublished(root, pr.headSha, { tree, sha, mergeBase, strategy: req.strategy }))) {
    throw new Error(`PR #${pr.number} already has exactly these changes.`)
  }

  // ---- push it

  const pushArgs = ['push']
  if (req.strategy === 'squash') {
    // Squashing rewrites the branch, so this is a force-push — but a leased
    // one: it only lands if the remote is still at the commit last seen here,
    // never over someone else's push. Empty means "must not exist yet".
    const expected = req.expectedHead ?? pr?.headSha ?? tracking
    pushArgs.push(`--force-with-lease=refs/heads/${branch}:${expected}`)
  }
  pushArgs.push(remote, `${sha}:refs/heads/${branch}`)
  try {
    await gitText(root, pushArgs, { timeoutMs: 120_000 })
  } catch (e) {
    throw explainPushError(e, branch)
  }
  // The PR's head is now what was just pushed. The caller keeps this as the
  // lease for its next force-push, so it must not be the pre-push head.
  if (pr) pr = { ...pr, headSha: sha }

  // ---- bring the local branch along. The PR is safe from here on, so a
  // failure only becomes a warning.

  const warnings: string[] = []
  try {
    if (onBranch) {
      // The old value guards against the agent committing mid-publish: if HEAD
      // moved, leave the branch alone rather than drop that commit.
      await gitText(root, ['update-ref', '-m', REFLOG_MESSAGE, `refs/heads/${branch}`, sha, head])
    } else {
      // HEAD is on the base branch, or detached. The files on disk already are
      // the PR (plus whatever was excluded), so instead of checking anything
      // out: create the branch at the new commit and repoint HEAD at it.
      await gitText(root, ['update-ref', '-m', REFLOG_MESSAGE, `refs/heads/${branch}`, sha, ''])
      await gitText(root, ['symbolic-ref', '-m', REFLOG_MESSAGE, 'HEAD', `refs/heads/${branch}`])
      if (isRealBranch(repo.branch) && head !== mergeBase) {
        warnings.push(
          `${repo.branch} still has the commits this PR was made from. Reset it to ${shortRef(baseRef)} once you no longer need them.`
        )
      }
    }
    // The index still describes the old HEAD. Point it at the new one; files
    // on disk are not touched.
    await gitText(root, ['reset', '--quiet', '--mixed'])
    await gitText(root, ['config', `branch.${branch}.remote`, remote])
    await gitText(root, ['config', `branch.${branch}.merge`, `refs/heads/${branch}`])
  } catch (e) {
    warnings.unshift(`Pushed, but the local branch couldn't be updated: ${e instanceof Error ? e.message : String(e)}`)
  }

  // ---- open the PR, or let the existing one pick up the push

  let created = false
  let url = pr?.url ?? null
  if (!pr) {
    const args = ['pr', 'create', '--base', req.base, '--head', branch, '--title', req.title.trim(), '--body-file', '-']
    if (req.draft) args.push('--draft')
    let out: string
    try {
      out = await gh(root, args, req.body)
    } catch (e) {
      throw new Error(
        `Pushed ${branch}, but GitHub didn't open the PR: ${e instanceof Error ? e.message : String(e)}`
      )
    }
    created = true
    url =
      out
        .split('\n')
        .map((l) => l.trim())
        .reverse()
        .find((l) => /^https?:\/\//.test(l)) ?? null
    pr = (await lookupPr(root, branch)).pr
    if (pr) pr = { ...pr, headSha: sha }
    url = pr?.url ?? url
  }

  await setPrExcludes(root, req.exclude)
  return { pr, url, branch, sha, created, warning: warnings.length ? warnings.join(' ') : null }
}
