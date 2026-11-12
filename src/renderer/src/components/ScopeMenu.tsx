import { useEffect, useMemo, useRef, useState } from 'react'
import type { Baseline, BranchInfo, CommitInfo } from '@shared/types'
import type { ReviewRound } from '@shared/review'
import { useDismiss } from '../util'

/** How many rounds the menu lists, newest first. */
const ROUNDS_SHOWN = 3

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

// -------------------------------------------------------------- base picker

/** "vs main ▾" — which branch the PR targets, and so where the diff starts. */
export function BasePicker({
  branch,
  base,
  onChange
}: {
  branch: BranchInfo | null
  base: string | null
  onChange: (base: string) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(ref, open, () => setOpen(false))

  const names = useMemo(() => {
    const q = query.trim().toLowerCase()
    const all = branch?.branches ?? []
    return q ? all.filter((b) => b.toLowerCase().includes(q)) : all
  }, [branch, query])

  return (
    <div className="picker" ref={ref}>
      <button
        className="picker-button"
        disabled={!base}
        onClick={() => {
          setQuery('')
          setOpen((v) => !v)
        }}
        title={
          base
            ? `The PR targets ${branch?.baseRef ?? base}; the diff starts where this branch forked from it`
            : 'No base branch found to compare against'
        }
      >
        <span className="picker-dim">vs</span> {base ?? '—'} <span className="picker-caret">▾</span>
      </button>
      {open && (
        <div className="popover popover-narrow">
          <input
            className="popover-filter"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter branches…"
            spellCheck={false}
          />
          <ul>
            {names.map((name) => (
              <li key={name}>
                <button
                  className={`menu-row${name === base ? ' is-current' : ''}`}
                  onClick={() => {
                    onChange(name)
                    setOpen(false)
                  }}
                >
                  <span className="menu-check">{name === base ? '✓' : ''}</span>
                  <span className="menu-label">{name}</span>
                </button>
              </li>
            ))}
            {names.length === 0 && <li className="popover-loading">No branches match.</li>}
          </ul>
        </div>
      )}
    </div>
  )
}

// --------------------------------------------------------------- scope menu

export function scopeLabel(baseline: Baseline): string {
  switch (baseline.kind) {
    case 'branch':
      return 'All changes'
    case 'worktree':
      return 'Uncommitted'
    case 'snapshot':
      return `Since ${baseline.label ?? 'round'}`
    case 'commit':
      return `${baseline.ref?.slice(0, 7)} ${baseline.label ?? ''}`.trim()
  }
}

interface ScopeMenuProps {
  repoRoot: string
  baseline: Baseline
  branch: BranchInfo | null
  base: string | null
  /** Oldest first, as stored. */
  rounds: ReviewRound[]
  /** Whether picking a commit opens it on its own or on top of the commits before it. */
  commitCumulative: boolean
  onSelect: (baseline: Baseline) => void
  onStartRound: () => void
}

/**
 * Which part of the PR the diff shows: all of it, what changed since a round,
 * what's uncommitted, or one commit. GitHub's "Changes from all commits ▾".
 */
export function ScopeMenu(props: ScopeMenuProps): JSX.Element {
  const { baseline, branch, base, rounds } = props
  const recentRounds = rounds.slice(-ROUNDS_SHOWN).reverse()
  const [open, setOpen] = useState(false)
  const [older, setOlder] = useState<CommitInfo[] | null>(null)
  const [showOlder, setShowOlder] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(ref, open, () => setOpen(false))

  useEffect(() => {
    if (!open || !showOlder) return
    let cancelled = false
    setOlder(null)
    void window.gitdiff.listCommits(props.repoRoot).then((c) => {
      if (!cancelled) setOlder(c)
    })
    return () => {
      cancelled = true
    }
  }, [open, showOlder, props.repoRoot])

  const pick = (next: Baseline): void => {
    props.onSelect(next)
    setOpen(false)
  }

  const onBranch = new Set(branch?.commits.map((c) => c.sha))
  const pickCommit = (c: CommitInfo): void =>
    pick({
      kind: 'commit',
      ref: c.sha,
      label: c.subject,
      // "Up to here" only means something for commits this branch added.
      cumulative: props.commitCumulative && onBranch.has(c.sha) && !!base,
      base: base ?? undefined
    })

  const isCommit = (sha: string): boolean => baseline.kind === 'commit' && baseline.ref === sha

  return (
    <div className="picker" ref={ref}>
      <button
        className="picker-button picker-scope"
        onClick={() => {
          setShowOlder(false)
          setOpen((v) => !v)
        }}
        title="Which part of the PR to show"
      >
        <span className="picker-scope-label">{scopeLabel(baseline)}</span>{' '}
        <span className="picker-caret">▾</span>
      </button>

      {open && !showOlder && (
        <div className="popover">
          <ul>
            {base && (
              <MenuRow
                current={baseline.kind === 'branch'}
                label="All changes"
                hint={`Everything the PR would contain, vs ${base}`}
                onClick={() => pick({ kind: 'branch', base })}
              />
            )}
            {recentRounds.map((r) => (
              <MenuRow
                key={r.n}
                current={baseline.kind === 'snapshot' && baseline.ref === r.tree}
                label={`Since round ${r.n}`}
                hint={`What changed after ${clock(r.at)}`}
                onClick={() => pick({ kind: 'snapshot', ref: r.tree, label: `round ${r.n}` })}
              />
            ))}
            <MenuRow
              current={false}
              label={rounds.length ? 'Start a new round' : 'Start a round'}
              hint="Snapshot now; then see only what changes after this"
              kbd="⌘M"
              onClick={() => {
                setOpen(false)
                props.onStartRound()
              }}
            />
          </ul>

          <div className="popover-title">Commits</div>
          <ul>
            <MenuRow
              current={baseline.kind === 'worktree'}
              label="Uncommitted"
              hint="On disk but not committed yet"
              onClick={() => pick({ kind: 'worktree' })}
            />
            {branch?.commits.map((c) => (
              <CommitRow key={c.sha} commit={c} current={isCommit(c.sha)} onClick={() => pickCommit(c)} />
            ))}
            {branch && branch.commits.length === 0 && base && (
              <li className="popover-loading">No commits on this branch yet.</li>
            )}
          </ul>

          <ul className="popover-footer">
            <MenuRow current={false} label="Browse older commits…" onClick={() => setShowOlder(true)} />
          </ul>
        </div>
      )}

      {open && showOlder && (
        <div className="popover">
          <ul>
            <MenuRow current={false} label="← Back" onClick={() => setShowOlder(false)} />
          </ul>
          <div className="popover-title">Recent commits</div>
          <ul>
            {older === null && <li className="popover-loading">Loading…</li>}
            {older?.length === 0 && <li className="popover-loading">No commits yet.</li>}
            {older?.map((c) => (
              <CommitRow key={c.sha} commit={c} current={isCommit(c.sha)} onClick={() => pickCommit(c)} />
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function MenuRow({
  current,
  label,
  hint,
  kbd,
  onClick
}: {
  current: boolean
  label: string
  hint?: string
  kbd?: string
  onClick: () => void
}): JSX.Element {
  return (
    <li>
      <button className={`menu-row${current ? ' is-current' : ''}`} onClick={onClick}>
        <span className="menu-check">{current ? '✓' : ''}</span>
        <span className="menu-label">
          {label}
          {hint && <span className="menu-hint">{hint}</span>}
        </span>
        {kbd && <kbd className="menu-kbd">{kbd}</kbd>}
      </button>
    </li>
  )
}

function CommitRow({
  commit,
  current,
  onClick
}: {
  commit: CommitInfo
  current: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <li>
      <button className={`commit-row${current ? ' is-current' : ''}`} onClick={onClick}>
        <code>{commit.shortSha}</code>
        <span className="commit-subject">{commit.subject}</span>
        <span className="commit-meta">
          {commit.author} · {commit.relativeDate}
        </span>
      </button>
    </li>
  )
}
