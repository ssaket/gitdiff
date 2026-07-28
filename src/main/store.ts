import { promises as fs } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

interface State {
  recentRepos: string[]
}

const MAX_RECENT = 12
let cached: State | null = null

function file(): string {
  return path.join(app.getPath('userData'), 'state.json')
}

export async function loadState(): Promise<State> {
  if (cached) return cached
  try {
    const raw = await fs.readFile(file(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<State>
    cached = { recentRepos: Array.isArray(parsed.recentRepos) ? parsed.recentRepos : [] }
  } catch {
    cached = { recentRepos: [] }
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
