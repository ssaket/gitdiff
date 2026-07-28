import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'

export interface FlowViewHandle {
  /** The rendered SVG markup, or null if the source has never parsed. */
  getSvg: () => string | null
  /** A PNG data URL of the current diagram, rasterized at 2×. */
  toPng: () => Promise<string | null>
  fit: () => void
}

interface Props {
  source: string
  dark: boolean
}

interface Transform {
  x: number
  y: number
  k: number
}

const IDENTITY: Transform = { x: 0, y: 0, k: 1 }
const MIN_SCALE = 0.1
const MAX_SCALE = 8

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'

/**
 * Mermaid is ~1 MB of parser and layout engine, and nobody reviewing a diff
 * pays for it — the module is fetched the first time a diagram is rendered and
 * reused after that. `initialize` is global config, so the promise also carries
 * the theme it was last set to, and re-initializing is only worth it on change.
 */
let mermaidModule: Promise<typeof import('mermaid').default> | null = null
let initializedTheme: string | null = null
let renderSeq = 0

async function getMermaid(dark: boolean): Promise<typeof import('mermaid').default> {
  mermaidModule ??= import('mermaid').then((m) => m.default)
  const mermaid = await mermaidModule

  const theme = dark ? 'dark' : 'default'
  if (initializedTheme !== theme) {
    mermaid.initialize({
      startOnLoad: false,
      theme,
      // Diagrams arrive from an agent, i.e. from a model's output, so the
      // sanitizing parser rather than the one that trusts embedded HTML.
      securityLevel: 'strict',
      // Labels as <text> rather than foreignObject HTML: it is what lets the
      // SVG be rasterized to PNG at all, since canvas will not draw a
      // foreignObject.
      htmlLabels: false,
      flowchart: { htmlLabels: false, curve: 'basis', padding: 12 },
      class: { htmlLabels: false },
      fontFamily: FONT,
      // We render parse failures ourselves, next to the source that caused
      // them; without this mermaid also injects its own error graphic.
      suppressErrorRendering: true
    })
    initializedTheme = theme
  }
  return mermaid
}

/** Mermaid's messages are multi-line and end with a stack-ish tail; keep the head. */
function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  return raw.split('\n').slice(0, 6).join('\n').trim() || 'Could not render this diagram.'
}

export const FlowView = forwardRef<FlowViewHandle, Props>(function FlowView({ source, dark }, ref) {
  const surfaceRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<string | null>(null)

  const [transform, setTransform] = useState<Transform>(IDENTITY)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  /** Scales the diagram to fit, but never magnifies a small one past 1:1. */
  const fit = useCallback(() => {
    const surface = surfaceRef.current
    const svg = stageRef.current?.querySelector('svg')
    if (!surface || !svg) return

    const width = svg.viewBox.baseVal.width || svg.clientWidth
    const height = svg.viewBox.baseVal.height || svg.clientHeight
    if (!width || !height) return

    const pad = 32
    const k = Math.min(
      (surface.clientWidth - pad) / width,
      (surface.clientHeight - pad) / height,
      1
    )
    setTransform({
      k,
      x: (surface.clientWidth - width * k) / 2,
      y: (surface.clientHeight - height * k) / 2
    })
  }, [])

  useImperativeHandle(ref, () => ({
    getSvg: () => svgRef.current,
    toPng: () => rasterize(svgRef.current, dark),
    fit
  }))

  // ------------------------------------------------------------- rendering

  useEffect(() => {
    const text = source.trim()
    if (!text) {
      if (stageRef.current) stageRef.current.innerHTML = ''
      svgRef.current = null
      setError(null)
      return
    }

    let cancelled = false
    setPending(true)

    // Debounced: the source pane re-renders on every keystroke, and mermaid
    // layout is far too expensive to run per character.
    const timer = window.setTimeout(async () => {
      const id = `flow-render-${++renderSeq}`
      try {
        const mermaid = await getMermaid(dark)
        const { svg } = await mermaid.render(id, text)
        if (cancelled || !stageRef.current) return

        const first = svgRef.current === null
        svgRef.current = svg
        stageRef.current.innerHTML = svg
        sizeToIntrinsic(stageRef.current)
        setError(null)
        // Refit on the first good render of a diagram; later edits keep the
        // zoom and position the reader chose.
        if (first) fit()
      } catch (e) {
        if (cancelled) return
        // A half-written diagram fails to parse on nearly every keystroke.
        // Leaving the last good render on screen under the message is far
        // calmer than blanking the canvas as you type.
        setError(errorText(e))
        document.getElementById(id)?.remove()
      } finally {
        if (!cancelled) setPending(false)
      }
    }, 220)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [source, dark, fit])

  // ------------------------------------------------------------ interaction

  useEffect(() => {
    const surface = surfaceRef.current
    if (!surface) return

    // Registered by hand rather than through onWheel: React attaches wheel
    // listeners passively, and a passive listener cannot preventDefault, which
    // would let the whole window rubber-band while you pan the diagram.
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const rect = surface.getBoundingClientRect()
      const px = e.clientX - rect.left
      const py = e.clientY - rect.top

      setTransform((t) => {
        // Trackpad pinch arrives as a wheel event with ctrlKey set.
        if (e.ctrlKey || e.metaKey) {
          const k = clamp(t.k * Math.exp(-e.deltaY / 180), MIN_SCALE, MAX_SCALE)
          // Keep the point under the cursor pinned while the scale changes.
          return { k, x: px - ((px - t.x) / t.k) * k, y: py - ((py - t.y) / t.k) * k }
        }
        return { ...t, x: t.x - e.deltaX, y: t.y - e.deltaY }
      })
    }

    surface.addEventListener('wheel', onWheel, { passive: false })
    return () => surface.removeEventListener('wheel', onWheel)
  }, [])

  const onPointerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    const surface = e.currentTarget as HTMLElement
    surface.setPointerCapture(e.pointerId)
    const start = { x: e.clientX, y: e.clientY }
    let base: Transform | null = null

    const onMove = (move: PointerEvent): void => {
      setTransform((t) => {
        base ??= t
        return { ...base, x: base.x + (move.clientX - start.x), y: base.y + (move.clientY - start.y) }
      })
    }
    const onUp = (): void => {
      surface.releasePointerCapture(e.pointerId)
      surface.removeEventListener('pointermove', onMove)
      surface.removeEventListener('pointerup', onUp)
      surface.classList.remove('is-panning')
    }
    surface.classList.add('is-panning')
    surface.addEventListener('pointermove', onMove)
    surface.addEventListener('pointerup', onUp)
  }

  const zoomBy = (factor: number): void => {
    const surface = surfaceRef.current
    if (!surface) return
    const cx = surface.clientWidth / 2
    const cy = surface.clientHeight / 2
    setTransform((t) => {
      const k = clamp(t.k * factor, MIN_SCALE, MAX_SCALE)
      return { k, x: cx - ((cx - t.x) / t.k) * k, y: cy - ((cy - t.y) / t.k) * k }
    })
  }

  return (
    <div className="flow-surface" ref={surfaceRef} onPointerDown={onPointerDown} onDoubleClick={fit}>
      <div
        className="flow-stage"
        ref={stageRef}
        style={{ transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.k})` }}
      />

      {!source.trim() && (
        <div className="placeholder">
          <div className="placeholder-icon">◇</div>
          <div className="placeholder-title">Empty diagram</div>
          <div className="placeholder-detail">Write some mermaid in the source pane.</div>
        </div>
      )}

      <div className="flow-zoom">
        <button onClick={() => zoomBy(1 / 1.25)} title="Zoom out">
          −
        </button>
        <button className="flow-zoom-level" onClick={fit} title="Fit to window (or double-click the canvas)">
          {Math.round(transform.k * 100)}%
        </button>
        <button onClick={() => zoomBy(1.25)} title="Zoom in">
          +
        </button>
      </div>

      {pending && !svgRef.current && <div className="flow-status">Rendering…</div>}

      {error && (
        <div className="flow-error">
          <span className="flow-error-tag">Mermaid</span>
          <pre>{error}</pre>
        </div>
      )}
    </div>
  )
})

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Mermaid ships the SVG with `width:100%` and a `max-width` sized to the
 * viewport it rendered in. Pinning it to a fixed size instead makes the
 * wrapper's CSS transform the only thing that scales it — otherwise zoom
 * fights with the element's own responsive sizing.
 *
 * The size comes from the drawing's own bounding box rather than mermaid's
 * viewBox: subgraph frames and edge labels routinely spill past that viewBox,
 * and sizing to it clips them off the top of the canvas.
 */
function sizeToIntrinsic(stage: HTMLElement): void {
  const svg = stage.querySelector('svg')
  if (!svg) return

  svg.style.maxWidth = 'none'
  svg.style.display = 'block'

  let box: DOMRect
  try {
    box = svg.getBBox()
  } catch {
    return // not laid out yet; the viewBox mermaid supplied has to do
  }
  if (!box.width || !box.height) return

  const pad = 8
  const width = box.width + pad * 2
  const height = box.height + pad * 2
  svg.setAttribute('viewBox', `${box.x - pad} ${box.y - pad} ${width} ${height}`)
  svg.setAttribute('width', String(width))
  svg.setAttribute('height', String(height))
}

/** Draws the SVG onto a 2× canvas, so a pasted diagram is not a blurry one. */
async function rasterize(svg: string | null, dark: boolean): Promise<string | null> {
  if (!svg) return null
  const size = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/)
  const width = Number(size?.[1]) || 1200
  const height = Number(size?.[2]) || 800
  const scale = 2

  const image = new Image()
  image.width = width
  image.height = height
  const loaded = new Promise<void>((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () => reject(new Error('rasterize failed'))
  })
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`

  try {
    await loaded
  } catch {
    return null
  }

  const canvas = document.createElement('canvas')
  canvas.width = width * scale
  canvas.height = height * scale
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  // Opaque: a transparent PNG pasted into a light-background chat window is
  // unreadable when the diagram was drawn for a dark one.
  ctx.fillStyle = dark ? '#0f1216' : '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.scale(scale, scale)
  ctx.drawImage(image, 0, 0, width, height)
  return canvas.toDataURL('image/png')
}
