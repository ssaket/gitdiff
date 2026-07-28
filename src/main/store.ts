import { promises as fs } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { FlowDoc } from '@shared/types'

interface State {
  recentRepos: string[]
  flows: FlowDoc[]
}

const MAX_RECENT = 12
const MAX_FLOWS = 60
let cached: State | null = null

function file(): string {
  return path.join(app.getPath('userData'), 'state.json')
}

/** Drops anything in the on-disk list that isn't a shape we can render. */
function sanitizeFlows(value: unknown): FlowDoc[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (f): f is FlowDoc =>
      !!f &&
      typeof f === 'object' &&
      typeof (f as FlowDoc).id === 'string' &&
      typeof (f as FlowDoc).title === 'string' &&
      typeof (f as FlowDoc).source === 'string'
  )
}

export async function loadState(): Promise<State> {
  if (cached) return cached
  try {
    const raw = await fs.readFile(file(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<State>
    cached = {
      recentRepos: Array.isArray(parsed.recentRepos) ? parsed.recentRepos : [],
      flows: sanitizeFlows(parsed.flows)
    }
  } catch {
    cached = { recentRepos: [], flows: [] }
  }
  return cached
}

async function save(): Promise<void> {
  if (!cached) return
  await fs.mkdir(path.dirname(file()), { recursive: true })
  await fs.writeFile(file(), JSON.stringify(cached, null, 2))
}

export async function rememberRepo(root: string): Promise<void> {
  const state = await loadState()
  state.recentRepos = [root, ...state.recentRepos.filter((r) => r !== root)].slice(0, MAX_RECENT)
  await save()
}

export async function forgetRepo(root: string): Promise<void> {
  const state = await loadState()
  state.recentRepos = state.recentRepos.filter((r) => r !== root)
  await save()
}

/** Newest first — the order the flows sidebar shows them in. */
export async function listFlows(): Promise<FlowDoc[]> {
  return (await loadState()).flows
}

/**
 * Insert or update. New flows go to the front; an existing one keeps its place,
 * since having the list reshuffle under the cursor while you edit a diagram is
 * worse than having the newest one occasionally sit further down.
 */
export async function putFlow(flow: FlowDoc): Promise<FlowDoc> {
  const state = await loadState()
  const at = state.flows.findIndex((f) => f.id === flow.id)
  if (at === -1) state.flows = [flow, ...state.flows].slice(0, MAX_FLOWS)
  else state.flows[at] = flow
  await save()
  return flow
}

export async function removeFlow(id: string): Promise<void> {
  const state = await loadState()
  state.flows = state.flows.filter((f) => f.id !== id)
  await save()
}

/** Recent repos, minus any that have since been moved or deleted. */
export async function listRecentRepos(): Promise<{ root: string; name: string }[]> {
  const state = await loadState()
  const alive = await Promise.all(
    state.recentRepos.map(async (root) => {
      const ok = await fs
        .stat(path.join(root, '.git'))
        .then(() => true)
        .catch(() => false)
      return ok ? { root, name: path.basename(root) } : null
    })
  )
  return alive.filter((r): r is { root: string; name: string } => r !== null)
}
