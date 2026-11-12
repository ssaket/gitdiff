import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { FileDiff } from '@shared/types'
import { linesOf, locate, type ReviewComment } from '@shared/review'
import { languageForPath, monaco } from '../monaco'
import { CommentCard, Composer } from './CommentWidgets'

export interface DiffViewHandle {
  goToDiff: (direction: 'next' | 'previous') => void
  focus: () => void
  /** Opens a comment composer on the selected lines, or the cursor's line. */
  openComposer: () => void
}

export interface NewComment {
  path: string
  startLine: number
  endLine: number
  anchor: string
  body: string
}

export interface CommentActions {
  add: (comment: NewComment) => void
  update: (id: string, body: string) => void
  resolve: (id: string) => void
  remove: (id: string) => void
}

interface Props {
  diff: FileDiff | null
  sideBySide: boolean
  collapseUnchanged: boolean
  ignoreWhitespace: boolean
  dark: boolean
  /**
   * The right-hand side is the working-tree file and may be edited. Also what
   * makes commenting possible: comments anchor to working-tree lines.
   */
  editable: boolean
  /** The app holds unsaved edits for this file: its text in the editor must not be replaced. */
  dirty: boolean
  /** Every edit, with the whole new text. */
  onEdit: (path: string, text: string) => void
  /**
   * Bumped by the app to make the editor take `diff`'s text even over edits —
   * for throwing the edits away. Otherwise the editor's own text wins.
   */
  resetKey: number
  /** Open comments on this file. */
  comments: ReviewComment[]
  commentActions: CommentActions
  /** Scroll this line into view once its file is showing. */
  reveal: { path: string; line: number } | null
  onRevealed: () => void
}

const BASE_OPTIONS: monaco.editor.IStandaloneDiffEditorConstructionOptions = {
  readOnly: true,
  originalEditable: false,
  automaticLayout: true,
  scrollBeyondLastLine: false,
  renderOverviewRuler: true,
  minimap: { enabled: false },
  fontSize: 12.5,
  lineHeight: 19,
  fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
  renderWhitespace: 'selection',
  diffAlgorithm: 'advanced',
  smoothScrolling: true,
  cursorBlinking: 'smooth',
  padding: { top: 8, bottom: 40 },
  scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
  // Where the "+" to comment on a line appears.
  glyphMargin: true,
  // The arrows that revert one hunk. Monaco draws them only side by side,
  // only while the modified side is editable, and only with its newer gutter
  // menu off — which in standalone Monaco has nothing in it anyway.
  renderMarginRevertIcon: true,
  renderGutterMenu: false
}

/**
 * A view zone's DOM sits inside Monaco's, so without this every click and key
 * in a comment box would also reach the editor — moving its cursor, or typing
 * into the file. Each card's React root is the inner node and handles the
 * event first; this stops it at the boundary. Wheel is left alone so the
 * editor still scrolls under the pointer.
 */
const ISOLATED_EVENTS = [
  'mousedown',
  'mouseup',
  'click',
  'dblclick',
  'pointerdown',
  'pointerup',
  'contextmenu',
  'keydown',
  'keyup',
  'keypress',
  'beforeinput',
  'input',
  'paste',
  'copy',
  'cut',
  'compositionstart',
  'compositionupdate',
  'compositionend'
]

interface Zone {
  zoneId: string
  zone: monaco.editor.IViewZone
  root: Root
  observer: ResizeObserver
}

interface ComposerState {
  path: string
  start: number
  end: number
  /** The lines' text when the composer opened, to find them again if edits move them. */
  anchor: string
}

/** The selection as whole lines; a selection ending at column 1 doesn't include that line. */
function selectedLines(editor: monaco.editor.ICodeEditor, around?: number): { start: number; end: number } | null {
  const sel = editor.getSelection()
  if (sel && !sel.isEmpty()) {
    const end = sel.endColumn === 1 && sel.endLineNumber > sel.startLineNumber ? sel.endLineNumber - 1 : sel.endLineNumber
    if (around === undefined || (around >= sel.startLineNumber && around <= end)) {
      return { start: sel.startLineNumber, end }
    }
  }
  const line = around ?? editor.getPosition()?.lineNumber
  return line ? { start: line, end: line } : null
}

export const DiffView = forwardRef<DiffViewHandle, Props>(function DiffView(props, ref) {
  const { diff, sideBySide, collapseUnchanged, ignoreWhitespace, dark, editable, dirty, comments, reveal } = props
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  const modelsRef = useRef<monaco.editor.IDiffEditorModel | null>(null)
  const lastPathRef = useRef<string | null>(null)
  const commitMarksRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null)
  const commentMarksRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null)
  const hoverMarkRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null)
  const zonesRef = useRef(new Map<string, Zone>())

  /** True while we set the text ourselves, so it isn't reported as an edit. */
  const applyingRef = useRef(false)
  /** The user has typed into this model; from then on its text beats incoming text. */
  const userEditedRef = useRef(false)
  const resetKeyRef = useRef(props.resetKey)

  const [composer, setComposer] = useState<ComposerState | null>(null)
  // Bumped when the right-hand text settles after a change, so comment cards
  // follow their lines as edits above them move them. Debounced: re-finding
  // every comment and re-rendering every card on each keystroke makes typing
  // in a commented file lag.
  const [textVersion, setTextVersion] = useState(0)
  const relocateTimer = useRef<number | undefined>(undefined)

  // The mouse handlers are registered once, so they read current values here.
  const live = useRef({ commentsOn: false, editable: false, path: null as string | null, onEdit: props.onEdit })
  const commentsOn = editable && diff?.payload.kind === 'text'
  live.current = { commentsOn, editable, path: diff?.path ?? null, onEdit: props.onEdit }

  const openComposerAt = useCallback((around?: number) => {
    const editor = editorRef.current?.getModifiedEditor()
    const model = modelsRef.current?.modified
    const path = live.current.path
    if (!editor || !model || !path || !live.current.commentsOn) return
    const lines = selectedLines(editor, around)
    if (!lines) return
    setComposer({ path, ...lines, anchor: linesOf(model.getValue(), lines.start, lines.end) })
  }, [])

  useImperativeHandle(ref, () => ({
    goToDiff: (direction) => editorRef.current?.goToDiff(direction),
    focus: () => editorRef.current?.focus(),
    openComposer: () => openComposerAt()
  }))

  const clearZones = useCallback(() => {
    const zones = zonesRef.current
    if (zones.size === 0) return
    const editor = editorRef.current?.getModifiedEditor()
    editor?.changeViewZones((acc) => {
      for (const z of zones.values()) acc.removeZone(z.zoneId)
    })
    for (const z of zones.values()) {
      z.observer.disconnect()
      // Unmounting a root synchronously from inside another root's effect
      // makes React complain; a tick later it's harmless.
      setTimeout(() => z.root.unmount())
    }
    zones.clear()
  }, [])

  useEffect(() => {
    if (!containerRef.current) return
    const editor = monaco.editor.createDiffEditor(containerRef.current, {
      ...BASE_OPTIONS,
      theme: dark ? 'gitdiff-dark' : 'gitdiff-light'
    })
    editorRef.current = editor
    const modified = editor.getModifiedEditor()
    hoverMarkRef.current = modified.createDecorationsCollection()
    commentMarksRef.current = modified.createDecorationsCollection()

    // GitHub's "+": hovering a line offers to comment on it.
    const hover = modified.onMouseMove((e) => {
      const line = e.target.position?.lineNumber
      const overZone =
        e.target.type === monaco.editor.MouseTargetType.CONTENT_VIEW_ZONE ||
        e.target.type === monaco.editor.MouseTargetType.GUTTER_VIEW_ZONE
      if (!live.current.commentsOn || !line || overZone) {
        hoverMarkRef.current?.clear()
        return
      }
      hoverMarkRef.current?.set([
        {
          range: new monaco.Range(line, 1, line, 1),
          options: { glyphMarginClassName: 'comment-add-glyph', glyphMarginHoverMessage: { value: 'Comment on this line' } }
        }
      ])
    })
    const leave = modified.onMouseLeave(() => hoverMarkRef.current?.clear())
    const down = modified.onMouseDown((e) => {
      if (!live.current.commentsOn) return
      if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || !e.target.position) return
      openComposerAt(e.target.position.lineNumber)
    })
    modified.addAction({
      id: 'gitdiff.comment',
      label: 'Comment on These Lines',
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 0,
      run: () => openComposerAt()
    })

    return () => {
      window.clearTimeout(relocateTimer.current)
      hover.dispose()
      leave.dispose()
      down.dispose()
      clearZones()
      editor.dispose()
      modelsRef.current?.original.dispose()
      modelsRef.current?.modified.dispose()
      modelsRef.current = null
      editorRef.current = null
    }
    // Created once; every other prop is applied through updateOptions below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    editorRef.current?.updateOptions({
      renderSideBySide: sideBySide,
      ignoreTrimWhitespace: ignoreWhitespace,
      readOnly: !editable,
      hideUnchangedRegions: {
        enabled: collapseUnchanged,
        revealLineCount: 12,
        minimumLineCount: 4,
        contextLineCount: 3
      }
    })
  }, [sideBySide, collapseUnchanged, ignoreWhitespace, editable])

  useEffect(() => {
    monaco.editor.setTheme(dark ? 'gitdiff-dark' : 'gitdiff-light')
  }, [dark])

  // Saved or reverted: nothing of the user's is at stake any more, so the
  // editor follows the file on disk again. Declared before the effect below so
  // a save and the rescan that follows it are seen in that order.
  useEffect(() => {
    if (!dirty) userEditedRef.current = false
  }, [dirty])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return

    if (!diff || diff.payload.kind !== 'text') {
      clearZones()
      editor.setModel(null)
      modelsRef.current?.original.dispose()
      modelsRef.current?.modified.dispose()
      modelsRef.current = null
      lastPathRef.current = null
      return
    }

    const { original, modified, originalPath } = diff.payload
    const samePath = lastPathRef.current === diff.path
    const existing = modelsRef.current
    const forced = resetKeyRef.current !== props.resetKey
    resetKeyRef.current = props.resetKey

    // Re-rendering the same file (a watcher refresh, say) should not throw the
    // reader back to line 1 — swap the text in place and restore the viewport.
    //
    // While there are edits, the editor's text is the user's: incoming text
    // replaces it only when the app asks (throwing the edits away). That covers
    // the app's unsaved draft (`dirty`) and also the moment between a keystroke
    // and the app hearing of it, when a stale copy of the draft could otherwise
    // land on top of newer typing. A read-only view (a commit) always shows
    // what it's given, whatever was typed into this file elsewhere.
    if (samePath && existing) {
      const setOriginal = existing.original.getValue() !== original
      const protectedEdits = live.current.editable && (dirty || userEditedRef.current)
      const setModified = existing.modified.getValue() !== modified && (forced || !protectedEdits)
      if (!setOriginal && !setModified) return
      const view = editor.saveViewState()
      applyingRef.current = true
      try {
        if (setOriginal) existing.original.setValue(original)
        if (setModified) {
          existing.modified.setValue(modified)
          userEditedRef.current = false
        }
      } finally {
        applyingRef.current = false
      }
      if (view) editor.restoreViewState(view)
      return
    }

    const models: monaco.editor.IDiffEditorModel = {
      original: monaco.editor.createModel(original, languageForPath(originalPath)),
      modified: monaco.editor.createModel(modified, languageForPath(diff.path))
    }
    const path = diff.path
    models.modified.onDidChangeContent(() => {
      window.clearTimeout(relocateTimer.current)
      relocateTimer.current = window.setTimeout(() => setTextVersion((v) => v + 1), 120)
      if (applyingRef.current) return
      userEditedRef.current = true
      live.current.onEdit(path, models.modified.getValue())
    })
    clearZones()
    setComposer(null)
    userEditedRef.current = false
    editor.setModel(models)
    existing?.original.dispose()
    existing?.modified.dispose()
    modelsRef.current = models
    lastPathRef.current = diff.path
    // resetKey is read through a ref; a bump always comes with a new `diff`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diff])

  // "Up to here" on a commit: the right side is the file as of that commit, and
  // these are the lines the commit itself wrote — marked in the gutter so they
  // stand out from what earlier commits contributed. Declared after the model
  // effect above so it decorates the model that effect just installed.
  useEffect(() => {
    commitMarksRef.current?.clear()
    commitMarksRef.current = null
    const editor = editorRef.current
    const ranges = diff?.payload.kind === 'text' ? diff.commitLines : undefined
    if (!editor || !ranges?.length) return
    commitMarksRef.current = editor.getModifiedEditor().createDecorationsCollection(
      ranges.map(([start, end]) => ({
        range: new monaco.Range(start, 1, end, 1),
        options: {
          isWholeLine: true,
          linesDecorationsClassName: 'commit-line-mark',
          overviewRuler: { color: '#7aa2f7', position: monaco.editor.OverviewRulerLane.Left }
        }
      }))
    )
  }, [diff])

  // Comment cards and the composer, as view zones under the lines they're about.
  useEffect(() => {
    const editor = editorRef.current?.getModifiedEditor()
    const model = modelsRef.current?.modified
    if (!editor || !model || !diff || !commentsOn) {
      clearZones()
      commentMarksRef.current?.clear()
      return
    }

    const text = model.getValue()
    const { commentActions } = props
    const wanted = new Map<string, { after: number; element: JSX.Element }>()
    const marks: monaco.editor.IModelDeltaDecoration[] = []

    for (const c of comments) {
      const at = locate(text, c)
      if (!at) continue // rewritten since: it's listed as outdated, not drawn here
      marks.push({
        range: new monaco.Range(at.startLine, 1, at.endLine, 1),
        options: { isWholeLine: true, className: 'comment-range', linesDecorationsClassName: 'comment-range-mark' }
      })
      wanted.set(`c:${c.id}`, {
        after: at.endLine,
        element: (
          <CommentCard
            comment={c}
            start={at.startLine}
            end={at.endLine}
            onUpdate={(body) => commentActions.update(c.id, body)}
            onResolve={() => commentActions.resolve(c.id)}
            onDelete={() => commentActions.remove(c.id)}
          />
        )
      })
    }

    if (composer && composer.path === diff.path) {
      const at = locate(text, { anchor: composer.anchor, startLine: composer.start }) ?? {
        startLine: composer.start,
        endLine: composer.end
      }
      marks.push({
        range: new monaco.Range(at.startLine, 1, at.endLine, 1),
        options: { isWholeLine: true, className: 'comment-range is-draft', linesDecorationsClassName: 'comment-range-mark' }
      })
      wanted.set('composer', {
        after: at.endLine,
        element: (
          <Composer
            start={at.startLine}
            end={at.endLine}
            initial=""
            submitLabel="Comment"
            onCancel={() => setComposer(null)}
            onSubmit={(body) => {
              commentActions.add({
                path: composer.path,
                startLine: at.startLine,
                endLine: at.endLine,
                anchor: linesOf(model.getValue(), at.startLine, at.endLine),
                body
              })
              setComposer(null)
            }}
          />
        )
      })
    }

    commentMarksRef.current?.set(marks)

    const zones = zonesRef.current
    editor.changeViewZones((acc) => {
      for (const [key, z] of zones) {
        if (wanted.has(key)) continue
        acc.removeZone(z.zoneId)
        z.observer.disconnect()
        setTimeout(() => z.root.unmount())
        zones.delete(key)
      }
      for (const [key, w] of wanted) {
        const existing = zones.get(key)
        if (existing) {
          existing.root.render(w.element)
          if (existing.zone.afterLineNumber !== w.after) {
            existing.zone.afterLineNumber = w.after
            acc.layoutZone(existing.zoneId)
          }
          continue
        }
        const outer = document.createElement('div')
        outer.className = 'comment-zone'
        for (const type of ISOLATED_EVENTS) outer.addEventListener(type, (e) => e.stopPropagation())
        const inner = document.createElement('div')
        inner.className = 'comment-zone-inner'
        outer.appendChild(inner)
        const root = createRoot(inner)
        root.render(w.element)
        const zone: monaco.editor.IViewZone = { afterLineNumber: w.after, heightInPx: 96, domNode: outer }
        const zoneId = acc.addZone(zone)
        // The card decides its own height — a long comment, the composer
        // opening for an edit — and the zone follows it.
        const observer = new ResizeObserver(() => {
          const height = Math.ceil(inner.getBoundingClientRect().height) + 10
          if (height > 10 && Math.abs(height - (zone.heightInPx ?? 0)) > 1) {
            zone.heightInPx = height
            editor.changeViewZones((a) => a.layoutZone(zoneId))
          }
        })
        observer.observe(inner)
        zones.set(key, { zoneId, zone, root, observer })
      }
    })
    // commentActions changes identity every render; the cards read it fresh
    // each time this runs, which is whenever anything they show changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comments, composer, textVersion, diff, commentsOn, clearZones])

  // Jump to a comment picked from the list once its file is up.
  useEffect(() => {
    const editor = editorRef.current?.getModifiedEditor()
    if (!reveal || !editor || !modelsRef.current || diff?.path !== reveal.path) return
    editor.revealLineInCenter(reveal.line)
    editor.setPosition({ lineNumber: reveal.line, column: 1 })
    props.onRevealed()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal, diff])

  const payload = diff?.payload

  return (
    <div className="diff-surface">
      <div
        ref={containerRef}
        className="diff-editor"
        style={{ display: payload?.kind === 'text' ? 'block' : 'none' }}
      />
      {payload?.kind === 'binary' && <Placeholder icon="◈" title="Binary file" detail={payload.reason} />}
      {payload?.kind === 'too-large' && (
        <Placeholder
          icon="⛰"
          title="File too large to diff"
          detail={`${(payload.bytes / 1024 / 1024).toFixed(1)} MB — open it in your editor instead.`}
        />
      )}
      {payload?.kind === 'image' && <ImageDiff payload={payload} />}
      {!diff && <Placeholder icon="⌘" title="No file selected" detail="Pick a file on the left." />}
    </div>
  )
})

function Placeholder({ icon, title, detail }: { icon: string; title: string; detail: string }): JSX.Element {
  return (
    <div className="placeholder">
      <div className="placeholder-icon">{icon}</div>
      <div className="placeholder-title">{title}</div>
      <div className="placeholder-detail">{detail}</div>
    </div>
  )
}

function ImageDiff({
  payload
}: {
  payload: { originalDataUrl: string | null; modifiedDataUrl: string | null }
}): JSX.Element {
  return (
    <div className="image-diff">
      <figure>
        <figcaption>Before</figcaption>
        {payload.originalDataUrl ? (
          <img src={payload.originalDataUrl} alt="previous version" />
        ) : (
          <div className="image-missing">did not exist</div>
        )}
      </figure>
      <figure>
        <figcaption>After</figcaption>
        {payload.modifiedDataUrl ? (
          <img src={payload.modifiedDataUrl} alt="current version" />
        ) : (
          <div className="image-missing">deleted</div>
        )}
      </figure>
    </div>
  )
}
