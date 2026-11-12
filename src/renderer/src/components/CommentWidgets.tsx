import { useEffect, useRef, useState } from 'react'
import type { ReviewComment } from '@shared/review'

/**
 * The cards that sit between lines of the diff. Each one is rendered into its
 * own Monaco view zone with its own React root (see DiffView), so these
 * components get everything through props — no context from the app.
 */

function rangeLabel(start: number, end: number): string {
  return start === end ? `Line ${start}` : `Lines ${start}–${end}`
}

export function Composer({
  start,
  end,
  initial,
  submitLabel,
  onSubmit,
  onCancel
}: {
  start: number
  end: number
  initial: string
  submitLabel: string
  onSubmit: (body: string) => void
  onCancel: () => void
}): JSX.Element {
  const [text, setText] = useState(initial)
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    // A view zone's DOM is attached a moment after React renders into it.
    const id = requestAnimationFrame(() => {
      ref.current?.focus()
      ref.current?.setSelectionRange(text.length, text.length)
    })
    return () => cancelAnimationFrame(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const submit = (): void => {
    if (text.trim()) onSubmit(text.trim())
  }

  return (
    <div className="comment-card is-composer">
      <div className="comment-head">{rangeLabel(start, end)}</div>
      <textarea
        ref={ref}
        className="comment-input"
        rows={3}
        value={text}
        placeholder="What should change here?"
        spellCheck
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            submit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
        }}
      />
      <div className="comment-actions">
        <span className="comment-hint">⌘↩ to save · Esc to cancel</span>
        <button onClick={onCancel}>Cancel</button>
        <button className="comment-primary" disabled={!text.trim()} onClick={submit}>
          {submitLabel}
        </button>
      </div>
    </div>
  )
}

export function CommentCard({
  comment,
  start,
  end,
  onUpdate,
  onResolve,
  onDelete
}: {
  comment: ReviewComment
  start: number
  end: number
  onUpdate: (body: string) => void
  onResolve: () => void
  onDelete: () => void
}): JSX.Element {
  const [editing, setEditing] = useState(false)

  if (editing) {
    return (
      <Composer
        start={start}
        end={end}
        initial={comment.body}
        submitLabel="Save"
        onSubmit={(body) => {
          onUpdate(body)
          setEditing(false)
        }}
        onCancel={() => setEditing(false)}
      />
    )
  }

  return (
    <div className="comment-card">
      <div className="comment-head">
        {rangeLabel(start, end)}
        <span className={`comment-state${comment.round === null ? ' is-new' : ''}`}>
          {comment.round === null ? 'not sent yet' : `sent in round ${comment.round}`}
        </span>
      </div>
      <div className="comment-body">{comment.body}</div>
      <div className="comment-actions">
        <span className="comment-hint" />
        <button onClick={() => setEditing(true)}>Edit</button>
        <button onClick={onResolve} title="Done — hide it, and stop sending it to the agent">
          Resolve
        </button>
        <button className="danger" onClick={onDelete}>
          Delete
        </button>
      </div>
    </div>
  )
}
