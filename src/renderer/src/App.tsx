import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  Baseline,
  BranchInfo,
  ChangeSet,
  FileChange,
  FileDiff,
  FlowDoc,
  OpenFlowRequest,
  PrLookup,
  PublishResult,
  RepoInfo
} from '@shared/types'
import type { ReviewComment, ReviewState } from '@shared/review'
import { DiffView, type CommentActions, type DiffViewHandle, type NewComment } from './components/DiffView'
import { FileList } from './components/FileList'
import { FlowsPane } from './components/FlowsPane'
import { PrSheet } from './components/PrSheet'
import { Toolbar, type Tab } from './components/Toolbar'
import { Welcome } from './components/Welcome'
import { errorText } from './util'

/** What a hand-written diagram starts as, so the canvas is never blank. */
const NEW_FLOW = `flowchart TD
  A[Start] --> B{Works?}
  B -- yes --> C[Ship it]
  B -- no --> D[Fix it]
  D --> B
`

/**
 * Reviewed marks are pinned to *what the file looked like* when you ticked it.
 * If the agent touches it again the signature moves and the tick clears itself,
 * which is the whole point — you want to be told when something you already
 * signed off on has changed underneath you.
 */
function signatureOf(f: FileChange): string {
  return `${f.status}:${f.additions}:${f.deletions}:${f.untracked}`
}

/**
 * A file edited in the diff view and not yet saved. Its text lives in a ref
 * (draftTextRef), not here: state changes only when a file becomes dirty or
 * clean, so typing doesn't re-render the whole app on every key.
 */
interface Draft {
  /** What the file held on disk when editing began — to notice the agent writing it meanwhile. */
  base: string
}

const EMPTY_REVIEW: ReviewState = { comments: [], rounds: [] }
const NO_COMMENTS: ReviewComment[] = []

function newCommentId(existing: ReviewComment[]): string {
  const taken = new Set(existing.map((c) => c.id))
  let id = ''
  do id = Math.random().toString(16).slice(2, 8)
  while (id.length < 6 || taken.has(id))
  return id
}

/** The whole PR when there's a base to measure it from; otherwise just what's uncommitted. */
function allChanges(base: string | null): Baseline {
  return base ? { kind: 'branch', base } : { kind: 'worktree' }
}

/** Finishes the Discard dialog's "It goes back to how it was …". */
function discardWhere(baseline: Baseline): string {
  if (baseline.kind === 'branch') return `on ${baseline.base}`
  if (baseline.kind === 'snapshot') return `at the start of ${baseline.label ?? 'the round'}`
  return 'at the last commit'
}

function useDarkMode(): boolean {
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e: MediaQueryListEvent): void => setDark(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return dark
}

export function App(): JSX.Element {
  const dark = useDarkMode()

  const [repo, setRepo] = useState<RepoInfo | null>(null)
  const [baseline, setBaseline] = useState<Baseline>({ kind: 'worktree' })
  const [files, setFiles] = useState<FileChange[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [diff, setDiff] = useState<FileDiff | null>(null)
  const [reviewedSigs, setReviewedSigs] = useState<Record<string, string>>({})
  const [filter, setFilter] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [stale, setStale] = useState(false)

  const [autoRefresh, setAutoRefresh] = useState(true)
  const [sideBySide, setSideBySide] = useState(true)
  const [collapseUnchanged, setCollapseUnchanged] = useState(true)
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false)

  const [branch, setBranch] = useState<BranchInfo | null>(null)
  const [prBase, setPrBase] = useState<string | null>(null)
  const [prLookup, setPrLookup] = useState<PrLookup | null>(null)
  const [prSheetOpen, setPrSheetOpen] = useState(false)
  const [notice, setNotice] = useState<{ text: string; url: string | null } | null>(null)
  const [review, setReview] = useState<ReviewState>(EMPTY_REVIEW)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  // Bumped to make the diff view drop the edits it's showing and take the file's text.
  const [resetKey, setResetKey] = useState(0)
  const [reveal, setReveal] = useState<{ path: string; line: number } | null>(null)
  const [scanToken, setScanToken] = useState(0)
  // Remembered across commits, so stepping through them keeps the same view.
  const [commitCumulative, setCommitCumulative] = useState(false)

  const [tab, setTab] = useState<Tab>('review')
  const [flows, setFlows] = useState<FlowDoc[]>([])
  const [selectedFlow, setSelectedFlow] = useState<string | null>(null)
  const [showFlowSource, setShowFlowSource] = useState(false)

  const diffViewRef = useRef<DiffViewHandle>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  const scanTokenRef = useRef(0)
  const diffTokenRef = useRef(0)
  const flowsRef = useRef(flows)
  flowsRef.current = flows
  const flowSaveTimers = useRef(new Map<string, number>())
  const prBaseRef = useRef(prBase)
  prBaseRef.current = prBase
  const reviewRef = useRef(review)
  const draftsRef = useRef(drafts)
  draftsRef.current = drafts
  /** The current text of every dirty file, kept up to date on each keystroke. */
  const draftTextRef = useRef(new Map<string, string>())
  const diffRef = useRef(diff)
  diffRef.current = diff

  const reviewed = useMemo(() => {
    const set = new Set<string>()
    for (const f of files) if (reviewedSigs[f.path] === signatureOf(f)) set.add(f.path)
    return set
  }, [files, reviewedSigs])

  // ---------------------------------------------------------------- scanning

  const refresh = useCallback(
    async (root: string, base: Baseline) => {
      const token = ++scanTokenRef.current
      setBusy(true)
      try {
        // Branch info rides along with every scan: the agent committing is
        // exactly when the commit list in the scope menu should grow.
        const [result, info]: [ChangeSet, BranchInfo | null] = await Promise.all([
          window.gitdiff.listChanges(root, base),
          window.gitdiff.branchInfo(root, prBaseRef.current ?? undefined).catch(() => null)
        ])
        if (token !== scanTokenRef.current) return // a newer scan already landed
        setFiles(result.files)
        setRepo(result.repo)
        if (info) setBranch(info)
        setScanToken((t) => t + 1)
        setError(null)
        setStale(false)
        setSelected((current) => {
          if (current && result.files.some((f) => f.path === current)) return current
          return result.files[0]?.path ?? null
        })
      } catch (e) {
        if (token === scanTokenRef.current) setError(errorText(e))
      } finally {
        if (token === scanTokenRef.current) setBusy(false)
      }
    },
    []
  )

  useEffect(() => {
    if (!repo) return
    void refresh(repo.root, baseline)
    // `repo.root` rather than `repo`: refresh() replaces the repo object each
    // time, and depending on the object itself would loop forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo?.root, baseline, refresh])

  useEffect(() => {
    if (!repo) return
    void window.gitdiff.startWatching(repo.root)
    return () => void window.gitdiff.stopWatching()
  }, [repo?.root])

  const autoRefreshRef = useRef(autoRefresh)
  autoRefreshRef.current = autoRefresh

  useEffect(() => {
    if (!repo) return
    return window.gitdiff.onRepoChanged((root) => {
      if (root !== repo.root) return
      if (autoRefreshRef.current) void refresh(root, baseline)
      else setStale(true)
    })
  }, [repo?.root, baseline, refresh])

  // Asking GitHub is a network round trip, so only when the branch changes —
  // opening a repo, the agent switching branches, or a publish creating one.
  useEffect(() => {
    if (!repo) return
    let cancelled = false
    void window.gitdiff
      .lookupPr(repo.root)
      .then((result) => !cancelled && setPrLookup(result))
      .catch((e) => !cancelled && setPrLookup({ pr: null, ghError: errorText(e) }))
    return () => {
      cancelled = true
    }
  }, [repo?.root, repo?.branch])

  // ------------------------------------------------------------ diff loading

  const selectedFile = useMemo(() => files.find((f) => f.path === selected) ?? null, [files, selected])
  const selectedSig = selectedFile ? signatureOf(selectedFile) : null

  useEffect(() => {
    if (!repo || !selectedFile) {
      setDiff(null)
      return
    }
    const token = ++diffTokenRef.current
    void window.gitdiff
      .loadDiff(repo.root, baseline, selectedFile)
      .then((d) => {
        if (token === diffTokenRef.current) setDiff(d)
      })
      .catch((e) => {
        if (token === diffTokenRef.current) setError(errorText(e))
      })
    // selectedSig is in the deps so an agent re-editing the open file reloads it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo?.root, baseline, selected, selectedSig])

  // ---------------------------------------------------------------- actions

  const applyRepo = useCallback(async (info: RepoInfo) => {
    const unsaved = Object.keys(draftsRef.current).length
    if (unsaved && !window.confirm(`Discard unsaved edits in ${unsaved} file${unsaved === 1 ? '' : 's'}?`)) return
    // Branch info first, so the very first scan is already the whole-PR view
    // rather than a flash of "uncommitted" followed by a second scan.
    let next: BranchInfo | null = null
    try {
      next = await window.gitdiff.branchInfo(info.root)
    } catch {
      // Reviewing still works without it; there's just no PR framing.
    }
    const loaded = await window.gitdiff.loadReview(info.root).catch(() => EMPTY_REVIEW)
    reviewRef.current = loaded
    setReview(loaded)
    setDrafts({})
    draftTextRef.current.clear()
    setBranch(next)
    setPrBase(next?.base ?? null)
    setPrLookup(null)
    setNotice(null)
    setRepo(info)
    setBaseline(allChanges(next?.base ?? null))
    setReviewedSigs({})
    setSelected(null)
    setError(null)
  }, [])

  const openRepo = useCallback(
    async (dir: string) => {
      try {
        await applyRepo(await window.gitdiff.openRepo(dir))
      } catch (e) {
        setError(errorText(e))
      }
    },
    [applyRepo]
  )

  const pickRepo = useCallback(async () => {
    try {
      const picked = await window.gitdiff.pickRepo()
      if (picked) await applyRepo(picked)
    } catch (e) {
      setError(errorText(e))
    }
  }, [applyRepo])

  // `gitdiff ~/project` from a terminal, or a folder dropped on the dock icon.
  // The request may have arrived before this component existed, so collect any
  // parked one as well as subscribing for later ones.
  useEffect(() => {
    const handle = (request: { repo: RepoInfo | null; error: string | null }): void => {
      if (request.repo) void applyRepo(request.repo)
      else if (request.error) setError(request.error)
    }
    void window.gitdiff.consumePendingRepo().then((pending) => {
      if (pending) handle(pending)
    })
    return window.gitdiff.onOpenRepoRequest(handle)
  }, [applyRepo])

  // ------------------------------------------------------------------ flows

  useEffect(() => {
    void window.gitdiff.listFlows().then((list) => {
      setFlows(list)
      setSelectedFlow((current) => current ?? list[0]?.id ?? null)
    })
  }, [])

  // `gitdiff flow` from the agent's shell. Same shape as the repo request: it
  // may have arrived before this component existed, so collect the parked one
  // as well as subscribing for later ones.
  useEffect(() => {
    const handle = (request: OpenFlowRequest): void => {
      if (request.error) {
        setError(request.error)
        return
      }
      if (request.flows.length === 0) return
      const incoming = new Set(request.flows.map((f) => f.id))
      setFlows((prev) => [...request.flows, ...prev.filter((f) => !incoming.has(f.id))])
      setSelectedFlow(request.flows[0].id)
      setTab('flows')
    }
    void window.gitdiff.consumePendingFlows().then((pending) => {
      if (pending) handle(pending)
    })
    return window.gitdiff.onFlowRequest(handle)
  }, [])

  /**
   * Edits land in state immediately and are written back on a delay — typing in
   * the source pane would otherwise rewrite the whole store on every keystroke.
   * The timer saves whatever the flow looks like when it fires rather than the
   * patch that scheduled it, so a title edit is never lost behind a later one
   * to the source.
   */
  const changeFlow = useCallback((id: string, patch: { title?: string; source?: string }) => {
    setFlows((prev) =>
      prev.map((f) => (f.id === id ? { ...f, ...patch, updatedAt: Date.now() } : f))
    )

    const timers = flowSaveTimers.current
    window.clearTimeout(timers.get(id))
    timers.set(
      id,
      window.setTimeout(() => {
        timers.delete(id)
        const current = flowsRef.current.find((f) => f.id === id)
        if (!current) return
        void window.gitdiff
          .updateFlow({ id, title: current.title, source: current.source })
          .catch((e) => setError(errorText(e)))
      }, 400)
    )
  }, [])

  const newFlow = useCallback(async () => {
    try {
      const flow = await window.gitdiff.createFlow('Untitled flow', NEW_FLOW)
      setFlows((prev) => [flow, ...prev])
      setSelectedFlow(flow.id)
      setShowFlowSource(true)
      setTab('flows')
    } catch (e) {
      setError(errorText(e))
    }
  }, [])

  const deleteFlow = useCallback(
    async (id: string) => {
      try {
        await window.gitdiff.deleteFlow(id)
        const remaining = flows.filter((f) => f.id !== id)
        setFlows(remaining)
        if (selectedFlow === id) {
          // Land on the neighbour rather than the top of the list.
          const at = flows.findIndex((f) => f.id === id)
          setSelectedFlow(remaining[Math.min(at, remaining.length - 1)]?.id ?? null)
        }
      } catch (e) {
        setError(errorText(e))
      }
    },
    [flows, selectedFlow]
  )

  const stepFlow = useCallback(
    (delta: number) => {
      if (flows.length === 0) return
      const index = flows.findIndex((f) => f.id === selectedFlow)
      const next = flows[Math.min(flows.length - 1, Math.max(0, index + delta))]
      if (next) setSelectedFlow(next.id)
    },
    [flows, selectedFlow]
  )

  // ------------------------------------------------------- review comments

  /** Applies a change to the review and writes it to .git/gitdiff/review.json. */
  const updateReview = useCallback(
    (change: (prev: ReviewState) => ReviewState) => {
      if (!repo) return
      const next = change(reviewRef.current)
      reviewRef.current = next
      setReview(next)
      void window.gitdiff.saveReview(repo.root, next).catch((e) => setError(errorText(e)))
    },
    [repo]
  )

  const commentActions: CommentActions = useMemo(
    () => ({
      add: (c: NewComment) =>
        updateReview((r) => ({
          ...r,
          comments: [
            ...r.comments,
            { ...c, id: newCommentId(r.comments), createdAt: Date.now(), round: null, resolved: false }
          ]
        })),
      update: (id, body) =>
        updateReview((r) => ({ ...r, comments: r.comments.map((c) => (c.id === id ? { ...c, body } : c)) })),
      resolve: (id) =>
        updateReview((r) => ({
          ...r,
          comments: r.comments.map((c) => (c.id === id ? { ...c, resolved: true } : c))
        })),
      remove: (id) => updateReview((r) => ({ ...r, comments: r.comments.filter((c) => c.id !== id) }))
    }),
    [updateReview]
  )

  const openComments = useMemo(() => review.comments.filter((c) => !c.resolved), [review])
  const resolvedCount = review.comments.length - openComments.length
  const fileComments = useMemo(
    () => openComments.filter((c) => c.path === diff?.path),
    [openComments, diff?.path]
  )
  const commentCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const c of openComments) counts.set(c.path, (counts.get(c.path) ?? 0) + 1)
    return counts
  }, [openComments])

  /** Snapshot the worktree now, and show only what changes after it. Returns the round's number. */
  const startRound = useCallback(async (): Promise<number | null> => {
    if (!repo) return null
    try {
      const tree = await window.gitdiff.markSnapshot(repo.root)
      const rounds = reviewRef.current.rounds
      const n = (rounds[rounds.length - 1]?.n ?? 0) + 1
      // The trees are unreferenced objects that gc eventually prunes, so
      // there's no point keeping more than a handful.
      updateReview((r) => ({ ...r, rounds: [...r.rounds, { n, tree, at: Date.now() }].slice(-20) }))
      setReviewedSigs({})
      setBaseline({ kind: 'snapshot', ref: tree, label: `round ${n}` })
      return n
    } catch (e) {
      setError(errorText(e))
      return null
    }
  }, [repo, updateReview])

  const copyComments = useCallback(async () => {
    if (!repo) return
    try {
      await window.gitdiff.copyText(await window.gitdiff.reviewPrompt(repo.root))
      setNotice({ text: 'Copied the open comments as a prompt for your agent.', url: null })
    } catch (e) {
      setError(errorText(e))
    }
  }, [repo])

  /**
   * Hands the comments back to the agent: a new round starts — so from here
   * you see only what it changes in response — and the comments go on the
   * clipboard to paste into its chat.
   */
  const sendComments = useCallback(async () => {
    if (!repo) return
    if (Object.keys(draftsRef.current).length) {
      setError("Save or revert your edits first — the agent only sees what's on disk.")
      return
    }
    try {
      const prompt = await window.gitdiff.reviewPrompt(repo.root)
      const n = await startRound()
      if (n === null) return
      updateReview((r) => ({
        ...r,
        comments: r.comments.map((c) => (!c.resolved && c.round === null ? { ...c, round: n } : c))
      }))
      await window.gitdiff.copyText(prompt)
      setNotice({
        text:
          `Round ${n} started and the comments are on your clipboard — paste them to your agent ` +
          '(it can also run `gitdiff comments`). You are now seeing only what changes from here.',
        url: null
      })
    } catch (e) {
      setError(errorText(e))
    }
  }, [repo, startRound, updateReview])

  const jumpToComment = useCallback(
    (path: string, line: number) => {
      setTab('review')
      // Comments live on the working tree, which a commit view doesn't show;
      // and the file may not be part of a narrower scope at all.
      if (baseline.kind === 'commit' || !files.some((f) => f.path === path)) {
        setReviewedSigs({})
        setBaseline(allChanges(prBase))
      }
      setSelected(path)
      setReveal({ path, line })
    },
    [baseline.kind, files, prBase]
  )

  // ------------------------------------------------------------------ edits

  // A commit view shows history, which isn't editable; every other scope's
  // right-hand side is the file on disk.
  const afterIsWorktree = baseline.kind !== 'commit'
  // Main decides whether the file can be saved back exactly (a regular UTF-8
  // file on disk); here only whether the view is the working tree at all.
  const editable =
    !!diff && diff.payload.kind === 'text' && diff.payload.editable && afterIsWorktree && diff.path === selected
  const draft = diff ? drafts[diff.path] : undefined
  const conflict = !!draft && diff?.payload.kind === 'text' && diff.payload.modified !== draft.base
  const hasDraft = !!draft

  /**
   * What the diff view shows: the file with your unsaved edits in place. The
   * draft's text only matters when the editor (re)builds the file — switching
   * back to it, or a reset — so it's read through a ref rather than making
   * every keystroke produce a new diff object.
   */
  const shownDiff = useMemo(() => {
    if (!diff || diff.payload.kind !== 'text' || !afterIsWorktree) return diff
    const text = draftsRef.current[diff.path] ? draftTextRef.current.get(diff.path) : undefined
    return text !== undefined ? { ...diff, payload: { ...diff.payload, modified: text } } : diff
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diff, afterIsWorktree, hasDraft, resetKey])

  const dropDraft = (path: string): void => {
    draftTextRef.current.delete(path)
    setDrafts((prev) => {
      if (!prev[path]) return prev
      const { [path]: _gone, ...rest } = prev
      return rest
    })
  }

  /**
   * Called on every keystroke, so it does as little as it can: the text goes
   * into a ref, and state is touched only when the file turns dirty or clean.
   */
  const onEdit = useCallback((path: string, text: string) => {
    const existing = draftsRef.current[path]
    const raw = diffRef.current
    const base = existing?.base ?? (raw?.path === path && raw.payload.kind === 'text' ? raw.payload.modified : text)
    if (text === base) {
      // Back to what's on disk — undone, or a hunk reverted and re-applied.
      dropDraft(path)
      return
    }
    draftTextRef.current.set(path, text)
    if (!existing) setDrafts((prev) => (prev[path] ? prev : { ...prev, [path]: { base } }))
  }, [])

  const saveFile = useCallback(
    async (path: string): Promise<boolean> => {
      const d = draftsRef.current[path]
      const text = draftTextRef.current.get(path)
      if (!repo || !d || text === undefined) return true
      try {
        if (!(await window.gitdiff.writeFile(repo.root, path, text, d.base))) return false
        if (draftTextRef.current.get(path) === text) {
          dropDraft(path)
        } else {
          // Typed more while it saved: still unsaved, but measured from what's on disk now.
          setDrafts((prev) => (prev[path] ? { ...prev, [path]: { base: text } } : prev))
        }
        // Show the saved text as the file's content straight away, rather than
        // the pre-save copy until the watcher's rescan lands.
        setDiff((prev) =>
          prev && prev.path === path && prev.payload.kind === 'text'
            ? { ...prev, payload: { ...prev.payload, modified: text } }
            : prev
        )
        return true
      } catch (e) {
        setError(errorText(e))
        return false
      }
    },
    [repo]
  )

  const saveAll = useCallback(async (): Promise<boolean> => {
    for (const path of Object.keys(draftsRef.current)) {
      if (!(await saveFile(path))) return false
    }
    return true
  }, [saveFile])

  const revertEdits = useCallback((path: string) => {
    dropDraft(path)
    setResetKey((k) => k + 1)
  }, [])

  // Closing, quitting or reloading with unsaved edits: refuse, and the main
  // process asks whether to throw them away.
  useEffect(() => {
    if (Object.keys(drafts).length === 0) return
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      e.preventDefault()
      e.returnValue = false
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [drafts])

  const changeBaseline = useCallback((next: Baseline) => {
    setReviewedSigs({})
    setBaseline(next)
  }, [])

  const changeBase = useCallback(
    (base: string) => {
      setPrBase(base)
      setReviewedSigs({})
      setBaseline((b) => (b.kind === 'branch' || b.kind === 'commit' ? { ...b, base } : b))
      if (repo) {
        void window.gitdiff
          .branchInfo(repo.root, base)
          .then(setBranch)
          .catch((e) => setError(errorText(e)))
      }
    },
    [repo]
  )

  const onBranchCommit =
    baseline.kind === 'commit' && !!branch?.commits.some((c) => c.sha === baseline.ref)

  const setCumulative = useCallback(
    (cumulative: boolean) => {
      setCommitCumulative(cumulative)
      if (baseline.kind === 'commit') {
        changeBaseline({ ...baseline, cumulative, base: prBase ?? undefined })
      }
    },
    [baseline, prBase, changeBaseline]
  )

  /**
   * ⌥j / ⌥k: walk the branch's commits, newest at the top. Above the newest is
   * what's uncommitted — or, viewing cumulatively, the whole PR, which is
   * simply "up to here" for the working tree.
   */
  const stepCommit = useCallback(
    (delta: 1 | -1) => {
      const commits = branch?.commits ?? []
      let at: number
      if (baseline.kind === 'commit') {
        at = commits.findIndex((c) => c.sha === baseline.ref)
        if (at === -1) return // an older commit, off the branch
      } else if (baseline.kind === 'worktree' || baseline.kind === 'branch') {
        at = -1
      } else {
        return
      }
      const next = at + delta
      if (next < -1 || next >= commits.length) return
      if (next === -1) {
        changeBaseline(commitCumulative ? allChanges(prBase) : { kind: 'worktree' })
        return
      }
      const c = commits[next]
      changeBaseline({
        kind: 'commit',
        ref: c.sha,
        label: c.subject,
        cumulative: commitCumulative && !!prBase,
        base: prBase ?? undefined
      })
    },
    [branch, baseline, commitCumulative, prBase, changeBaseline]
  )

  const onPublished = useCallback(
    (result: PublishResult) => {
      setPrSheetOpen(false)
      setPrLookup({ pr: result.pr, ghError: null })
      const what = result.pr ? `PR #${result.pr.number}` : 'the PR'
      setNotice({
        text:
          `${result.created ? 'Opened' : 'Updated'} ${what} from ${result.branch}.` +
          (result.warning ? ` ${result.warning}` : ''),
        url: result.url
      })
      // A squash replaces the branch's commits, so whatever commit was open
      // may no longer be on it. Back to the whole PR, which also rescans.
      changeBaseline(allChanges(prBase))
    },
    [prBase, changeBaseline]
  )

  const toggleReviewed = useCallback(
    (path: string) => {
      const file = files.find((f) => f.path === path)
      if (!file) return
      setReviewedSigs((prev) => {
        const next = { ...prev }
        if (next[path] === signatureOf(file)) delete next[path]
        else next[path] = signatureOf(file)
        return next
      })
    },
    [files]
  )

  const step = useCallback(
    (delta: number) => {
      if (files.length === 0) return
      const index = files.findIndex((f) => f.path === selected)
      const next = files[Math.min(files.length - 1, Math.max(0, index + delta))]
      if (next) setSelected(next.path)
    },
    [files, selected]
  )

  const fileAction = useCallback(
    async (action: 'discard' | 'reveal' | 'open') => {
      if (!repo || !selectedFile) return
      try {
        const { root } = repo
        const p = selectedFile.path
        if (action === 'discard') {
          const discarded = await window.gitdiff.discardFile(root, baseline, selectedFile, discardWhere(baseline))
          if (discarded && draftsRef.current[p]) revertEdits(p)
        } else if (action === 'reveal') await window.gitdiff.revealFile(root, p)
        else await window.gitdiff.openFile(root, p)

        if (action === 'discard') await refresh(root, baseline)
      } catch (e) {
        setError(errorText(e))
      }
    },
    [repo, selectedFile, baseline, refresh, revertEdits]
  )

  // -------------------------------------------------------------- shortcuts

  // With no repo open there is nothing to review, so the diagrams are all there
  // is to show — `gitdiff flow` in a directory that isn't a repo still works.
  const activeTab: Tab = repo ? tab : 'flows'

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // The sheet handles its own keys; nothing behind it should move.
      if (prSheetOpen) return
      const target = e.target as HTMLElement | null
      const typing =
        target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable
      const mod = e.metaKey || e.ctrlKey

      if (mod && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        void pickRepo()
        return
      }
      if (e.key === 'Escape' && typing) {
        ;(target as HTMLInputElement).blur()
        return
      }
      if (mod && (e.key === '1' || e.key === '2')) {
        e.preventDefault()
        if (e.key === '2') setTab('flows')
        else if (repo) setTab('review')
        return
      }

      if (activeTab === 'flows') {
        if (mod && e.key.toLowerCase() === 'e') {
          e.preventDefault()
          setShowFlowSource((v) => !v)
          return
        }
        if (typing || mod) return
        if (e.key === 'j' || e.key === 'ArrowDown') {
          e.preventDefault()
          stepFlow(1)
        } else if (e.key === 'k' || e.key === 'ArrowUp') {
          e.preventDefault()
          stepFlow(-1)
        }
        return
      }

      if (!repo) return

      if (mod && e.key.toLowerCase() === 'r') {
        e.preventDefault()
        void refresh(repo.root, baseline)
        return
      }
      if (mod && e.key.toLowerCase() === 'm') {
        e.preventDefault()
        void startRound()
        return
      }
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (selected && draftsRef.current[selected]) void saveFile(selected)
        return
      }
      // e.code, not e.key: on a Mac, ⌥J types "∆".
      if (e.altKey && !mod && !typing && (e.code === 'KeyJ' || e.code === 'KeyK')) {
        e.preventDefault()
        stepCommit(e.code === 'KeyJ' ? 1 : -1)
        return
      }
      if (mod && e.key === '\\') {
        e.preventDefault()
        setSideBySide((v) => !v)
        return
      }
      if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        filterRef.current?.focus()
        filterRef.current?.select()
        return
      }
      if (typing || mod) return

      switch (e.key) {
        case 'j':
        case 'ArrowDown':
          e.preventDefault()
          step(1)
          break
        case 'k':
        case 'ArrowUp':
          e.preventDefault()
          step(-1)
          break
        case 'n':
        case ']':
          e.preventDefault()
          diffViewRef.current?.goToDiff('next')
          break
        case 'p':
        case '[':
          e.preventDefault()
          diffViewRef.current?.goToDiff('previous')
          break
        case ' ':
          if (selected) {
            e.preventDefault()
            toggleReviewed(selected)
            step(1)
          }
          break
        case '/':
          e.preventDefault()
          filterRef.current?.focus()
          break
        case 'c':
          e.preventDefault()
          diffViewRef.current?.openComposer()
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    repo,
    baseline,
    selected,
    step,
    toggleReviewed,
    refresh,
    startRound,
    stepCommit,
    saveFile,
    pickRepo,
    activeTab,
    stepFlow,
    prSheetOpen
  ])

  // ------------------------------------------------------------------ render

  if (!repo && flows.length === 0) {
    return <Welcome onPick={pickRepo} onOpen={openRepo} error={error} />
  }

  const totals = files.reduce(
    (acc, f) => ({ add: acc.add + f.additions, del: acc.del + f.deletions }),
    { add: 0, del: 0 }
  )

  return (
    <div
      className="app"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        const file = e.dataTransfer.files[0]
        if (file) void openRepo(window.gitdiff.pathForFile(file))
      }}
    >
      <Toolbar
        repo={repo}
        tab={activeTab}
        onTabChange={setTab}
        flowCount={flows.length}
        baseline={baseline}
        onBaselineChange={changeBaseline}
        branch={branch}
        base={prBase}
        onBaseChange={changeBase}
        rounds={review.rounds}
        onStartRound={() => void startRound()}
        comments={openComments}
        resolvedCount={resolvedCount}
        scanToken={scanToken}
        onJumpToComment={jumpToComment}
        onResolveComment={commentActions.resolve}
        onCopyComments={() => void copyComments()}
        onSendComments={() => void sendComments()}
        onClearResolved={() => updateReview((r) => ({ ...r, comments: r.comments.filter((c) => !c.resolved) }))}
        commitCumulative={commitCumulative}
        pr={prLookup}
        onOpenPrSheet={() => setPrSheetOpen(true)}
        onPickRepo={pickRepo}
        onRefresh={() => repo && void refresh(repo.root, baseline)}
        autoRefresh={autoRefresh}
        onAutoRefreshChange={setAutoRefresh}
        sideBySide={sideBySide}
        onSideBySideChange={setSideBySide}
        collapseUnchanged={collapseUnchanged}
        onCollapseChange={setCollapseUnchanged}
        ignoreWhitespace={ignoreWhitespace}
        onIgnoreWhitespaceChange={setIgnoreWhitespace}
        busy={busy}
      />

      {error && (
        <div className="banner banner-error">
          <span>{error}</span>
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {notice && (
        <div className="banner banner-notice">
          <span>{notice.text}</span>
          {notice.url && <button onClick={() => window.open(notice.url!)}>Open on GitHub</button>}
          <button onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}

      {repo && activeTab === 'review' && baseline.kind === 'commit' && (
        <div className="banner banner-commit">
          <code>{baseline.ref?.slice(0, 7)}</code>
          <span className="banner-commit-subject">{baseline.label}</span>
          <span className="banner-commit-meta">read-only</span>
          <div className="segmented segmented-small" role="tablist" aria-label="How to show this commit">
            <button
              role="tab"
              aria-selected={!baseline.cumulative}
              className={!baseline.cumulative ? 'is-active' : ''}
              onClick={() => setCumulative(false)}
              title="Just what this commit changed, against its parent"
            >
              This commit only
            </button>
            <button
              role="tab"
              aria-selected={!!baseline.cumulative}
              className={baseline.cumulative ? 'is-active' : ''}
              disabled={!onBranchCommit || !prBase}
              onClick={() => setCumulative(true)}
              title={
                onBranchCommit
                  ? `This commit on top of everything before it, against ${prBase} — its own lines are marked`
                  : 'Only for commits on this branch'
              }
            >
              Up to here
            </button>
          </div>
          <span className="statusbar-spacer" />
          <button onClick={() => changeBaseline(allChanges(prBase))}>Back to all changes</button>
        </div>
      )}

      {stale && repo && activeTab === 'review' && (
        <div className="banner banner-stale">
          <span>Files changed on disk.</span>
          <button onClick={() => void refresh(repo.root, baseline)}>Reload</button>
        </div>
      )}

      {activeTab === 'flows' ? (
        <FlowsPane
          flows={flows}
          selectedId={selectedFlow}
          onSelect={setSelectedFlow}
          onNew={() => void newFlow()}
          onDelete={(id) => void deleteFlow(id)}
          onChange={changeFlow}
          onError={setError}
          showSource={showFlowSource}
          onShowSourceChange={setShowFlowSource}
          dark={dark}
        />
      ) : (
      <main className="workspace">
        <FileList
          files={files}
          selected={selected}
          reviewed={reviewed}
          filter={filter}
          onFilterChange={setFilter}
          onSelect={setSelected}
          onToggleReviewed={toggleReviewed}
          filterRef={filterRef}
          unsaved={drafts}
          commentCounts={commentCounts}
        />

        <section className="detail">
          {selectedFile && (
            <div className="file-header">
              <div className="file-header-path">
                {selectedFile.oldPath && <span className="rename-from">{selectedFile.oldPath} → </span>}
                {selectedFile.path}
              </div>
              {draft && afterIsWorktree && (
                <span
                  className={`file-header-unsaved${conflict ? ' is-conflict' : ''}`}
                  title={
                    conflict
                      ? 'The file changed on disk after you started editing. Saving asks before overwriting it.'
                      : 'Edited here and not saved yet'
                  }
                >
                  {conflict ? 'Changed on disk since you started editing' : 'Unsaved'}
                </span>
              )}
              <div className="file-header-counts">
                {selectedFile.additions > 0 && <span className="count-add">+{selectedFile.additions}</span>}
                {selectedFile.deletions > 0 && <span className="count-del">−{selectedFile.deletions}</span>}
              </div>
              <div className="file-header-actions">
                {draft && afterIsWorktree && (
                  <>
                    <button className="is-active" onClick={() => void saveFile(selectedFile.path)} title="Save (⌘S)">
                      Save
                    </button>
                    <button onClick={() => revertEdits(selectedFile.path)} title="Throw away your unsaved edits">
                      Revert edits
                    </button>
                  </>
                )}
                {editable && (
                  <button
                    onClick={() => diffViewRef.current?.openComposer()}
                    title="Comment on the selected lines, or the cursor's line (c)"
                  >
                    Comment
                  </button>
                )}
                {baseline.kind !== 'commit' && (
                  <button
                    className="danger"
                    onClick={() => void fileAction('discard')}
                    title={`Throw away these changes — put the file back how it was ${discardWhere(baseline)}`}
                  >
                    Discard
                  </button>
                )}
                <button onClick={() => void fileAction('open')} title="Open in the default app">
                  Open
                </button>
                <button onClick={() => void fileAction('reveal')} title="Reveal in Finder">
                  Reveal
                </button>
              </div>
            </div>
          )}

          <DiffView
            ref={diffViewRef}
            diff={shownDiff}
            sideBySide={sideBySide}
            collapseUnchanged={collapseUnchanged}
            ignoreWhitespace={ignoreWhitespace}
            dark={dark}
            editable={editable}
            dirty={hasDraft && afterIsWorktree}
            onEdit={onEdit}
            resetKey={resetKey}
            comments={editable ? fileComments : NO_COMMENTS}
            commentActions={commentActions}
            reveal={reveal}
            onRevealed={() => setReveal(null)}
          />
        </section>
      </main>
      )}

      <footer className="statusbar">
        {activeTab === 'flows' ? (
          <>
            <span>
              {flows.length} diagram{flows.length === 1 ? '' : 's'}
            </span>
            <span className="statusbar-spacer" />
            <span className="statusbar-hint">
              j/k diagrams · ⌘E source · scroll to pan · ⌘-scroll to zoom · double-click to fit
            </span>
          </>
        ) : (
          <>
            <span>
              {files.length} file{files.length === 1 ? '' : 's'}
            </span>
            {totals.add > 0 && <span className="count-add">+{totals.add}</span>}
            {totals.del > 0 && <span className="count-del">−{totals.del}</span>}
            {Object.keys(drafts).length > 0 && (
              <span className="statusbar-unsaved">{Object.keys(drafts).length} unsaved</span>
            )}
            <span className="statusbar-spacer" />
            <span className="statusbar-hint">
              j/k files · ⌥j/⌥k commits · n/p hunks · c comment · ⌘S save · space reviewed · ⌘M round
            </span>
            <span
              className={`watch-dot${autoRefresh ? ' is-live' : ''}`}
              title={autoRefresh ? 'Watching' : 'Paused'}
            />
          </>
        )}
      </footer>

      {prSheetOpen && repo && branch && prBase && (
        <PrSheet
          repo={repo}
          branch={branch}
          base={prBase}
          pr={prLookup?.pr ?? null}
          ghError={prLookup?.ghError ?? null}
          unsavedCount={Object.keys(drafts).length}
          onSaveAll={saveAll}
          onClose={() => setPrSheetOpen(false)}
          onPublished={onPublished}
        />
      )}
    </div>
  )
}
