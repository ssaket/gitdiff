/**
 * `gitdiff comments` — prints the reviewer's open comments for the agent.
 *
 * The shim runs this with ELECTRON_RUN_AS_NODE, so it is plain Node: nothing
 * here (or in what it imports) may touch Electron. Argument 1 is the directory
 * the command was run from; the rest are the user's.
 */
import { readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { commentsAsMarkdown, type LocatedComment } from '@shared/review'
import { gitLine } from './git'
import { loadReview, locateOpen } from './review'

const USAGE = `gitdiff comments — the review comments left in GitDiff, for your agent

Usage:
  gitdiff comments [path]   Open comments as markdown, optionally for one file
  gitdiff comments --json   The same, as JSON
  gitdiff comments --hook   For a Claude Code UserPromptSubmit hook: reads the
                            event on stdin, and prints the comments only when
                            the prompt is about the review (else nothing)
`

/** A prompt that's about the review — "address the review", "fix my comments", "feedback". */
const ABOUT_REVIEW = /\b(review|comments?|feedback|gitdiff)\b/i

function hookContext(located: LocatedComment[]): string {
  return (
    'Open review comments left in GitDiff on this working tree (what `gitdiff comments` prints). ' +
    "If the user's message is about this review, address each comment by editing the files, " +
    "don't commit, and say what you did for each one (by its #id).\n\n" +
    commentsAsMarkdown(located)
  )
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  let cwd = argv[0] ?? process.cwd()
  const args = argv.slice(1)
  if (args.includes('-h') || args.includes('--help')) {
    process.stdout.write(USAGE)
    return 0
  }
  const json = args.includes('--json')
  const hook = args.includes('--hook')
  const target = args.find((a) => !a.startsWith('-'))

  // As a hook, Claude Code hands over the event as JSON on stdin: the prompt
  // decides whether to say anything, and its cwd is the project.
  let prompt = ''
  if (hook) {
    try {
      const event = JSON.parse(readFileSync(0, 'utf8')) as { prompt?: unknown; cwd?: unknown }
      if (typeof event.prompt === 'string') prompt = event.prompt
      if (typeof event.cwd === 'string' && event.cwd) cwd = event.cwd
    } catch {
      // no event, or not JSON: nothing to go on, so stay quiet
    }
    if (!ABOUT_REVIEW.test(prompt)) return 0
  }

  let root: string
  try {
    root = await gitLine(cwd, ['rev-parse', '--show-toplevel'])
  } catch {
    if (hook) return 0
    process.stderr.write('gitdiff comments: not inside a git repository\n')
    return 1
  }

  // git reports the toplevel with symlinks resolved (/private/tmp, not /tmp),
  // while the shell hands over its logical cwd; resolve that too, or a path
  // given under a symlinked directory would match nothing.
  let physicalCwd = cwd
  try {
    physicalCwd = realpathSync(cwd)
  } catch {
    // a vanished cwd: git would have failed above anyway
  }
  const onlyPath = target ? path.relative(root, path.resolve(physicalCwd, target)) : undefined
  const located = await locateOpen(root, await loadReview(root), onlyPath)

  if (hook) {
    // stdout from a UserPromptSubmit hook becomes context for the model.
    if (located.length > 0) process.stdout.write(hookContext(located))
    return 0
  }

  if (json) {
    const out = located.map(({ comment, at }) => ({
      id: comment.id,
      path: comment.path,
      startLine: at?.startLine ?? null,
      endLine: at?.endLine ?? null,
      outdated: at === null,
      lines: comment.anchor,
      comment: comment.body
    }))
    process.stdout.write(JSON.stringify(out, null, 2) + '\n')
  } else {
    process.stdout.write(commentsAsMarkdown(located))
  }
  return 0
}

// exitCode rather than exit(): on macOS, writes to a pipe are asynchronous,
// and exit() would cut off a long review before the agent reading the pipe
// got all of it. Nothing else keeps the process alive, so it ends once flushed.
main().then(
  (code) => {
    process.exitCode = code
  },
  (e) => {
    // A hook that fails loudly gets in the way of every prompt; as a hook, fail quietly.
    if (process.argv.includes('--hook')) return
    process.stderr.write(`gitdiff comments: ${e instanceof Error ? e.message : String(e)}\n`)
    process.exitCode = 1
  }
)
