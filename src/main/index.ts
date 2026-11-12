import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { BrowserWindow, app, dialog, nativeImage, net, protocol, shell } from 'electron'
import { disposeIpc, registerIpc, requestOpenRepo } from './ipc'
import { requestOpenFlow } from './flows'
import { firstRepoArg, flowArg } from './cli'
import { ensureShellPath } from './pr'

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

  // The renderer refuses to unload while edits in the diff view are unsaved —
  // closing the window, quitting, or a reload. Electron then asks us; ask the
  // user, and preventDefault() here means "unload anyway".
  mainWindow.webContents.on('will-prevent-unload', (event) => {
    const response = dialog.showMessageBoxSync(mainWindow!, {
      type: 'warning',
      buttons: ['Cancel', 'Discard Edits'],
      defaultId: 0,
      cancelId: 0,
      message: 'You have unsaved edits.',
      detail: 'Edits made in the diff view are lost unless you save them (⌘S).'
    })
    if (response === 1) event.preventDefault()
  })
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

/**
 * A dev run is Electron's own bundle with our code inside it, so macOS takes
 * the dock icon and the app name from *that* bundle — `build/icon.png` is only
 * ever read by electron-builder, at package time. Setting both at runtime makes
 * a dev window look like the real thing; a packaged build already does.
 */
function brandDevApp(): void {
  if (!isDev || process.platform !== 'darwin') return
  // out/main/index.js → the project root, where build/ lives.
  const icon = nativeImage.createFromPath(path.join(__dirname, '../../build/icon.png'))
  if (!icon.isEmpty()) app.dock?.setIcon(icon)
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

    const flow = flowArg(argv, { cwd: workingDirectory })
    if (flow) void requestOpenFlow(flow, mainWindow)
  })

  // Finder: "Open With", or a folder dropped on the dock icon.
  app.on('open-file', (event, filePath) => {
    event.preventDefault()
    focusWindow()
    void requestOpenRepo(filePath, mainWindow)
  })

  app.whenReady().then(() => {
    brandDevApp()
    registerAppProtocol()
    registerIpc(() => mainWindow)
    // Started now so it's settled by the time the first PR lookup needs gh.
    void ensureShellPath()

    const target = firstRepoArg(process.argv, { cwd: process.cwd(), appPath: app.getAppPath() })
    if (target) void requestOpenRepo(target, null)

    const flow = flowArg(process.argv, { cwd: process.cwd() })
    if (flow) void requestOpenFlow(flow, null)

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
