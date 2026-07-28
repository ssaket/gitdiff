import { useEffect, useState } from 'react'

interface Props {
  onPick: () => void
  onOpen: (dir: string) => void
  error: string | null
}

export function Welcome({ onPick, onOpen, error }: Props): JSX.Element {
  const [recent, setRecent] = useState<{ root: string; name: string }[]>([])
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    void window.gitdiff.recentRepos().then(setRecent)
  }, [])

  return (
    <div
      className={`welcome${dragging ? ' is-dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        const file = e.dataTransfer.files[0]
        if (file) onOpen(window.gitdiff.pathForFile(file))
      }}
    >
      <div className="welcome-drag" />
      <div className="welcome-card">
        <h1>GitDiff</h1>
        <p className="welcome-tagline">See exactly what your coding agent changed.</p>

        <button className="primary" onClick={onPick}>
          Open a repository
        </button>
        <p className="welcome-hint">…or drop a folder anywhere on this window</p>

        {error && <p className="welcome-error">{error}</p>}

        {recent.length > 0 && (
          <div className="recent">
            <h2>Recent</h2>
            <ul>
              {recent.map((r) => (
                <li key={r.root}>
                  <button onClick={() => onOpen(r.root)} title={r.root}>
                    <span className="recent-name">{r.name}</span>
                    <span className="recent-path">{r.root}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}
