import type { Baseline, BranchInfo, PrLookup, RepoInfo } from '@shared/types'
import type { ReviewComment, ReviewRound } from '@shared/review'
import { FeedbackMenu } from './FeedbackMenu'
import { BasePicker, ScopeMenu } from './ScopeMenu'

export type Tab = 'review' | 'flows'

interface Props {
  /** Null when the app was opened straight into a diagram, with no repo. */
  repo: RepoInfo | null
  tab: Tab
  onTabChange: (tab: Tab) => void
  flowCount: number
  baseline: Baseline
  onBaselineChange: (baseline: Baseline) => void
  branch: BranchInfo | null
  base: string | null
  onBaseChange: (base: string) => void
  rounds: ReviewRound[]
  onStartRound: () => void
  /** Open review comments, and what to do with them. */
  comments: ReviewComment[]
  resolvedCount: number
  scanToken: number
  onJumpToComment: (path: string, line: number) => void
  onResolveComment: (id: string) => void
  onCopyComments: () => void
  onSendComments: () => void
  onClearResolved: () => void
  commitCumulative: boolean
  pr: PrLookup | null
  onOpenPrSheet: () => void
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

export function Toolbar(props: Props): JSX.Element {
  const { repo, tab } = props
  const openPr = props.pr?.pr ?? null

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
          <BasePicker branch={props.branch} base={props.base} onChange={props.onBaseChange} />
          <ScopeMenu
            repoRoot={repo.root}
            baseline={props.baseline}
            branch={props.branch}
            base={props.base}
            rounds={props.rounds}
            commitCumulative={props.commitCumulative}
            onSelect={props.onBaselineChange}
            onStartRound={props.onStartRound}
          />
        </>
      )}

      <div className="toolbar-spacer" />

      {tab === 'review' && repo && (
        <>
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

          <FeedbackMenu
            repoRoot={repo.root}
            comments={props.comments}
            resolvedCount={props.resolvedCount}
            scanToken={props.scanToken}
            onJump={props.onJumpToComment}
            onResolve={props.onResolveComment}
            onCopy={props.onCopyComments}
            onSend={props.onSendComments}
            onClearResolved={props.onClearResolved}
          />

          <div className="pr-actions">
            {openPr && (
              <button
                className="pr-link"
                onClick={() => window.open(openPr.url)}
                title={`Open PR #${openPr.number} on GitHub — ${openPr.title}`}
              >
                #{openPr.number} ↗
              </button>
            )}
            <button
              className="pr-button"
              disabled={!props.base}
              onClick={props.onOpenPrSheet}
              title={
                !props.base
                  ? 'There is no base branch to open a PR against'
                  : openPr
                    ? `Push what's on disk to PR #${openPr.number}`
                    : `Open a pull request into ${props.base} with what's on disk`
              }
            >
              {openPr ? 'Update PR' : 'Create PR'}
            </button>
          </div>
        </>
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
