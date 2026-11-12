import { useEffect, useMemo, useState } from 'react'
import type {
  BranchInfo,
  CommitInfo,
  FileChange,
  PublishResult,
  PublishStrategy,
  PullRequestInfo,
  RepoInfo
} from '@shared/types'
import { errorText } from '../util'

interface Props {
  repo: RepoInfo
  branch: BranchInfo
  base: string
  /** The open PR for this branch — the sheet then updates it instead of creating one. */
  pr: PullRequestInfo | null
  /** Why GitHub couldn't be reached, if it couldn't — shown up front rather than after a push. */
  ghError: string | null
  /** Files edited in the diff view and not saved. A PR is built from disk, so these would be left out. */
  unsavedCount: number
  onSaveAll: () => Promise<boolean>
  onClose: () => void
  onPublished: (result: PublishResult) => void
}

/** A single commit already has a good title; several have no one obvious summary. */
function defaultTitle(commits: CommitInfo[]): string {
  return commits.length === 1 ? commits[0].subject : ''
}

function defaultBody(commits: CommitInfo[]): string {
  if (commits.length < 2) return ''
  return [...commits]
    .reverse()
    .map((c) => `- ${c.subject}`)
    .join('\n')
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 48)
    .replace(/-+$/, '')
}

const STATUS_LETTER = (f: FileChange): string => (f.untracked ? 'U' : f.status)

export function PrSheet({
  repo,
  branch,
  base,
  pr,
  ghError,
  unsavedCount,
  onSaveAll,
  onClose,
  onPublished
}: Props): JSX.Element {
  const commits = branch.commits
  const updating = pr !== null

  const [files, setFiles] = useState<FileChange[] | null>(null)
  const [included, setIncluded] = useState<Set<string>>(new Set())
  const [title, setTitle] = useState(() => defaultTitle(commits))
  const [body, setBody] = useState(() => defaultBody(commits))
  const [branchName, setBranchName] = useState(() =>
    branch.needsNewBranch ? slugify(defaultTitle(commits)) : repo.branch
  )
  const [branchEdited, setBranchEdited] = useState(false)
  // Once someone has reviewed, rewriting what they saw is rude; until then a
  // single clean commit is the whole point.
  const [strategy, setStrategy] = useState<PublishStrategy>(() =>
    pr && pr.reviewCount > 0 ? 'stack' : 'squash'
  )
  const [message, setMessage] = useState('')
  const [draft, setDraft] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(ghError)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      window.gitdiff.listChanges(repo.root, { kind: 'branch', base }),
      window.gitdiff.prExcludes(repo.root)
    ])
      .then(([changes, excludes]) => {
        if (cancelled) return
        // Files left out last time stay left out unless you tick them back in.
        const skip = new Set(excludes)
        setFiles(changes.files)
        setIncluded(new Set(changes.files.filter((f) => !skip.has(f.path)).map((f) => f.path)))
      })
      .catch((e) => {
        if (!cancelled) setError(errorText(e))
      })
    return () => {
      cancelled = true
    }
  }, [repo.root, base])

  const changeTitle = (value: string): void => {
    setTitle(value)
    if (branch.needsNewBranch && !branchEdited) setBranchName(slugify(value))
  }

  const toggle = (path: string): void =>
    setIncluded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  const allIncluded = files !== null && files.length > 0 && included.size === files.length

  /** What the created commit says. Amending keeps the PR's own words. */
  const commitMessage = useMemo(() => {
    if (updating && strategy === 'stack') return message
    const head = updating ? pr.title : title
    const text = (updating ? pr.body : body).trim()
    return text ? `${head.trim()}\n\n${text}` : head.trim()
  }, [updating, strategy, message, pr, title, body])

  const missing = unsavedCount
    ? `${unsavedCount} file${unsavedCount === 1 ? ' has' : 's have'} unsaved edits — save first.`
    : !files
    ? 'Loading files…'
    : included.size === 0
      ? 'Tick at least one file.'
      : !updating && !title.trim()
        ? 'Give the PR a title.'
        : !updating && !branchName.trim()
          ? 'Name the branch.'
          : updating && strategy === 'stack' && !message.trim()
            ? 'Write a commit message.'
            : null

  const submit = async (): Promise<void> => {
    if (missing || busy || !files) return
    const exclude = files
      .filter((f) => !included.has(f.path))
      .flatMap((f) => (f.oldPath ? [f.path, f.oldPath] : [f.path]))
    setBusy(true)
    setError(null)
    try {
      const result = await window.gitdiff.publishPr({
        root: repo.root,
        base,
        branch: updating ? repo.branch : branchName.trim(),
        strategy,
        message: commitMessage,
        title,
        body,
        draft,
        exclude,
        expectedHead: pr?.headSha || undefined
      })
      onPublished(result)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) {
        e.stopPropagation()
        onClose()
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        void submit()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  const n = commits.length

  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={updating ? 'Update PR' : 'Create PR'}>
        <header className="sheet-header">
          <h2>{updating ? `Update PR #${pr.number}` : 'Create pull request'}</h2>
          <span className="sheet-route">
            <code>{updating ? repo.branch : branchName || '…'}</code> → <code>{base}</code>
          </span>
        </header>

        <div className="sheet-body">
          {updating ? (
            <p className="sheet-pr-title">
              <button className="link" onClick={() => window.open(pr.url)}>
                {pr.title} ↗
              </button>
              {pr.isDraft && <span className="sheet-tag">draft</span>}
              {pr.reviewCount > 0 && (
                <span className="sheet-tag">
                  {pr.reviewCount} review{pr.reviewCount === 1 ? '' : 's'}
                </span>
              )}
            </p>
          ) : (
            <>
              <label className="field">
                <span>Title</span>
                <input autoFocus value={title} onChange={(e) => changeTitle(e.target.value)} spellCheck />
              </label>
              <label className="field">
                <span>Description</span>
                <textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)} spellCheck />
              </label>
              <label className="field">
                <span>Branch</span>
                {branch.needsNewBranch ? (
                  <input
                    className="mono"
                    value={branchName}
                    onChange={(e) => {
                      setBranchName(e.target.value)
                      setBranchEdited(true)
                    }}
                    spellCheck={false}
                    placeholder="new-branch-name"
                  />
                ) : (
                  <code className="field-static">{repo.branch}</code>
                )}
              </label>
            </>
          )}

          {(updating || n > 0) && (
            <fieldset className="field choices">
              <span>Commits</span>
              <label>
                <input type="radio" checked={strategy === 'squash'} onChange={() => setStrategy('squash')} />
                {updating ? 'Amend and force-push — the PR stays one clean commit' : 'Squash into one commit'}
              </label>
              <label>
                <input type="radio" checked={strategy === 'stack'} onChange={() => setStrategy('stack')} />
                {updating
                  ? 'Push as a new commit'
                  : `Keep the ${n} commit${n === 1 ? '' : 's'} as they are, plus one for anything uncommitted`}
              </label>
              {updating && strategy === 'squash' && pr.reviewCount > 0 && (
                <p className="sheet-warn">
                  This PR has been reviewed. Force-pushing rewrites the history reviewers already looked at.
                </p>
              )}
            </fieldset>
          )}

          {updating && strategy === 'stack' && (
            <label className="field">
              <span>Commit message</span>
              <textarea
                autoFocus
                rows={3}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="What changed in this round"
                spellCheck
              />
            </label>
          )}

          <div className="field">
            <span className="sheet-files-head">
              Files
              {files && (
                <>
                  <span className="sheet-files-count">
                    {included.size} of {files.length} in the PR
                  </span>
                  <button
                    className="link"
                    onClick={() => setIncluded(allIncluded ? new Set() : new Set(files.map((f) => f.path)))}
                  >
                    {allIncluded ? 'Select none' : 'Select all'}
                  </button>
                </>
              )}
            </span>
            <ul className="sheet-files">
              {files === null && <li className="sheet-files-empty">Loading…</li>}
              {files?.length === 0 && <li className="sheet-files-empty">No changes against {base}.</li>}
              {files?.map((f) => (
                <li key={f.path}>
                  <label title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
                    <input type="checkbox" checked={included.has(f.path)} onChange={() => toggle(f.path)} />
                    <span className={`status status-${f.status}`}>{STATUS_LETTER(f)}</span>
                    <span className="sheet-file-path">{f.path}</span>
                    <span className="counts">
                      {f.additions > 0 && <span className="count-add">+{f.additions}</span>}
                      {f.deletions > 0 && <span className="count-del">−{f.deletions}</span>}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            {files && included.size < files.length && (
              <p className="sheet-note">Unticked files stay on disk, untouched — they just aren't in the PR.</p>
            )}
          </div>

          {!updating && (
            <label className="sheet-check">
              <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
              Open as a draft
            </label>
          )}
        </div>

        <footer className="sheet-footer">
          <span className={error ? 'sheet-error' : 'sheet-hint'}>{error ?? missing ?? '⌘↩ to submit'}</span>
          {unsavedCount > 0 && (
            <button className="sheet-cancel" disabled={busy} onClick={() => void onSaveAll()}>
              Save all
            </button>
          )}
          <button className="sheet-cancel" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="primary" onClick={() => void submit()} disabled={!!missing || busy}>
            {busy ? 'Pushing…' : updating ? 'Update PR' : 'Create PR'}
          </button>
        </footer>
      </div>
    </div>
  )
}
