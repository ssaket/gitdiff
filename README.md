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

## Keyboard

| Key | |
|---|---|
| `j` / `k` | next / previous file |
| `n` / `p` (or `]` / `[`) | next / previous hunk |
| `space` | mark reviewed, advance |
| `/` or `⌘F` | filter files |
| `⌘\` | side-by-side ⇄ inline |
| `⌘M` | mark snapshot |
| `⌘R` | refresh now |
| `⌘O` | open another repo |

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
src/main/       git.ts · snapshot.ts · diff.ts · watcher.ts · ipc.ts · store.ts
src/preload/    the contextBridge API surface
src/renderer/   React UI + Monaco
src/shared/     types shared across all three
```
