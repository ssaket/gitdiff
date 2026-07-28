import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

// Deliberately not wrapped in StrictMode: its double-invoked effects would
// create and tear down a Monaco diff editor and a filesystem watcher on every
// mount, and the watcher start/stop IPC pair is not safe to interleave.
createRoot(document.getElementById('root')!).render(<App />)
