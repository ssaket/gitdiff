# GitDiff

A desktop diff reviewer for the specific problem of *"my coding agent just touched
14 files — what did it actually do?"*

Point it at a repo, hit **Mark** before you let Claude Code / Codex / whatever
loose, and review exactly what changed since that moment — separated from
whatever uncommitted work you already had in flight.

Built on Electron + [Monaco](https://microsoft.github.io/monaco-editor/), the
editor that powers VS Code, so the diffs get real syntax highlighting,
word-level intra-line highlights, and collapsed unchanged regions.

## Running it

```bash
npm install
npm run dev      # hot-reloading dev build
npm start        # run the production build
```

## Packaging

```bash
npm run dist:dmg        # .dmg + .zip for this architecture → release/
npm run dist:universal  # one build for both Apple Silicon and Intel
npm run dist            # unpacked .app only, no installer (fastest)
```

Output lands in `release/`. Builds are unsigned (`identity: null`), so on first
launch macOS Gatekeeper will complain — right-click the app and choose **Open**,
or `xattr -dr com.apple.quarantine /Applications/GitDiff.app`. Add an Apple
Developer identity in `build.mac` to sign and notarize properly.

There's no app icon yet; electron-builder falls back to the default Electron one.
Drop a 512×512 `icon.png` into `build/` to change that.

## The `gitdiff` command

```bash
npm run cli:install     # symlink `gitdiff` onto your PATH
gitdiff                 # open the current directory
gitdiff ~/code/project  # open somewhere else
gitdiff flow diagram.mmd  # show a mermaid diagram — see Flows below
```

`cli:install` prefers the shim inside an installed `/Applications/GitDiff.app`,
so the command keeps working after this source checkout moves or is deleted. It
falls back to the checkout if the app isn't installed. To do it by hand:

```bash
ln -sf /Applications/GitDiff.app/Contents/Resources/bin/gitdiff /usr/local/bin/gitdiff
```

Running `gitdiff` a second time does **not** open a second app — it hands the
path to the instance already running and retargets that window, the same way
`code .` behaves. That relies on Electron's single-instance lock, which is keyed
to the user-data directory, so a dev build (`npm run dev`) and an installed
build hold separate locks and won't retarget each other.

The app also accepts folders dropped onto its dock icon.

## Baselines

The four modes in the toolbar choose what the "before" side of the diff is:

| Mode | Compares |
|---|---|
| **Uncommitted** | worktree vs `HEAD` — staged, unstaged and brand-new files together |
| **Staged** | index vs `HEAD` |
| **Since mark** | worktree vs the point where you hit **Mark** |
| **Commit** | a single commit vs its parent |

### How "Mark" works

Marking writes the entire worktree — tracked, staged and untracked alike — into
a git tree object, then diffs against that later.

The one thing worth knowing is that it does **not** touch your repository. It
stages into a scratch index via `GIT_INDEX_FILE` rather than `.git/index`, so
your real index, `HEAD`, stash and working tree are all left exactly as they
were. The blobs it writes are unreferenced and a future `git gc` reclaims them.

This is what lets you review agent output that's tangled up with your own
half-finished edits: mark first, and only the agent's changes show up.

## Live refresh

A filesystem watcher re-scans as the agent writes, debounced so a burst of
writes produces one refresh. Re-rendering the file you're reading restores your
scroll position rather than throwing you back to line 1.

Toggle the ◉ button to pause it — while paused you get a "files changed on
disk" banner instead of the view moving under you.

## Reviewed marks

Ticking a file records *what it looked like* when you ticked it. If the agent
edits that file again the tick clears itself, so you get told when something
you already signed off on has moved.

## Flows

The second tab renders [mermaid](https://mermaid.js.org) diagrams. It exists so
that when you ask your agent *"explain how this works, visually"*, it has
somewhere to put the picture:

```bash
gitdiff flow --title "Request flow" <<'MMD'
flowchart TD
  A[Client] --> B[API]
  B --> C[(Database)]
MMD
```

That brings the window forward with the diagram open. It also takes a file —
`gitdiff flow docs/architecture.md` — and a markdown file's ` ```mermaid `
blocks each become their own diagram, titled by the heading they sit under.
No repository is needed; `gitdiff flow` works in any directory.

Diagrams are stored in the app (the 60 most recent), so they survive a restart.
**Source** opens the mermaid next to the picture and re-renders as you type,
which makes the tab a usable scratchpad in its own right — while the source is
unparseable the last good render stays on screen with the error underneath,
rather than the canvas going blank on every half-finished line.

Scroll to pan, ⌘-scroll (or pinch) to zoom, double-click to fit. **Copy** puts
a PNG on the clipboard for pasting into a PR or a chat; **Export** writes SVG
or PNG.

### Teaching your agent about it

Nothing about this is automatic — the agent has to know the command exists.
Drop this in your `CLAUDE.md` (or `AGENTS.md`, or the equivalent):

```markdown
When explaining how existing code works, and the explanation is a flow, a
sequence, or a state machine, render it: write mermaid and pipe it to
`gitdiff flow --title "<short title>"` via a heredoc. Keep explaining in text
as well — the diagram is in addition to the answer, not instead of it.
```

Mermaid is bundled, so rendering is offline and the diagram never leaves your
machine. Diagrams arrive from a language model, so they're parsed with
mermaid's `strict` security level and rendered without embedded HTML.

## Keyboard

| Key | |
|---|---|
| `j` / `k` | next / previous file (or diagram) |
| `n` / `p` (or `]` / `[`) | next / previous hunk |
| `space` | mark reviewed, advance |
| `/` or `⌘F` | filter files |
| `⌘\` | side-by-side ⇄ inline |
| `⌘M` | mark snapshot |
| `⌘R` | refresh now |
| `⌘O` | open another repo |
| `⌘1` / `⌘2` | Review ⇄ Flows |
| `⌘E` | show the mermaid source |

## Notes

- **Rename detection runs at 30% similarity**, below git's 50% default. Agents
  rename a file and rewrite most of its body in one go; at the default that
  reports an unrelated delete plus add and you lose the ability to diff old
  against new.
- Images render as before/after previews; other binaries and files over 3 MB
  report their size instead of trying to diff.
- **Discard** is the only destructive action and always asks first. Untracked
  files go to the Trash rather than being deleted, since git has no copy.
- The renderer runs with `contextIsolation` on and no node integration; all git
  work happens in the main process, and only repos you've explicitly opened can
  be addressed over IPC.

## Layout

```
src/main/       git.ts · snapshot.ts · diff.ts · watcher.ts · flows.ts · ipc.ts · store.ts
src/preload/    the contextBridge API surface
src/renderer/   React UI + Monaco + mermaid
src/shared/     types shared across all three
```

Mermaid is dynamically imported, so the ~1 MB of parser and layout engine is
only fetched once you open a diagram — reviewing a diff never loads it.
