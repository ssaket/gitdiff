import { useEffect, useRef, useState } from 'react'
import type { Baseline, BaselineKind, CommitInfo, RepoInfo } from '@shared/types'

export type Tab = 'review' | 'flows'

interface Props {
  /** Null when the app was opened straight into a diagram, with no repo. */
  repo: RepoInfo | null
  tab: Tab
  onTabChange: (tab: Tab) => void
  flowCount: number
  baseline: Baseline
  onBaselineChange: (baseline: Baseline) => void
  onMarkSnapshot: () => void
  onPickRepo: () => void
  onRefresh: () => void
  autoRefresh: boolean
  onAutoRefreshChange: (value: boolean) => void
  sideBySide: boolean
  onSideBySideChange: (value: boolean) => void
  collapseUnchanged: boolean
  onCollapseChange: (value: boolean) => void
  ignoreWhitespace: boolean
  onIgnoreWhitespaceChange: (value: boolean) => void
  busy: boolean
}

const MODES: { kind: BaselineKind; label: string; hint: string }[] = [
  { kind: 'worktree', label: 'Uncommitted', hint: 'Everything not yet committed, vs HEAD' },
  { kind: 'staged', label: 'Staged', hint: 'Index vs HEAD' },
  { kind: 'snapshot', label: 'Since mark', hint: 'Everything that changed since you marked' },
  { kind: 'commit', label: 'Commit', hint: 'A single commit vs its parent' }
]

export function Toolbar(props: Props): JSX.Element {
  const { repo, baseline, tab } = props
  const [commitsOpen, setCommitsOpen] = useState(false)
  const [commits, setCommits] = useState<CommitInfo[] | null>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!commitsOpen || !repo) return
    let cancelled = false
    void window.gitdiff.listCommits(repo.root).then((c) => {
      if (!cancelled) setCommits(c)
    })
    const onDown = (e: MouseEvent): void => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) setCommitsOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => {
      cancelled = true
      document.removeEventListener('mousedown', onDown)
    }
    // repo?.root, not repo: a refresh hands back a new object each time, and
    // depending on it would refetch the list under an open popover.
  }, [commitsOpen, repo?.root])

  const selectMode = (kind: BaselineKind): void => {
    if (kind === 'commit') {
      setCommitsOpen(true)
      return
    }
    if (kind === 'snapshot' && !baseline.ref) {
      props.onMarkSnapshot()
      return
    }
    props.onBaselineChange(
      kind === 'snapshot' ? { kind, ref: baseline.ref, label: baseline.label } : { kind }
    )
  }

  return (
    <header className="toolbar">
      <div className="toolbar-drag" />

      <div className="toolbar-repo">
        <button className="repo-button" onClick={props.onPickRepo} title="Open another repository (⌘O)">
          <span className="repo-name">{repo ? repo.name : 'Open a repo'}</span>
          <span className="repo-branch">
            {repo ? repo.branch : 'no repository'}
            {repo?.head && <span className="repo-sha">{repo.head}</span>}
          </span>
        </button>
      </div>

      <div className="segmented" role="tablist" aria-label="View">
        <button
          role="tab"
          aria-selected={tab === 'review'}
          className={tab === 'review' ? 'is-active' : ''}
          title="Review changed files (⌘1)"
          disabled={!repo}
          onClick={() => props.onTabChange('review')}
        >
          Review
        </button>
        <button
          role="tab"
          aria-selected={tab === 'flows'}
          className={tab === 'flows' ? 'is-active' : ''}
          title="Diagrams your agent sent over (⌘2)"
          onClick={() => props.onTabChange('flows')}
        >
          Flows
          {props.flowCount > 0 && <span className="tab-count">{props.flowCount}</span>}
        </button>
      </div>

      {tab === 'review' && repo && (
        <>
      <div className="segmented" role="tablist" aria-label="Diff baseline">
        {MODES.map((m) => (
          <button
            key={m.kind}
            role="tab"
            aria-selected={baseline.kind === m.kind}
            className={baseline.kind === m.kind ? 'is-active' : ''}
            title={m.hint}
            onClick={() => selectMode(m.kind)}
          >
            {m.kind === 'commit' && baseline.kind === 'commit' && baseline.label
              ? baseline.label
              : m.label}
          </button>
        ))}
        {commitsOpen && (
          <div className="popover" ref={popoverRef}>
            <div className="popover-title">Pick a commit</div>
            <ul>
              {commits === null && <li className="popover-loading">Loading…</li>}
              {commits?.length === 0 && <li className="popover-loading">No commits yet.</li>}
              {commits?.map((c) => (
                <li key={c.sha}>
                  <button
                    onClick={() => {
                      props.onBaselineChange({ kind: 'commit', ref: c.sha, label: c.shortSha })
                      setCommitsOpen(false)
                    }}
                  >
                    <code>{c.shortSha}</code>
                    <span className="commit-subject">{c.subject}</span>
                    <span className="commit-meta">
                      {c.author} · {c.relativeDate}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <button
        className="mark-button"
        onClick={props.onMarkSnapshot}
        title="Snapshot the worktree now, then review everything the agent changes from here (⌘M)"
      >
        <span className="mark-dot" />
        {baseline.kind === 'snapshot' && baseline.label ? `Re-mark (${baseline.label})` : 'Mark'}
      </button>
        </>
      )}

      <div className="toolbar-spacer" />

      {tab === 'review' && repo && (
      <div className="toolbar-toggles">
        <Toggle
          active={props.sideBySide}
          onClick={() => props.onSideBySideChange(!props.sideBySide)}
          title="Side-by-side / inline (⌘\)"
        >
          {props.sideBySide ? '◫' : '▤'}
        </Toggle>
        <Toggle
          active={props.collapseUnchanged}
          onClick={() => props.onCollapseChange(!props.collapseUnchanged)}
          title="Collapse unchanged regions"
        >
          ⇕
        </Toggle>
        <Toggle
          active={props.ignoreWhitespace}
          onClick={() => props.onIgnoreWhitespaceChange(!props.ignoreWhitespace)}
          title="Ignore whitespace-only changes"
        >
          ␣
        </Toggle>
        <Toggle
          active={props.autoRefresh}
          onClick={() => props.onAutoRefreshChange(!props.autoRefresh)}
          title="Auto-refresh when files change on disk"
        >
          ◉
        </Toggle>
        <Toggle active={false} onClick={props.onRefresh} title="Refresh now (⌘R)">
          <span className={props.busy ? 'spinning' : undefined}>↻</span>
        </Toggle>
      </div>
      )}
    </header>
  )
}

function Toggle({
  active,
  onClick,
  title,
  children
}: {
  active: boolean
  onClick: () => void
  title: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <button className={`toggle${active ? ' is-active' : ''}`} onClick={onClick} title={title}>
      {children}
    </button>
  )
}
