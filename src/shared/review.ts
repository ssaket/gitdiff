/**
 * Review comments and rounds — shared by the app, its renderer, and the
 * `gitdiff comments` CLI the agent runs. Dependency-free, like types.ts.
 */

export interface ReviewComment {
  /** Short and stable, so the agent can refer to one. */
  id: string
  /** Repo-relative path of the working-tree file. */
  path: string
  /** 1-based, inclusive, as the lines stood when the comment was written. */
  startLine: number
  endLine: number
  /**
   * The text of those lines when the comment was written. It's how a comment
   * finds its lines again after edits above them move them, and how it knows
   * when they've been rewritten — at which point it's outdated.
   */
  anchor: string
  body: string
  createdAt: number
  /** The round it went to the agent in; null until it's been sent. */
  round: number | null
  resolved: boolean
}

/** A point the reviewer handed work back to the agent — "since round N" diffs from here. */
export interface ReviewRound {
  n: number
  /** The working tree at that moment, as a tree object. */
  tree: string
  at: number
}

export interface ReviewState {
  comments: ReviewComment[]
  rounds: ReviewRound[]
}

export interface LineRange {
  startLine: number
  endLine: number
}

export function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split('\n')
}

/** The text of lines `start`–`end` (1-based, inclusive). */
export function linesOf(text: string, start: number, end: number): string {
  return splitLines(text)
    .slice(start - 1, end)
    .join('\n')
}

/**
 * Where a comment's lines are now, or null once they've been rewritten.
 *
 * The anchor is matched as an exact block. When it occurs more than once — a
 * lone `}` — the occurrence nearest to where the comment was written wins.
 */
export function locate(text: string, comment: Pick<ReviewComment, 'anchor' | 'startLine'>): LineRange | null {
  const lines = splitLines(text)
  const want = splitLines(comment.anchor)
  const n = want.length
  let best = -1
  let bestDistance = Infinity
  for (let i = 0; i + n <= lines.length; i++) {
    if (lines[i] !== want[0]) continue
    let match = true
    for (let k = 1; k < n && match; k++) match = lines[i + k] === want[k]
    if (!match) continue
    const distance = Math.abs(i + 1 - comment.startLine)
    if (distance < bestDistance) {
      best = i
      bestDistance = distance
    }
  }
  return best === -1 ? null : { startLine: best + 1, endLine: best + n }
}

export interface LocatedComment {
  comment: ReviewComment
  /** Where its lines are now; null when they've been rewritten since. */
  at: LineRange | null
}

function lineLabel(r: LineRange): string {
  return r.startLine === r.endLine ? `line ${r.startLine}` : `lines ${r.startLine}–${r.endLine}`
}

/** A code fence longer than any run of backticks inside the snippet. */
function fence(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
  return '`'.repeat(Math.max(3, longest + 1))
}

/**
 * Comments as markdown, for a language model to act on — the same text whether
 * it's copied into a chat or printed by `gitdiff comments`.
 */
export function commentsAsMarkdown(items: LocatedComment[], opts: { intro?: boolean } = {}): string {
  if (items.length === 0) return 'No open review comments.\n'
  const out: string[] = [`# Review comments (${items.length})`, '']
  if (opts.intro) {
    out.push(
      'Here is my review of the changes in the working tree. Address each comment by editing the files — ' +
        "don't commit; I'll review what you change. Run `gitdiff comments` to see these again.",
      ''
    )
  }
  items.forEach(({ comment, at }, i) => {
    const where = at
      ? `${comment.path}, ${lineLabel(at)}`
      : `${comment.path}, was ${lineLabel(comment)} — those lines have changed since; check it's handled`
    const ext = comment.path.includes('.') ? comment.path.slice(comment.path.lastIndexOf('.') + 1) : ''
    const f = fence(comment.anchor)
    out.push(`## ${i + 1}. ${where}  (#${comment.id})`, '', `${f}${ext}`, comment.anchor, f, '', comment.body.trim(), '')
  })
  return out.join('\n')
}

/** Drops anything in a stored review that isn't a shape we can use. */
export function sanitizeReview(value: unknown): ReviewState {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<ReviewState>
  const comments = Array.isArray(raw.comments)
    ? raw.comments.filter(
        (c): c is ReviewComment =>
          !!c &&
          typeof c.id === 'string' &&
          typeof c.path === 'string' &&
          typeof c.startLine === 'number' &&
          typeof c.endLine === 'number' &&
          typeof c.anchor === 'string' &&
          typeof c.body === 'string'
      )
    : []
  const rounds = Array.isArray(raw.rounds)
    ? raw.rounds.filter(
        (r): r is ReviewRound => !!r && typeof r.n === 'number' && typeof r.tree === 'string' && /^[0-9a-f]{40,64}$/.test(r.tree)
      )
    : []
  return {
    comments: comments.map((c) => ({
      ...c,
      createdAt: typeof c.createdAt === 'number' ? c.createdAt : 0,
      round: typeof c.round === 'number' ? c.round : null,
      resolved: c.resolved === true
    })),
    rounds
  }
}
