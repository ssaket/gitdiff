/// <reference types="vite/client" />

import type { GitDiffApi } from '../../preload'

declare global {
  interface Window {
    gitdiff: GitDiffApi
  }
}

declare module '*?worker' {
  const workerConstructor: { new (): Worker }
  export default workerConstructor
}

export {}
