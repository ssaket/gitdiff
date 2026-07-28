import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Baseline, ChangeSet, FileChange, FileDiff, RepoInfo } from '@shared/types'
import { DiffView, type DiffViewHandle } from './components/DiffView'
import { FileList } from './components/FileList'
import { Toolbar } from './components/Toolbar'
import { Welcome } from './components/Welcome'

/**
 * Reviewed marks are pinned to *what the file looked like* when you ticked it.
 * If the agent touches it again the signature moves and the tick clears itself,
 * which is the whole point — you want to be told when something you already
 * signed off on has changed underneath you.
 */
function signatureOf(f: FileChange): string {
  return `${f.status}:${f.additions}:${f.deletions}:${f.untracked}`
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

  const diffViewRef = useRef<DiffViewHandle>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  const scanTokenRef = useRef(0)
  const diffTokenRef = useRef(0)

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
        const result: ChangeSet = await window.gitdiff.listChanges(root, base)
        if (token !== scanTokenRef.current) return // a newer scan already landed
        setFiles(result.files)
        setRepo(result.repo)
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

  const applyRepo = useCallback((info: RepoInfo) => {
    setRepo(info)
    setBaseline({ kind: 'worktree' })
    setReviewedSigs({})
    setSelected(null)
    setError(null)
  }, [])

  const openRepo = useCallback(
    async (dir: string) => {
      try {
        applyRepo(await window.gitdiff.openRepo(dir))
      } catch (e) {
        setError(errorText(e))
      }
    },
    [applyRepo]
  )

  const pickRepo = useCallback(async () => {
    try {
      const picked = await window.gitdiff.pickRepo()
      if (picked) applyRepo(picked)
    } catch (e) {
      setError(errorText(e))
    }
  }, [applyRepo])

  // `gitdiff ~/project` from a terminal, or a folder dropped on the dock icon.
  // The request may have arrived before this component existed, so collect any
  // parked one as well as subscribing for later ones.
  useEffect(() => {
    const handle = (request: { repo: RepoInfo | null; error: string | null }): void => {
      if (request.repo) applyRepo(request.repo)
      else if (request.error) setError(request.error)
    }
    void window.gitdiff.consumePendingRepo().then((pending) => {
      if (pending) handle(pending)
    })
    return window.gitdiff.onOpenRepoRequest(handle)
  }, [applyRepo])

  const markSnapshot = useCallback(async () => {
    if (!repo) return
    try {
      const tree = await window.gitdiff.markSnapshot(repo.root)
      const label = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      setReviewedSigs({})
      setBaseline({ kind: 'snapshot', ref: tree, label })
    } catch (e) {
      setError(errorText(e))
    }
  }, [repo])

  const changeBaseline = useCallback((next: Baseline) => {
    setReviewedSigs({})
    setBaseline(next)
  }, [])

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
    async (action: 'stage' | 'unstage' | 'revert' | 'reveal' | 'open') => {
      if (!repo || !selectedFile) return
      try {
        const { root } = repo
        const p = selectedFile.path
        if (action === 'stage') await window.gitdiff.stageFile(root, p)
        else if (action === 'unstage') await window.gitdiff.unstageFile(root, p)
        else if (action === 'revert') await window.gitdiff.revertFile(root, p, selectedFile.untracked)
        else if (action === 'reveal') await window.gitdiff.revealFile(root, p)
        else await window.gitdiff.openFile(root, p)

        if (action !== 'reveal' && action !== 'open') await refresh(root, baseline)
      } catch (e) {
        setError(errorText(e))
      }
    },
    [repo, selectedFile, baseline, refresh]
  )

  // -------------------------------------------------------------- shortcuts

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      const typing =
        target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable
      const mod = e.metaKey || e.ctrlKey

      if (mod && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        void pickRepo()
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
        void markSnapshot()
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
      if (e.key === 'Escape' && typing) {
        ;(target as HTMLInputElement).blur()
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
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [repo, baseline, selected, step, toggleReviewed, refresh, markSnapshot, pickRepo])

  // ------------------------------------------------------------------ render

  if (!repo) {
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
        baseline={baseline}
        onBaselineChange={changeBaseline}
        onMarkSnapshot={markSnapshot}
        onPickRepo={pickRepo}
        onRefresh={() => void refresh(repo.root, baseline)}
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

      {stale && (
        <div className="banner banner-stale">
          <span>Files changed on disk.</span>
          <button onClick={() => void refresh(repo.root, baseline)}>Reload</button>
        </div>
      )}

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
        />

        <section className="detail">
          {selectedFile && (
            <div className="file-header">
              <div className="file-header-path">
                {selectedFile.oldPath && <span className="rename-from">{selectedFile.oldPath} → </span>}
                {selectedFile.path}
              </div>
              <div className="file-header-counts">
                {selectedFile.additions > 0 && <span className="count-add">+{selectedFile.additions}</span>}
                {selectedFile.deletions > 0 && <span className="count-del">−{selectedFile.deletions}</span>}
              </div>
              <div className="file-header-actions">
                {baseline.kind !== 'commit' && (
                  <>
                    <button onClick={() => void fileAction('stage')} title="git add this file">
                      Stage
                    </button>
                    <button onClick={() => void fileAction('unstage')} title="Unstage this file">
                      Unstage
                    </button>
                    <button
                      className="danger"
                      onClick={() => void fileAction('revert')}
                      title="Throw away the agent's changes to this file"
                    >
                      Discard
                    </button>
                  </>
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
            diff={diff}
            sideBySide={sideBySide}
            collapseUnchanged={collapseUnchanged}
            ignoreWhitespace={ignoreWhitespace}
            dark={dark}
          />
        </section>
      </main>

      <footer className="statusbar">
        <span>
          {files.length} file{files.length === 1 ? '' : 's'}
        </span>
        {totals.add > 0 && <span className="count-add">+{totals.add}</span>}
        {totals.del > 0 && <span className="count-del">−{totals.del}</span>}
        <span className="statusbar-spacer" />
        <span className="statusbar-hint">j/k files · n/p hunks · space reviewed · / filter</span>
        <span className={`watch-dot${autoRefresh ? ' is-live' : ''}`} title={autoRefresh ? 'Watching' : 'Paused'} />
      </footer>
    </div>
  )
}

function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  // IPC wraps thrown errors; strip the noise so the banner reads like git.
  return raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')
}
