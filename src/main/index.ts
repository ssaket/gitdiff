import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { BrowserWindow, app, net, protocol, shell } from 'electron'
import { disposeIpc, registerIpc, requestOpenRepo } from './ipc'
import { firstRepoArg } from './cli'

const isDev = !app.isPackaged
const rendererDist = path.join(__dirname, '../renderer')

/**
 * Production loads the UI over `app://` rather than `file://`. Monaco computes
 * diffs in a web worker, and Chromium refuses to start module workers from a
 * file:// document (opaque origin) — a custom standard scheme gives the page a
 * real origin and sidesteps the problem entirely.
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
  }
])

let mainWindow: BrowserWindow | null = null

function registerAppProtocol(): void {
  protocol.handle('app', async (request) => {
    const { pathname } = new URL(request.url)
    const decoded = decodeURIComponent(pathname === '/' ? '/index.html' : pathname)
    const target = path.join(rendererDist, decoded)

    // Never serve anything outside the bundled renderer output.
    const rel = path.relative(rendererDist, target)
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return new Response('Forbidden', { status: 403 })
    }
    return net.fetch(pathToFileURL(target).toString())
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 860,
    minHeight: 520,
    show: false,
    backgroundColor: '#101215',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Anything that wants a new window is an external link; hand it to the browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('app://') && !url.startsWith(process.env.ELECTRON_RENDERER_URL ?? '\0')) {
      event.preventDefault()
    }
  })

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadURL('app://bundle/index.html')
  }
}

function focusWindow(): void {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/**
 * One process owns the app; every later `gitdiff <path>` hands its arguments to
 * that owner and exits. Without this, each CLI invocation would spawn a whole
 * second Electron app rather than retargeting the window already on screen.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv, workingDirectory) => {
    focusWindow()
    // The second process's cwd, not ours — that's what `gitdiff .` meant.
    const target = firstRepoArg(argv, { cwd: workingDirectory, appPath: app.getAppPath() })
    if (target) void requestOpenRepo(target, mainWindow)
  })

  // Finder: "Open With", or a folder dropped on the dock icon.
  app.on('open-file', (event, filePath) => {
    event.preventDefault()
    focusWindow()
    void requestOpenRepo(filePath, mainWindow)
  })

  app.whenReady().then(() => {
    registerAppProtocol()
    registerIpc(() => mainWindow)

    const target = firstRepoArg(process.argv, { cwd: process.cwd(), appPath: app.getAppPath() })
    if (target) void requestOpenRepo(target, null)

    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    disposeIpc()
  })
}
