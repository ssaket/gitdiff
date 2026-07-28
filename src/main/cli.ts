import path from 'node:path'

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
