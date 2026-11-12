# GitDiff

A desktop diff reviewer for the specific problem of *"my coding agent just touched
14 files — what did it actually do?"*

It is where you iterate on what the agent wrote, *before* it becomes a pull
request. Point it at a repo and you see the PR this branch would make — every
change against `main`, committed or not — updating live as the agent works.
Fix small things yourself right in the diff, leave line comments for the
bigger ones, and hand them back to the agent. When you're happy, **Create PR**
squashes it into one clean commit, pushes it and opens the PR. GitHub gets the
finished thing rather than every round of "address feedback".

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
gitdiff comments        # print your review comments, for the agent — see below
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

## What you're looking at

The diff is framed as the pull request this branch will become. **vs main ▾**
picks the branch it targets (the remote's default branch to start with), and
the scope menu next to it picks how much of it to show:

| Scope | Compares |
|---|---|
| **All changes** | the merge-base with `origin/main` → the working tree. Committed, uncommitted and brand-new files together — what GitHub's "Files changed" will show |
| **Since round N** | the working tree → the moment you started the round (⌘M) |
| **Uncommitted** | the working tree → `HEAD` |
| *a commit* | one of the branch's commits — see below |
| **Browse older commits…** | any recent commit, on its own |

Diffing from the merge-base rather than `main`'s tip means work that landed on
`main` after you branched doesn't show up as something you deleted. The remote
copy of `main` is preferred over a local one for the same reason.

### Viewing a commit

Picking a commit opens it read-only, with two ways to look at it:

- **This commit only** — the commit against its parent: just what it changed.
- **Up to here** — the commit against the merge-base: the PR as it stood once
  that commit landed. The commit's own lines get a bar in the gutter, and the
  files it touched a dot in the list, so you still see what *it* did amid
  everything before it.

`⌥j` / `⌥k` step through the branch's commits and keep whichever view you
chose. Stepping above the newest commit lands on Uncommitted — or, viewing
cumulatively, on All changes, which is just "up to here" for the working tree.

### Rounds

A round marks the moment you handed work back to the agent: **Since round N**
then shows only what it changed after that. **Send to agent** (below) starts
one for you; ⌘M starts one by hand.

A round writes the entire worktree — tracked, staged and untracked alike — into
a git tree object, without touching your repository. It stages into a scratch
index via `GIT_INDEX_FILE` rather than `.git/index`, so your real index, `HEAD`,
stash and working tree are all left exactly as they were. The trees are
unreferenced, so a future `git gc` eventually reclaims them; the last 20 rounds
are remembered across restarts.

## Editing

The right-hand side of the diff is the file on disk, and you can type into it —
in every scope except a commit, which is history. ⌘S saves.

- **Revert arrows** in the gutter between the two sides throw away one hunk
  (side-by-side only; Monaco doesn't draw them inline). That's an edit like any
  other: it's on disk once you save.
- **Unsaved edits stay put** while you move between files and scopes; the file
  list marks them, and **Revert edits** throws them away.
- **If the agent writes the file while you're editing it,** your text stays in
  the editor, the header says the file changed on disk, and saving asks before
  overwriting the agent's version.
- Closing, quitting or reloading with unsaved edits asks first, and **Create
  PR** won't run until they're saved — the PR is built from what's on disk.

## Review comments

For anything you'd rather the agent fixed. Hover a line on the right-hand side
and click **+**, or select some lines and press `c` (or **Comment** in the file
header). The comment sits under those lines, like a GitHub review comment.

Comments follow their lines as edits above them move them. Once the lines
themselves are rewritten — usually because the agent dealt with it — the
comment is *outdated*: it leaves the diff and stays in the **Comments** menu,
for you to resolve.

**Send to agent** in that menu starts a new round and puts every open comment on
the clipboard as a prompt, to paste into the agent's chat. From then on the
diff shows only what the agent changes in response. **Copy as prompt** just
copies.

Or the agent reads them itself:

```bash
gitdiff comments            # open comments as markdown, with the lines they're about
gitdiff comments src/app.ts # just one file
gitdiff comments --json
```

So a line in your `CLAUDE.md` (or `AGENTS.md`) closes the loop without the
clipboard:

```markdown
When I say I've left review comments, run `gitdiff comments` and address each
one by editing the files. Don't commit; I review the result in GitDiff.
```

### As a Claude Code hook

Or skip even that: `gitdiff comments --hook` is made to run as a
`UserPromptSubmit` hook. It reads the prompt Claude Code hands it, and when the
prompt mentions the review, comments or feedback, it prints the open comments —
which Claude Code adds to the conversation. Any other prompt, a repo with no
comments, or no repo at all, and it prints nothing; in a repo that has never had
a comment it doesn't even start Electron. In `~/.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\"$HOME/.local/bin/gitdiff\" comments --hook 2>/dev/null || true",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

Then "address the review" is all you type. Use the path `cli:install` printed
for the link; the `|| true` keeps a missing or broken install from getting in
the way of your prompts.

Comments and rounds live in `.git/gitdiff/review.json`: inside the git
directory, so never committed, and each linked worktree has its own.
`gitdiff comments` runs as plain Node inside the app's own Electron, so it
needs no separate Node install and works whether or not the app is open.

## Opening a PR

**Create PR** opens a sheet with the title, description, branch name (when
you're on `main` and need a new one), and a checklist of the files going in.
Untick anything that shouldn't ship — the agent's `PLAN.md`, say. It stays on
disk, untouched, and is left unticked next time too.

Then, in this order:

1. The PR's tree is built in a scratch index: the working tree as it stands,
   with unticked files put back the way they are on the merge-base — so
   leaving out a file the agent already *committed* takes it out of the PR too.
2. `git commit-tree` turns that into one commit on top of the merge-base.
3. That commit is pushed by sha, and `gh pr create` opens the PR.
4. Only once the push has worked does anything local move: the branch is
   pointed at the new commit and HEAD moved onto it, without rewriting a single
   file on disk. `git status` afterwards shows exactly what you left out.

If the push or `gh` fails, your repository is as it was before you clicked.

Once the PR exists the button becomes **Update PR**, with two ways to push:

- **Amend and force-push** keeps the PR one clean commit. The force-push is
  leased on the head GitHub reported when you opened the sheet, so it refuses
  rather than overwrite a push it never saw. This is the default until the PR
  has a review.
- **Push as a new commit** stacks one commit on top. The default once someone
  has reviewed, since rewriting what they already looked at is unkind.

With commits already on the branch, creating also offers to keep them as they
are (plus one commit for anything uncommitted) instead of squashing.

Needs the [GitHub CLI](https://cli.github.com) installed and logged in
(`gh auth login`). A Mac app launched from Finder gets a minimal PATH that
doesn't include Homebrew, so the app asks your login shell for its PATH once
at startup to find `gh`.

`commit-tree` doesn't run `pre-commit` hooks, so a repo that depends on them
(husky, lint-staged) won't get them on the PR commit. `pre-push` hooks do run.

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
| `c` | comment on the selected lines |
| `⌘S` | save edits to the current file |
| `⌘↩` | save a comment (`Esc` cancels) |
| `/` or `⌘F` | filter files |
| `⌘\` | side-by-side ⇄ inline |
| `⌥j` / `⌥k` | next / previous commit on the branch |
| `⌘M` | start a round by hand |
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
- **Discard** is the only destructive action and always asks first. What it
  restores depends on the scope: All changes puts the file back as it is on
  the base branch, so it drops out of the PR; Uncommitted puts it back to
  `HEAD`; Since round to the round's start. Files that didn't exist there go
  to the Trash rather than being deleted.
- The renderer runs with `contextIsolation` on and no node integration; all git
  work happens in the main process, and only repos you've explicitly opened can
  be addressed over IPC.

## Layout

```
src/main/       git.ts · snapshot.ts · diff.ts · pr.ts · review.ts · watcher.ts · flows.ts · ipc.ts · store.ts
                comments-cli.ts — `gitdiff comments`, run as plain Node
src/preload/    the contextBridge API surface
src/renderer/   React UI + Monaco + mermaid
src/shared/     types shared across all three
```

Mermaid is dynamically imported, so the ~1 MB of parser and layout engine is
only fetched once you open a diagram — reviewing a diff never loads it.
