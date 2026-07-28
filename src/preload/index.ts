import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  Baseline,
  ChangeSet,
  CommitInfo,
  FileChange,
  FileDiff,
  FlowDoc,
  OpenFlowRequest,
  OpenRepoRequest,
  RepoInfo
} from '@shared/types'

const api = {
  pickRepo: (): Promise<RepoInfo | null> => ipcRenderer.invoke('repo:pick'),
  openRepo: (dir: string): Promise<RepoInfo> => ipcRenderer.invoke('repo:open', dir),
  recentRepos: (): Promise<{ root: string; name: string }[]> => ipcRenderer.invoke('repo:recent'),
  forgetRepo: (root: string): Promise<void> => ipcRenderer.invoke('repo:forget', root),
  refreshRepoInfo: (root: string): Promise<RepoInfo> => ipcRenderer.invoke('repo:refreshInfo', root),

  listChanges: (root: string, baseline: Baseline): Promise<ChangeSet> =>
    ipcRenderer.invoke('changes:list', { root, baseline }),
  loadDiff: (root: string, baseline: Baseline, file: FileChange): Promise<FileDiff> =>
    ipcRenderer.invoke('diff:file', { root, baseline, file }),

  markSnapshot: (root: string): Promise<string> => ipcRenderer.invoke('snapshot:mark', root),
  listCommits: (root: string): Promise<CommitInfo[]> => ipcRenderer.invoke('commits:list', root),

  stageFile: (root: string, path: string): Promise<void> => ipcRenderer.invoke('file:stage', { root, path }),
  unstageFile: (root: string, path: string): Promise<void> =>
    ipcRenderer.invoke('file:unstage', { root, path }),
  revertFile: (root: string, path: string, untracked: boolean): Promise<boolean> =>
    ipcRenderer.invoke('file:revert', { root, path, untracked }),
  revealFile: (root: string, path: string): Promise<void> => ipcRenderer.invoke('file:reveal', { root, path }),
  openFile: (root: string, path: string): Promise<void> =>
    ipcRenderer.invoke('file:openExternal', { root, path }),

  listFlows: (): Promise<FlowDoc[]> => ipcRenderer.invoke('flow:list'),
  createFlow: (title: string, source: string): Promise<FlowDoc> =>
    ipcRenderer.invoke('flow:create', { title, source }),
  updateFlow: (patch: { id: string; title?: string; source?: string }): Promise<FlowDoc> =>
    ipcRenderer.invoke('flow:update', patch),
  deleteFlow: (id: string): Promise<void> => ipcRenderer.invoke('flow:delete', id),
  exportFlow: (name: string, svg: string, png: string | null): Promise<boolean> =>
    ipcRenderer.invoke('flow:export', { name, svg, png }),
  copyFlowImage: (pngDataUrl: string): Promise<void> =>
    ipcRenderer.invoke('flow:copyImage', pngDataUrl),

  /** Diagrams the CLI handed over while the UI was still booting, if any. */
  consumePendingFlows: (): Promise<OpenFlowRequest | null> => ipcRenderer.invoke('flow:consumePending'),

  /** Fires when `gitdiff flow` hands a diagram to the running app. Returns an unsubscribe. */
  onFlowRequest: (cb: (request: OpenFlowRequest) => void): (() => void) => {
    const listener = (_e: unknown, request: OpenFlowRequest): void => cb(request)
    ipcRenderer.on('flow:openRequest', listener)
    return () => ipcRenderer.removeListener('flow:openRequest', listener)
  },

  startWatching: (root: string): Promise<void> => ipcRenderer.invoke('watch:start', root),
  stopWatching: (): Promise<void> => ipcRenderer.invoke('watch:stop'),

  /** A repo the CLI asked for while the UI was still booting, if any. */
  consumePendingRepo: (): Promise<OpenRepoRequest | null> => ipcRenderer.invoke('repo:consumePending'),

  /** Fires when an already-running app is handed a new repo. Returns an unsubscribe. */
  onOpenRepoRequest: (cb: (request: OpenRepoRequest) => void): (() => void) => {
    const listener = (_e: unknown, request: OpenRepoRequest): void => cb(request)
    ipcRenderer.on('repo:openRequest', listener)
    return () => ipcRenderer.removeListener('repo:openRequest', listener)
  },

  /** Fires when the watcher sees the repo move underneath us. Returns an unsubscribe. */
  onRepoChanged: (cb: (root: string) => void): (() => void) => {
    const listener = (_e: unknown, root: string): void => cb(root)
    ipcRenderer.on('repo:changed', listener)
    return () => ipcRenderer.removeListener('repo:changed', listener)
  },

  /** Turns a dropped File into the absolute path the main process needs. */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),

  platform: process.platform
}

export type GitDiffApi = typeof api

contextBridge.exposeInMainWorld('gitdiff', api)
