import { useRef, useState } from 'react'
import type { FlowDoc } from '@shared/types'
import { FlowView, type FlowViewHandle } from './FlowView'

interface Props {
  flows: FlowDoc[]
  selectedId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
  onChange: (id: string, patch: { title?: string; source?: string }) => void
  onError: (message: string) => void
  showSource: boolean
  onShowSourceChange: (value: boolean) => void
  dark: boolean
}

/** The agent-facing half of the feature, shown when there's nothing to display. */
const AGENT_SNIPPET = `gitdiff flow --title "Request flow" <<'MMD'
flowchart TD
  A[Client] --> B[API]
  B --> C[(Database)]
MMD`

/**
 * The first word of a mermaid diagram is its type. Worth surfacing in the list:
 * it is the one thing that distinguishes two diagrams at a glance, and it lines
 * up with the status letter the file list shows in the same column.
 */
const KINDS: [RegExp, string][] = [
  [/^(flowchart|graph)\b/, 'flow'],
  [/^sequenceDiagram\b/, 'seq'],
  [/^classDiagram/, 'class'],
  [/^stateDiagram/, 'state'],
  [/^erDiagram\b/, 'er'],
  [/^gantt\b/, 'gantt'],
  [/^pie\b/, 'pie'],
  [/^gitGraph\b/, 'git'],
  [/^mindmap\b/, 'mind'],
  [/^timeline\b/, 'time'],
  [/^journey\b/, 'user'],
  [/^quadrantChart\b/, 'quad'],
  [/^requirementDiagram\b/, 'req'],
  [/^(sankey|xychart|block|architecture|packet|kanban|radar|treemap)/, 'diag']
]

function flowKind(source: string): string {
  // Skip frontmatter, comments and blanks to reach the declaration line.
  const line = source
    .replace(/^---\r?\n[\s\S]*?\r?\n---/, '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('%%'))
  if (!line) return '·'
  return KINDS.find(([re]) => re.test(line))?.[1] ?? '·'
}

function ago(ts: number): string {
  const seconds = Math.max(0, (Date.now() - ts) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export function FlowsPane({
  flows,
  selectedId,
  onSelect,
  onNew,
  onDelete,
  onChange,
  onError,
  showSource,
  onShowSourceChange,
  dark
}: Props): JSX.Element {
  const [copied, setCopied] = useState<string | null>(null)
  const viewRef = useRef<FlowViewHandle>(null)

  const selected = flows.find((f) => f.id === selectedId) ?? null

  const flash = (label: string): void => {
    setCopied(label)
    window.setTimeout(() => setCopied((c) => (c === label ? null : c)), 1400)
  }

  const copyImage = async (): Promise<void> => {
    try {
      const png = await viewRef.current?.toPng()
      if (!png) throw new Error('Nothing rendered yet.')
      await window.gitdiff.copyFlowImage(png)
      flash('image')
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    }
  }

  const copySource = async (): Promise<void> => {
    if (!selected) return
    await navigator.clipboard.writeText(selected.source)
    flash('source')
  }

  const exportFlow = async (): Promise<void> => {
    if (!selected) return
    try {
      const svg = viewRef.current?.getSvg()
      if (!svg) throw new Error('Nothing rendered yet.')
      await window.gitdiff.exportFlow(selected.title, svg, await viewRef.current!.toPng())
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <main className="workspace">
      <aside className="sidebar">
        <div className="sidebar-search">
          <span className="sidebar-label">Diagrams</span>
          <button className="icon-button" onClick={onNew} title="New diagram">
            ＋
          </button>
        </div>

        <ul className="file-list">
          {flows.map((f) => (
            <li key={f.id} className={`file-item${f.id === selectedId ? ' is-selected' : ''}`}>
              <button className="file-row" onClick={() => onSelect(f.id)} title={f.title}>
                <span className="status status-flow">{flowKind(f.source)}</span>
                <span className="flow-title">{f.title}</span>
                <span className="flow-when">{ago(f.updatedAt)}</span>
              </button>
              <button
                className="review-dot flow-remove"
                aria-label={`Delete ${f.title}`}
                title="Delete"
                onClick={() => onDelete(f.id)}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>

        {flows.length === 0 && <p className="sidebar-empty">No diagrams yet.</p>}
      </aside>

      <section className="detail">
        {selected ? (
          <>
            <div className="file-header">
              <input
                className="flow-title-input"
                value={selected.title}
                spellCheck={false}
                aria-label="Diagram title"
                onChange={(e) => onChange(selected.id, { title: e.target.value })}
                // The store refuses to save an empty title, so don't leave one
                // on screen either — it would come back renamed after a restart.
                onBlur={() => !selected.title.trim() && onChange(selected.id, { title: 'Untitled flow' })}
              />
              {selected.origin && (
                <span className="flow-origin" title={selected.origin}>
                  {selected.origin}
                </span>
              )}
              <div className="file-header-actions">
                <button
                  className={showSource ? 'is-active' : ''}
                  onClick={() => onShowSourceChange(!showSource)}
                  title="Show the mermaid source (⌘E)"
                >
                  Source
                </button>
                <button onClick={() => void copyImage()} title="Copy the diagram as a PNG">
                  {copied === 'image' ? 'Copied' : 'Copy'}
                </button>
                <button onClick={() => void copySource()} title="Copy the mermaid source">
                  {copied === 'source' ? 'Copied' : 'Copy text'}
                </button>
                <button onClick={() => void exportFlow()} title="Save as SVG or PNG">
                  Export
                </button>
              </div>
            </div>

            <div className={`flow-body${showSource ? ' with-source' : ''}`}>
              {/* Keyed by id so switching diagrams resets zoom and pan rather
                  than leaving the next one scrolled off-screen. */}
              <FlowView key={selected.id} ref={viewRef} source={selected.source} dark={dark} />

              {showSource && (
                <textarea
                  className="flow-source mono"
                  value={selected.source}
                  spellCheck={false}
                  aria-label="Mermaid source"
                  onChange={(e) => onChange(selected.id, { source: e.target.value })}
                />
              )}
            </div>
          </>
        ) : (
          <FlowsEmpty onNew={onNew} />
        )}
      </section>
    </main>
  )
}

function FlowsEmpty({ onNew }: { onNew: () => void }): JSX.Element {
  const [copied, setCopied] = useState(false)

  return (
    <div className="flow-empty">
      <div className="flow-empty-card">
        <h2>Diagrams from your agent</h2>
        <p>
          Ask Claude Code or Codex to explain something visually and have it pipe the mermaid here.
          The diagram opens in this tab, in this window.
        </p>
        <pre className="flow-empty-snippet mono">{AGENT_SNIPPET}</pre>
        <div className="flow-empty-actions">
          <button
            className="primary"
            onClick={() => {
              void navigator.clipboard.writeText(AGENT_SNIPPET)
              setCopied(true)
              window.setTimeout(() => setCopied(false), 1600)
            }}
          >
            {copied ? 'Copied' : 'Copy command'}
          </button>
          <button className="flow-empty-secondary" onClick={onNew}>
            Write one myself
          </button>
        </div>
        <p className="flow-empty-hint">
          Markdown works too — pipe a file with <code>```mermaid</code> blocks and each becomes its
          own diagram.
        </p>
      </div>
    </div>
  )
}
