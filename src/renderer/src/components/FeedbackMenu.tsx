import { useEffect, useRef, useState } from 'react'
import type { LocatedComment, ReviewComment } from '@shared/review'
import { useDismiss } from '../util'

interface Props {
  repoRoot: string
  /** Open (unresolved) comments. */
  comments: ReviewComment[]
  resolvedCount: number
  /** Bumped when files change on disk, so outdated markers stay true while the menu is open. */
  scanToken: number
  onJump: (path: string, line: number) => void
  onResolve: (id: string) => void
  onCopy: () => void
  onSend: () => void
  onClearResolved: () => void
}

/**
 * Everything you've said about the agent's work, and the hand-off back to it.
 * "Send to agent" starts a round — so you then see only what it changes in
 * response — and puts the comments on the clipboard to paste into its chat.
 */
export function FeedbackMenu(props: Props): JSX.Element {
  const { comments } = props
  const [open, setOpen] = useState(false)
  const [located, setLocated] = useState<Map<string, LocatedComment['at']> | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(ref, open, () => setOpen(false))

  // Where each comment's lines are on disk now — which are outdated.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void window.gitdiff
      .locatedComments(props.repoRoot)
      .then((list) => {
        if (!cancelled) setLocated(new Map(list.map((l) => [l.comment.id, l.at])))
      })
      .catch(() => {
        if (!cancelled) setLocated(new Map())
      })
    return () => {
      cancelled = true
    }
  }, [open, props.repoRoot, comments, props.scanToken])

  const unsent = comments.filter((c) => c.round === null).length
  const sorted = [...comments].sort((a, b) => a.path.localeCompare(b.path) || a.startLine - b.startLine)

  return (
    <div className="picker" ref={ref}>
      <button
        className={`feedback-button${unsent ? ' has-unsent' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title={
          comments.length
            ? `${comments.length} open comment${comments.length === 1 ? '' : 's'}${unsent ? `, ${unsent} not sent yet` : ''}`
            : 'Review comments — hover a line and click + to add one'
        }
      >
        Comments
        {comments.length > 0 && <span className="feedback-count">{comments.length}</span>}
      </button>

      {open && (
        <div className="popover popover-right feedback-popover">
          {comments.length === 0 ? (
            <p className="feedback-empty">
              No open comments. Hover a line on the right-hand side of a diff and click <b>+</b>, or select some
              lines and press <kbd>c</kbd>.
            </p>
          ) : (
            <ul>
              {sorted.map((c) => {
                const at = located?.get(c.id)
                const outdated = located !== null && !at
                const line = at?.startLine ?? c.startLine
                return (
                  <li key={c.id}>
                    <div className="feedback-row">
                      <button
                        className="feedback-jump"
                        onClick={() => {
                          props.onJump(c.path, line)
                          setOpen(false)
                        }}
                      >
                        <span className="feedback-where">
                          {c.path}
                          <span className="feedback-line">:{line}</span>
                          {outdated ? (
                            <span className="feedback-tag is-outdated">outdated</span>
                          ) : c.round === null ? (
                            <span className="feedback-tag is-new">new</span>
                          ) : (
                            <span className="feedback-tag">round {c.round}</span>
                          )}
                        </span>
                        <span className="feedback-body">{c.body}</span>
                      </button>
                      <button className="feedback-resolve" title="Resolve" onClick={() => props.onResolve(c.id)}>
                        ✓
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}

          <div className="feedback-footer">
            {props.resolvedCount > 0 && (
              <button className="link" onClick={props.onClearResolved}>
                Clear {props.resolvedCount} resolved
              </button>
            )}
            <span className="feedback-spacer" />
            <button
              className="sheet-cancel"
              disabled={comments.length === 0}
              onClick={() => {
                props.onCopy()
                setOpen(false)
              }}
            >
              Copy as prompt
            </button>
            <button
              className="primary"
              disabled={comments.length === 0}
              onClick={() => {
                props.onSend()
                setOpen(false)
              }}
              title="Start a new round and copy the comments, to paste to your agent"
            >
              Send to agent
            </button>
          </div>
          <p className="feedback-note">
            Your agent can read these itself with <code>gitdiff comments</code>.
          </p>
        </div>
      )}
    </div>
  )
}
