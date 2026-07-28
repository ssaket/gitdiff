import path from 'node:path'
import type { FlowSpec } from './flows'

const FLOW_FILE = '--gitdiff-flow='
const FLOW_TITLE = '--gitdiff-flow-title='
const FLOW_TEMP = '--gitdiff-flow-temp'

/**
 * Pulls the repository path out of a process argv.
 *
 * Two shapes have to work. A packaged app is invoked as
 * `GitDiff /path/to/repo`, so argv[0] is the executable and everything after is
 * ours. An unpackaged run is `electron . /path/to/repo`, where electron slips
 * the app directory in at argv[1] — which we must not mistake for the target.
 *
 * Chromium switches (`--user-data-dir`, `--no-sandbox`, …) can appear anywhere
 * in either shape and are never paths.
 */
export function firstRepoArg(
  argv: string[],
  opts: { cwd: string; appPath: string }
): string | null {
  const appPath = path.resolve(opts.appPath)

  for (const arg of argv.slice(1)) {
    if (arg.startsWith('-')) continue
    const resolved = path.resolve(opts.cwd, arg)
    // `electron .` resolves argv[1] to the app itself; that's the app being
    // launched, not a repository the user asked for.
    if (resolved === appPath) continue
    return resolved
  }
  return null
}

/**
 * Pulls a `gitdiff flow` request out of a process argv.
 *
 * The diagram travels as a file rather than on the command line: it may be
 * hundreds of lines, and by the time an already-running app is handed these
 * arguments the shell that read them from stdin is long gone. Switch form
 * (`--gitdiff-flow=…`) rather than positional, so `firstRepoArg` above keeps
 * skipping it — a flow request must not also retarget the diff view.
 */
export function flowArg(argv: string[], opts: { cwd: string }): FlowSpec | null {
  let file: string | null = null
  let title: string | null = null
  let ephemeral = false

  for (const arg of argv.slice(1)) {
    if (arg.startsWith(FLOW_FILE)) file = arg.slice(FLOW_FILE.length)
    else if (arg.startsWith(FLOW_TITLE)) title = arg.slice(FLOW_TITLE.length)
    else if (arg === FLOW_TEMP) ephemeral = true
  }

  if (!file) return null
  return { path: path.resolve(opts.cwd, file), title, ephemeral }
}
