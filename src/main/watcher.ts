import path from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'

/** Directories that are never worth watching and are usually huge. */
const NOISY_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.gradle',
  'vendor',
  'Pods'
])

/** Inside .git only these matter — they tell us HEAD moved or the index changed. */
const GIT_FILES_OF_INTEREST = new Set(['HEAD', 'index', 'ORIG_HEAD', 'MERGE_HEAD'])

const DEBOUNCE_MS = 250

function shouldIgnore(root: string, target: string): boolean {
  const rel = path.relative(root, target)
  if (rel === '' || rel.startsWith('..')) return false

  const segments = rel.split(path.sep)
  if (segments[0] === '.git') {
    // Watch the handful of files that signal a HEAD/index move, ignore the rest
    // (loose objects alone would fire thousands of events per commit).
    if (segments.length === 1) return false
    if (segments.length === 2 && GIT_FILES_OF_INTEREST.has(segments[1])) return false
    return true
  }
  return segments.some((s) => NOISY_DIRS.has(s))
}

export class RepoWatcher {
  private watcher: FSWatcher | null = null
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly root: string,
    private readonly onChange: () => void
  ) {}

  start(): void {
    this.stop()
    this.watcher = chokidar.watch(this.root, {
      ignoreInitial: true,
      ignored: (target: string) => shouldIgnore(this.root, target),
      followSymlinks: false,
      // Agents write files in bursts; wait for the dust to settle before reading.
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 40 }
    })
    const bump = (): void => this.schedule()
    this.watcher.on('add', bump).on('change', bump).on('unlink', bump).on('unlinkDir', bump)
    this.watcher.on('error', () => {
      /* transient FS errors during rapid rewrites are expected */
    })
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.onChange()
    }, DEBOUNCE_MS)
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    void this.watcher?.close()
    this.watcher = null
  }
}
