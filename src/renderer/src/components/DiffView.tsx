import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import type { FileDiff } from '@shared/types'
import { languageForPath, monaco } from '../monaco'

export interface DiffViewHandle {
  goToDiff: (direction: 'next' | 'previous') => void
  focus: () => void
}

interface Props {
  diff: FileDiff | null
  sideBySide: boolean
  collapseUnchanged: boolean
  ignoreWhitespace: boolean
  dark: boolean
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
  scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 }
}

export const DiffView = forwardRef<DiffViewHandle, Props>(function DiffView(
  { diff, sideBySide, collapseUnchanged, ignoreWhitespace, dark },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  const modelsRef = useRef<monaco.editor.IDiffEditorModel | null>(null)
  const lastPathRef = useRef<string | null>(null)

  useImperativeHandle(ref, () => ({
    goToDiff: (direction) => editorRef.current?.goToDiff(direction),
    focus: () => editorRef.current?.focus()
  }))

  useEffect(() => {
    if (!containerRef.current) return
    const editor = monaco.editor.createDiffEditor(containerRef.current, {
      ...BASE_OPTIONS,
      theme: dark ? 'gitdiff-dark' : 'gitdiff-light'
    })
    editorRef.current = editor
    return () => {
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
      hideUnchangedRegions: {
        enabled: collapseUnchanged,
        revealLineCount: 12,
        minimumLineCount: 4,
        contextLineCount: 3
      }
    })
  }, [sideBySide, collapseUnchanged, ignoreWhitespace])

  useEffect(() => {
    monaco.editor.setTheme(dark ? 'gitdiff-dark' : 'gitdiff-light')
  }, [dark])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return

    if (!diff || diff.payload.kind !== 'text') {
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

    // Re-rendering the same file (a watcher refresh, say) should not throw the
    // reader back to line 1 — swap the text in place and restore the viewport.
    if (samePath && existing) {
      const view = editor.saveViewState()
      if (existing.original.getValue() !== original) existing.original.setValue(original)
      if (existing.modified.getValue() !== modified) existing.modified.setValue(modified)
      if (view) editor.restoreViewState(view)
      return
    }

    const models: monaco.editor.IDiffEditorModel = {
      original: monaco.editor.createModel(original, languageForPath(originalPath)),
      modified: monaco.editor.createModel(modified, languageForPath(diff.path))
    }
    editor.setModel(models)
    existing?.original.dispose()
    existing?.modified.dispose()
    modelsRef.current = models
    lastPathRef.current = diff.path
  }, [diff])

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
