import { useMemo } from 'react'
import type { ChangeStatus, FileChange } from '@shared/types'

interface Props {
  files: FileChange[]
  selected: string | null
  reviewed: Set<string>
  filter: string
  onFilterChange: (value: string) => void
  onSelect: (path: string) => void
  onToggleReviewed: (path: string) => void
  filterRef: React.RefObject<HTMLInputElement>
  /** Paths with edits not yet saved. */
  unsaved: Record<string, unknown>
  /** Open review comments per path. */
  commentCounts: Map<string, number>
}

const STATUS_LABEL: Record<ChangeStatus, string> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'type changed'
}

function splitPath(p: string): { dir: string; name: string } {
  const i = p.lastIndexOf('/')
  return i === -1 ? { dir: '', name: p } : { dir: p.slice(0, i + 1), name: p.slice(i + 1) }
}

export function FileList({
  files,
  selected,
  reviewed,
  filter,
  onFilterChange,
  onSelect,
  onToggleReviewed,
  filterRef,
  unsaved,
  commentCounts
}: Props): JSX.Element {
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return files
    return files.filter((f) => f.path.toLowerCase().includes(q))
  }, [files, filter])

  const reviewedCount = files.filter((f) => reviewed.has(f.path)).length

  return (
    <aside className="sidebar">
      <div className="sidebar-search">
        <input
          ref={filterRef}
          value={filter}
          onChange={(e) => onFilterChange(e.target.value)}
          placeholder="Filter files…"
          spellCheck={false}
          aria-label="Filter files"
        />
        {filter && (
          <button className="icon-button" onClick={() => onFilterChange('')} title="Clear filter">
            ✕
          </button>
        )}
      </div>

      {files.length > 0 && (
        <div className="sidebar-progress">
          <div className="progress-track">
            <div
              className="progress-fill"
              style={{ width: `${files.length ? (reviewedCount / files.length) * 100 : 0}%` }}
            />
          </div>
          <span>
            {reviewedCount}/{files.length} reviewed
          </span>
        </div>
      )}

      <ul className="file-list">
        {visible.map((f) => {
          const { dir, name } = splitPath(f.path)
          const isReviewed = reviewed.has(f.path)
          return (
            <li
              key={f.path}
              className={`file-item${f.path === selected ? ' is-selected' : ''}${
                isReviewed ? ' is-reviewed' : ''
              }`}
            >
              <button
                className="file-row"
                onClick={() => onSelect(f.path)}
                title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
              >
                <span
                  className={`status status-${f.status}`}
                  title={f.untracked ? 'new, untracked' : STATUS_LABEL[f.status]}
                >
                  {f.untracked ? 'U' : f.status}
                </span>
                <span className="file-name">
                  {dir && <span className="file-dir">{dir}</span>}
                  {name}
                </span>
                {f.inCommit && <span className="in-commit" title="Changed in this commit" />}
                {commentCounts.get(f.path) ? (
                  <span className="file-comments" title="Open review comments">
                    {commentCounts.get(f.path)}
                  </span>
                ) : null}
                {f.path in unsaved && <span className="file-unsaved" title="Unsaved edits" />}
                <span className="counts">
                  {f.binary ? (
                    <span className="count-bin">bin</span>
                  ) : (
                    <>
                      {f.additions > 0 && <span className="count-add">+{f.additions}</span>}
                      {f.deletions > 0 && <span className="count-del">−{f.deletions}</span>}
                    </>
                  )}
                </span>
              </button>
              <button
                className="review-dot"
                role="checkbox"
                aria-checked={isReviewed}
                aria-label={`Mark ${f.path} reviewed`}
                onClick={() => onToggleReviewed(f.path)}
              >
                {isReviewed ? '✓' : ''}
              </button>
            </li>
          )
        })}
      </ul>

      {visible.length === 0 && (
        <p className="sidebar-empty">{files.length === 0 ? 'No changes.' : 'Nothing matches that filter.'}</p>
      )}
    </aside>
  )
}
