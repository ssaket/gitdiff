/**
 * Monaco, trimmed to what a diff viewer needs.
 *
 * We pull in the editor core plus the Monarch grammars (syntax colouring) but
 * deliberately skip the TypeScript/JSON/CSS/HTML *language services*. Those run
 * in their own workers and only buy IntelliSense, which is meaningless in a
 * read-only diff — leaving them out keeps startup fast and avoids juggling four
 * extra worker bundles.
 */
import 'monaco-editor/esm/vs/editor/editor.all.js'
import 'monaco-editor/esm/vs/basic-languages/monaco.contribution'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'

// The editor worker is what actually computes the diff, so this must be set
// before the first diff editor is created.
self.MonacoEnvironment = {
  getWorker: () => new EditorWorker()
}

/**
 * Tearing down a diff editor rejects any in-flight diff computation with
 * Monaco's internal `Canceled` error, which nothing is left around to catch —
 * it surfaces as an unhandled rejection every time the file list empties.
 * Swallow exactly that one shape, so genuine rejections still reach the console.
 */
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason as { name?: string; message?: string } | undefined
  const name = reason?.name
  if ((name === 'Canceled' || name === 'CancellationError') && reason?.message === 'Canceled') {
    event.preventDefault()
  }
})

monaco.editor.defineTheme('gitdiff-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#0f1216',
    'editor.foreground': '#d7dce3',
    'editorGutter.background': '#0f1216',
    'editorLineNumber.foreground': '#4a525e',
    'editorLineNumber.activeForeground': '#98a2b1',
    'editor.lineHighlightBackground': '#ffffff08',
    'editorIndentGuide.background1': '#20252c',
    'editorOverviewRuler.border': '#00000000',
    'diffEditor.insertedTextBackground': '#3fb9502e',
    'diffEditor.removedTextBackground': '#f8514930',
    'diffEditor.insertedLineBackground': '#3fb95018',
    'diffEditor.removedLineBackground': '#f851491c',
    'diffEditor.diagonalFill': '#1b2027',
    'scrollbarSlider.background': '#5a636e33',
    'scrollbarSlider.hoverBackground': '#5a636e55',
    'scrollbarSlider.activeBackground': '#5a636e77',
    'editorWidget.background': '#161a20',
    'editorWidget.border': '#262c34'
  }
})

monaco.editor.defineTheme('gitdiff-light', {
  base: 'vs',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#ffffff',
    'editorGutter.background': '#ffffff',
    'diffEditor.insertedTextBackground': '#2da44e26',
    'diffEditor.removedTextBackground': '#cf222e26',
    'diffEditor.insertedLineBackground': '#2da44e14',
    'diffEditor.removedLineBackground': '#cf222e12',
    'diffEditor.diagonalFill': '#eceef1'
  }
})

let extensionIndex: Map<string, string> | null = null
let filenameIndex: Map<string, string> | null = null

function buildIndexes(): void {
  extensionIndex = new Map()
  filenameIndex = new Map()
  for (const lang of monaco.languages.getLanguages()) {
    for (const ext of lang.extensions ?? []) extensionIndex.set(ext.toLowerCase(), lang.id)
    for (const name of lang.filenames ?? []) filenameIndex.set(name.toLowerCase(), lang.id)
  }
}

/** Extras Monaco's basic-languages set doesn't map on its own. */
const EXTRA_EXTENSIONS: Record<string, string> = {
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsonc': 'json',
  '.tsx': 'typescript',
  '.jsx': 'javascript',
  '.zsh': 'shell',
  '.bash': 'shell',
  '.env': 'ini',
  '.toml': 'ini',
  '.lock': 'yaml',
  '.gitignore': 'ini',
  '.prisma': 'graphql',
  '.svelte': 'html',
  '.vue': 'html'
}

export function languageForPath(filePath: string): string {
  if (!extensionIndex || !filenameIndex) buildIndexes()
  const base = filePath.split('/').pop() ?? filePath
  const lower = base.toLowerCase()

  const byName = filenameIndex!.get(lower)
  if (byName) return byName

  const dot = lower.lastIndexOf('.')
  if (dot === -1) return 'plaintext'
  const ext = lower.slice(dot)
  return EXTRA_EXTENSIONS[ext] ?? extensionIndex!.get(ext) ?? 'plaintext'
}

export { monaco }
