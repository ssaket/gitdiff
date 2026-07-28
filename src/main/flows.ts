import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { BrowserWindow } from 'electron'
import type { FlowDoc, OpenFlowRequest } from '@shared/types'
import { listFlows, putFlow } from './store'

/** A diagram is text. Anything this big is a mistake — a piped binary, say. */
const MAX_BYTES = 512 * 1024

/** What the CLI hands over: a file of mermaid, or of markdown containing some. */
export interface FlowSpec {
  path: string
  /** `--title`, when the agent bothered to pass one. */
  title: string | null
  /** True when the path is a temp file we wrote from stdin, so ours to delete. */
  ephemeral: boolean
}

interface ParsedFlow {
  title: string | null
  source: string
}

/**
 * Pulls mermaid out of whatever the agent piped in.
 *
 * Agents reach for markdown by reflex, so a ```mermaid fence is at least as
 * likely as bare diagram source — and a written-out explanation may hold
 * several diagrams, each under its own heading. When there are no fences the
 * whole text is taken as one diagram.
 */
export function extractDiagrams(text: string): ParsedFlow[] {
  const fence = /^[ \t]*```+[ \t]*(mermaid|mmd)[ \t]*\r?\n([\s\S]*?)^[ \t]*```+/gim
  const found: ParsedFlow[] = []

  let match: RegExpExecArray | null
  while ((match = fence.exec(text)) !== null) {
    const source = match[2].trim()
    if (source) found.push({ title: headingBefore(text, match.index), source })
  }

  if (found.length > 0) return found

  const source = text.trim()
  return source ? [{ title: null, source }] : []
}

/** The nearest markdown heading above `index`, which titles the fence below it. */
function headingBefore(text: string, index: number): string | null {
  const heads = text.slice(0, index).match(/^#{1,6}[ \t]+(.+)$/gm)
  if (!heads?.length) return null
  return heads[heads.length - 1].replace(/^#+[ \t]+/, '').trim() || null
}

/**
 * A name for the diagram, in descending order of how deliberate it is: the
 * mermaid frontmatter or a `%% title:` comment (things the author wrote *into*
 * the diagram), then the heading it sat under, then the filename, and finally
 * the diagram's own type.
 */
function titleFor(source: string, hints: (string | null)[]): string {
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const declared =
    frontmatter?.[1].match(/^[ \t]*title[ \t]*:[ \t]*(.+)$/m)?.[1] ??
    source.match(/^[ \t]*%%[ \t]*title[ \t]*:?[ \t]*(.+)$/im)?.[1]

  const candidates = [declared, ...hints]
  for (const candidate of candidates) {
    const clean = candidate?.trim().replace(/^["']|["']$/g, '').trim()
    if (clean) return clean
  }
  return 'Untitled flow'
}

/** `~/notes/auth-flow.mmd` → `auth flow`. */
function titleFromPath(file: string): string {
  return path.basename(file).replace(/\.(mmd|mermaid|md|markdown|txt)$/i, '').replace(/[-_]+/g, ' ')
}

export async function createFlow(input: {
  title: string
  source: string
  origin?: string | null
}): Promise<FlowDoc> {
  const now = Date.now()
  return putFlow({
    id: randomUUID(),
    title: input.title,
    source: input.source,
    origin: input.origin ?? null,
    createdAt: now,
    updatedAt: now
  })
}

export async function updateFlow(patch: {
  id: string
  title?: string
  source?: string
}): Promise<FlowDoc> {
  const existing = (await listFlows()).find((f) => f.id === patch.id)
  if (!existing) throw new Error(`No such diagram: ${patch.id}`)
  return putFlow({
    ...existing,
    title: patch.title?.trim() || existing.title,
    source: patch.source ?? existing.source,
    updatedAt: Date.now()
  })
}

/** Reads a file of mermaid (or markdown around it) into stored flows. */
export async function ingestFlowFile(spec: FlowSpec): Promise<FlowDoc[]> {
  const stat = await fs.stat(spec.path)
  if (!stat.isFile()) throw new Error(`Not a file: ${spec.path}`)
  if (stat.size > MAX_BYTES) {
    throw new Error(`Diagram is ${(stat.size / 1024).toFixed(0)} KB — that isn't a mermaid diagram.`)
  }

  const text = await fs.readFile(spec.path, 'utf8')
  if (spec.ephemeral) await fs.rm(spec.path, { force: true })

  const parsed = extractDiagrams(text)
  if (parsed.length === 0) throw new Error('No diagram found — the input was empty.')

  const fileHint = spec.ephemeral ? null : titleFromPath(spec.path)
  const origin = spec.ephemeral ? null : spec.path

  // Stored back-to-front: each new flow goes to the top of the sidebar, so
  // inserting in reverse leaves a multi-diagram document reading in its own
  // order once it's up there.
  const created: FlowDoc[] = []
  for (const flow of [...parsed].reverse()) {
    created.unshift(
      await createFlow({
        title: titleFor(flow.source, [
          // An explicit --title only names the first diagram; the rest keep
          // their own headings rather than all sharing one name.
          parsed.length === 1 ? spec.title : flow.title ?? spec.title,
          fileHint
        ]),
        source: flow.source,
        origin
      })
    )
  }
  return created
}

/**
 * A diagram requested before the UI could receive it — `gitdiff flow` usually
 * launches the app and hands over the diagram in the same breath, so the
 * request lands while the renderer is still booting. Parked here for the
 * renderer to collect on mount, exactly as repo requests are.
 */
let pendingRequest: OpenFlowRequest | null = null

export function consumePendingFlows(): OpenFlowRequest | null {
  const pending = pendingRequest
  pendingRequest = null
  return pending
}

/** Handles a diagram named from outside the UI: the CLI. */
export async function requestOpenFlow(spec: FlowSpec, win: BrowserWindow | null): Promise<void> {
  let payload: OpenFlowRequest
  try {
    payload = { flows: await ingestFlowFile(spec), error: null }
  } catch (e) {
    payload = { flows: [], error: e instanceof Error ? e.message : String(e) }
  }

  pendingRequest = payload
  win?.webContents.send('flow:openRequest', payload)
}
