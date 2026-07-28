#!/usr/bin/env node
// Symlinks the `gitdiff` launcher onto PATH.
//
// Prefers the shim inside an installed GitDiff.app so the command keeps working
// after this source checkout moves or disappears; falls back to the checkout.

import { existsSync, mkdirSync, lstatSync, symlinkSync, unlinkSync, accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const shimCandidates = [
  process.env.GITDIFF_APP && path.join(process.env.GITDIFF_APP, 'Contents/Resources/bin/gitdiff'),
  '/Applications/GitDiff.app/Contents/Resources/bin/gitdiff',
  path.join(homedir(), 'Applications/GitDiff.app/Contents/Resources/bin/gitdiff'),
  path.join(projectDir, 'bin/gitdiff')
].filter(Boolean)

const shim = shimCandidates.find((p) => existsSync(p))
if (!shim) {
  console.error('Could not find the gitdiff launcher. Run this from the project directory.')
  process.exit(1)
}

const onPath = (process.env.PATH ?? '').split(':').filter(Boolean)
const targets = ['/usr/local/bin', path.join(homedir(), '.local/bin'), path.join(homedir(), 'bin')]

const writable = (dir) => {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    accessSync(dir, constants.W_OK)
    return true
  } catch {
    return false
  }
}

// A directory already on PATH is worth more than one we would have to ask the
// user to add, so try those first.
const dir = targets.find((d) => onPath.includes(d) && writable(d)) ?? targets.find(writable)

if (!dir) {
  console.error('No writable directory found in:', targets.join(', '))
  console.error(`\nSymlink it yourself:\n  sudo ln -sf "${shim}" /usr/local/bin/gitdiff`)
  process.exit(1)
}

const link = path.join(dir, 'gitdiff')
try {
  if (lstatSync(link, { throwIfNoEntry: false })) unlinkSync(link)
  symlinkSync(shim, link)
} catch (e) {
  console.error(`Could not create ${link}: ${e.message}`)
  console.error(`\nTry:\n  sudo ln -sf "${shim}" ${link}`)
  process.exit(1)
}

console.log(`Linked ${link} → ${shim}`)
if (!onPath.includes(dir)) {
  console.log(`\nNote: ${dir} is not on your PATH. Add it:\n  export PATH="${dir}:$PATH"`)
} else {
  console.log('\nTry it:  gitdiff .')
}
