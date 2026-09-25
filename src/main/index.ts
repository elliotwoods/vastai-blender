import {
  app,
  shell,
  BrowserWindow,
  dialog,
  Notification,
  powerMonitor,
  protocol,
  type MessageBoxOptions
} from 'electron'
import { createReadStream, statSync, writeSync } from 'fs'
import { extname, join } from 'path'
import { Readable } from 'stream'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { diagWrite, guardStdio, installCrashGuard } from './app/crashGuard'
import {
  fleetPort,
  installLifecycle,
  parseQuitPolicy,
  type Lifecycle,
  type Prompt
} from './app/lifecycle'
import { startHeadlessDrivers } from './app/headless/drivers'
import { externalUrl, isAppPage, type AppPage } from './app/windowPolicy'
import { resolveBlenderRelease } from './blender/blendInfo'
import { closeDb } from './db/db'
import { emit } from './events'
import { registerIpc } from './ipc'
import {
  nodeManager,
  setActiveWorkProvider,
  setForgetNodeProvider,
  setSlotInfoProvider
} from './nodes/nodeManager'
import { installBlender, probeEevee, provisionBase } from './nodes/provisioner'
import { resolveInside } from './paths'
import { scheduler } from './scheduler/scheduler'
import { jobClips } from './transfer/jobClip'
import { getSettings } from './settings'

// Before anything else can go wrong (plan 1.21). Field, job da68b61b: with
// the Mac's disk full, the headless stdout mirror threw ENOSPC, and
// Electron's modal "JavaScript error occurred in the main process" box sat
// in front of the app while nodes billed. An uncaught exception or
// unhandled rejection is now logged and raised as an alert, and the app
// carries on as it did once that box was dismissed (app/crashGuard.ts).
//
// stdout and stderr get an 'error' listener in every run. A write to a
// closed terminal (a headless run's SIGHUP; a person's app started from a
// terminal that went away) or to a full disk can fail after the call has
// returned, as an 'error' event on the stream, and one with no listener is
// an uncaught exception. A closed terminal is also what starts a headless
// run's destroy, which goes on writing to it.
guardStdio([process.stdout, process.stderr])
installCrashGuard({
  proc: process,
  alert: (message) => emit('alert', { level: 'error', message }),
  // writeSync, as for the lines below: a crash is when a piped stderr's
  // asynchronous write is least likely to land.
  log: (text) => diagWrite({ write: (t: string) => writeSync(2, t) }, text)
})

// Dev aid: VR_USERDATA=<dir> runs against a throwaway profile (own settings,
// own SQLite state, no API key) — used with VR_MOCK=1 to drive the UI for
// screenshots without touching the real fleet. Must be set before app ready.
if (process.env.VR_USERDATA) {
  app.setPath('userData', process.env.VR_USERDATA)
}

// One main process per profile. A second one on the same userData shares the
// SQLite state with the first, and its boot is destructive to it: init()
// re-provisions every live node, killing the first process's paid renders
// (seen live, 2026-09), start() resets every in-flight chunk to pending, and
// from then on two schedulers rent against two separate spend caps. So a
// second launch leaves here, before whenReady and any of that code. The lock
// is keyed on userData, which is why it is taken after the VR_USERDATA
// override: throwaway profiles still start beside the real one.
//
// A scripted launch (a headless campaign run, or a VR_SHOT capture) that is
// refused exits 1, so its script can tell "did nothing" from a run that went
// wrong: a refused capture exited 0 with no PNG, as a broken one can. It also
// tells the running instance, through additionalData, that it was scripted,
// and that instance then leaves its window alone.
const headless = Boolean(process.env.VR_JOB_SPEC || process.env.VR_E2E_BLEND)
const capture = process.env.VR_SHOT
const scripted = headless || Boolean(capture)
if (!app.requestSingleInstanceLock({ scripted })) {
  const msg =
    `[vast-render] another instance is already running on ${app.getPath('userData')}; ` +
    (headless
      ? 'this headless run submitted nothing.\n'
      : capture
        ? `no capture was written to ${capture}.\n`
        : 'focusing it instead.\n')
  // writeSync: a piped stderr may be asynchronous, and process.exit would
  // drop the one line that says why a scripted run did nothing.
  try {
    writeSync(2, msg)
  } catch {
    // No stderr attached (a Windows GUI launch): nothing to tell.
  }
  if (scripted) process.exit(1)
  app.quit()
  process.exit(0)
}

// The primary instance: a second launch (above) by a person is them asking
// for the app, so show them the one that is running. A scripted one is not:
// a campaign resubmitted, or a capture, on a box rendering headless must not
// pop a window up there. A launch that sent no data (an older build) counts
// as a person's. Emitted only after ready.
app.on('second-instance', (_event, _argv, _cwd, data) => {
  if ((data as { scripted?: unknown } | null)?.scripted === true) {
    console.log('[vast-render] refused a scripted second launch; window left as it is')
    return
  }
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) {
    // A headless run may have lost its window; the user asked for one.
    createWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
})

// media:// serves local media (proxy clips, fixtures) to the renderer with
// Range-request support for <video> seeking. Registered before app ready.
//
// corsEnabled + an Access-Control-Allow-Origin header on every response is
// what lets a <video crossOrigin="anonymous"> be uploaded into WebGL. Without
// it the element is cross-origin-tainted and `texImage2D` throws "The video
// element contains cross-origin data" — which silently disables the whole
// shader grading path, because the renderer's only sane response to a failed
// upload is to fall back to the CSS filter.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true
    }
  }
])

/** Roots addressable as media://<host>/<relative-path>. */
function mediaRoots(): Record<string, string> {
  return {
    // Dev fixtures (scripts/make-fixtures.ps1).
    fixtures: join(app.getAppPath(), 'fixtures'),
    // Downloaded renders (proxy clips) under the configured project root.
    project: getSettings().projectRoot
  }
}

/** Content types for what this protocol actually serves. */
const MEDIA_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp'
}

/**
 * media:// serves local media to the renderer, WITH byte ranges.
 *
 * Ranges are served by hand rather than delegated to `net.fetch`, which ignores
 * a `Range` header on a file:// URL and always answers with the whole file. A
 * `<video>` will not seek a resource whose server shows no range support until
 * the entire thing happens to be buffered — so scrubbing, arrow-key stepping and
 * opening the preview at a given frame all silently did nothing while paused:
 * `currentTime` was assigned and immediately read back as 0.
 */
function registerMediaProtocol(): void {
  protocol.handle('media', async (request) => {
    const url = new URL(request.url)
    const root = mediaRoots()[url.host]
    if (!root) return new Response('unknown media root', { status: 404 })
    // The pathname is '/'-rooted at the media root; resolveInside wants it
    // relative, and refuses anything that would leave the root.
    const abs = resolveInside(root, decodeURIComponent(url.pathname).replace(/^\/+/, ''))
    if (!abs) return new Response('forbidden', { status: 403 })

    let size: number
    try {
      size = statSync(abs).size
    } catch {
      return new Response('not found', { status: 404 })
    }

    const headers = new Headers({
      // corsEnabled + this header is what lets a <video crossOrigin="anonymous">
      // be uploaded into WebGL; without it texImage2D throws cross-origin and the
      // shader grading path silently falls back to a CSS filter.
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes',
      'Content-Type': MEDIA_TYPES[extname(abs).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache'
    })

    const body = (start?: number, end?: number): ReadableStream =>
      Readable.toWeb(createReadStream(abs, { start, end })) as ReadableStream

    const range = request.headers.get('range')
    const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null
    if (match && (match[1] || match[2])) {
      // An open-ended `bytes=N-` is what <video> actually sends; a suffix range
      // (`bytes=-N`) is legal too and asks for the LAST N bytes.
      let start: number
      let end: number
      if (match[1]) {
        start = Number(match[1])
        end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
      } else {
        start = Math.max(0, size - Number(match[2]))
        end = size - 1
      }
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
        headers.set('Content-Range', `bytes */${size}`)
        return new Response(null, { status: 416, headers })
      }
      headers.set('Content-Range', `bytes ${start}-${end}/${size}`)
      headers.set('Content-Length', String(end - start + 1))
      return new Response(body(start, end), { status: 206, headers })
    }

    headers.set('Content-Length', String(size))
    return new Response(body(), { status: 200, headers })
  })
}

/** app/lifecycle.ts, once whenReady has installed it: a closing window asks it. */
let quitLifecycle: Lifecycle | null = null

function createWindow(): void {
  // The one page this window ever shows: the dev server's, or the build's.
  const devUrl = is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined
  const page: AppPage = devUrl
    ? { url: devUrl }
    : { file: join(__dirname, '../renderer/index.html') }

  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#131417',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // The renderer decodes HEVC clips and JPEG thumbnails made on rented
      // machines, so a media-decoder bug is one crafted file away. Sandboxed,
      // that lands inside Chromium's OS sandbox rather than as the user. The
      // preload only needs contextBridge and ipcRenderer, which a sandboxed
      // preload has.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Already Electron's default, pinned here: a file dropped on the window
      // (a render dragged in by mistake) must not replace the app with it.
      navigateOnDragDrop: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // A headless run on Windows keeps its window when it is closed,
  // minimized. The run carries on without one (window-all-closed), but
  // Windows asks windows, not processes, whether the session may end: with
  // none, a shutdown or an overnight update's restart ended the run with
  // its fleet billing, never asked (app/lifecycle.ts). Minimized, not
  // hidden: Windows' shutdown screen, and its wait, may pass over a process
  // with no visible window and end it instead (1.1 review). A person's
  // launch restores it (second-instance). app.exit, which is how every quit
  // ends, destroys windows without a 'close'.
  if (headless && process.platform === 'win32') {
    mainWindow.on('close', (event) => {
      event.preventDefault()
      mainWindow.minimize()
    })
  }

  // A person closing the last window on Windows quits the app
  // (window-all-closed), and the quit's dialog came up with the window
  // already gone. With no window, nothing receives Windows' shutdown query
  // or session end: a dialog left unanswered overnight, then an update's
  // restart, ended the app with the fleet billing and the destroy never
  // started (1.1 review). So with anything billing the window stays while
  // the quit asks (the lifecycle's holdWindowClose), and goes with the
  // app's exit on Destroy all or Leave running.
  if (!headless && process.platform === 'win32') {
    mainWindow.on('close', (event) => {
      const last = BrowserWindow.getAllWindows().every((w) => w === mainWindow)
      if (last && quitLifecycle?.holdWindowClose()) event.preventDefault()
    })
  }

  // Dev aid: VR_SHOT=<path.png> captures the window shortly after load —
  // used for automated visual verification during development. The delay
  // (VR_SHOT_DELAY ms) has to outlast the dev server's first paint, web font
  // load and the first IPC round trip, or the capture is an empty window.
  const shotPath = process.env.VR_SHOT
  if (shotPath) {
    // Renderer console + failures go to stdout: a blank capture is otherwise
    // indistinguishable from a renderer that threw before its first paint.
    mainWindow.webContents.on('console-message', (_e, level, message) => {
      console.log(`[renderer:${level}] ${message}`)
    })
    mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
      console.log(`[renderer] load failed ${code} ${desc}`)
    })
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(
        async () => {
          // capturePage on a hidden/occluded window yields the background colour.
          mainWindow.show()
          mainWindow.focus()
          const image = await mainWindow.webContents.capturePage()
          const { writeFileSync } = await import('fs')
          writeFileSync(shotPath, image.toPNG())
          console.log(
            `[shot] saved ${shotPath} (${image.getSize().width}x${image.getSize().height})`
          )
        },
        Number(process.env.VR_SHOT_DELAY ?? 6000)
      )
    })
  }

  // No new windows. An http(s) link goes to the user's browser; any other
  // scheme would launch whichever local program claims it, so it goes nowhere.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    const url = externalUrl(details.url)
    if (url) void shell.openExternal(url)
    else console.warn(`[window] refused to open ${JSON.stringify(details.url)}`)
    return { action: 'deny' }
  })

  // No navigation away from the app's page. Whatever page loaded next would
  // still get the preload's window.api, and with it the fleet and the shell.
  mainWindow.webContents.on('will-navigate', (event) => {
    if (isAppPage(event.url, page)) return
    event.preventDefault()
    console.warn(`[window] blocked navigation to ${JSON.stringify(event.url)}`)
  })

  if ('url' in page) {
    const screen = process.env.VR_SCREEN
    mainWindow.loadURL(page.url + (screen ? `?screen=${screen}` : ''))
  } else {
    mainWindow.loadFile(page.file)
  }
}

/**
 * The app's window, brought forward for a dialog, or null when none is open.
 * macOS keeps running with its window closed, and a quit from the Dock must
 * still put its question in front of the user.
 */
function frontWindow(): BrowserWindow | null {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
  if (win) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  } else {
    app.focus({ steal: true })
  }
  return win
}

/** A lifecycle prompt as a native message box: a sheet on the window, when there is one. */
async function showMessageBox(
  parent: BrowserWindow | null,
  prompt: Prompt<string>
): Promise<number> {
  const options: MessageBoxOptions = {
    type: prompt.type,
    title: prompt.title,
    message: prompt.message,
    detail: prompt.detail,
    buttons: prompt.buttons,
    defaultId: prompt.defaultId,
    cancelId: prompt.cancelId,
    noLink: prompt.noLink,
    normalizeAccessKeys: prompt.normalizeAccessKeys
  }
  const r = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options)
  return r.response
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.kimchiandchips.vastai-blender')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerMediaProtocol()
  // createWindow: an alert's OS notification, clicked with the window closed
  // (macOS, still billing), opens one.
  registerIpc({ createWindow })
  // Provisioning pipeline: base setup, default Blender release, EEVEE probe.
  // Job-specific Blender versions are installed on demand at dispatch time.
  // 5.1 (not 4.5): campaign blends are saved by Blender 5.1, so probing EEVEE
  // on 4.5 verified nothing — 5.x changed the default GPU backend to Vulkan
  // and a node can pass on 4.5 yet fail every real render on 5.1.
  nodeManager.onReady = async ({ id, ssh }) => {
    await provisionBase(ssh, id)
    const version = await resolveBlenderRelease('5.1')
    await installBlender(ssh, id, version)
    await probeEevee(ssh, id, version)
  }
  setActiveWorkProvider((nodeId) => scheduler.activeWorkForNode(nodeId))
  setSlotInfoProvider((nodeId) => ({
    inUse: scheduler.slotsInUse(nodeId),
    target: scheduler.displaySlotTarget(nodeId)
  }))
  setForgetNodeProvider((nodeId) => scheduler.forgetNode(nodeId))
  nodeManager.init()
  scheduler.start()
  // Stitch job clips for any job whose chunk clips outran them — e.g. chunks
  // that finished under a build without job clips, or while ffmpeg failed.
  jobClips.catchUp()
  // Quit, sleep and Windows session end while nodes bill (app/lifecycle.ts).
  // Before createWindow, so the first window gets its session-end listeners.
  // A headless run never asks: VR_QUIT_POLICY decides (see the drivers below).
  const quitPolicy = parseQuitPolicy(process.env.VR_QUIT_POLICY)
  if (headless && quitPolicy.warning) console.warn(`[vast-render] ${quitPolicy.warning}`)
  const lifecycle = installLifecycle({
    app,
    powerMonitor,
    showMessageBox,
    openExternal: (url) => shell.openExternal(url),
    notify: (body) => {
      if (Notification.isSupported()) new Notification({ title: 'Vast Render', body }).show()
    },
    frontWindow,
    ensureWindow: () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    },
    // Nothing for the port's accrueSleep and reconcile yet: nodeManager's
    // accrual and orphan sweep are private, and the sweep as it stands would
    // destroy a rental whose create reply is still in flight (plan 1.3).
    fleet: fleetPort(nodeManager, scheduler),
    closeDb,
    headless: headless ? { policy: quitPolicy.policy } : null,
    signals: process,
    stderr: (text) => {
      // writeSync, as for the single-instance refusal: the process exits
      // right after, and a piped stderr may be asynchronous.
      try {
        writeSync(2, text)
      } catch {
        // No stderr attached: nowhere to say it.
      }
    }
  })
  quitLifecycle = lifecycle
  createWindow()

  // The headless drivers (VR_JOB_SPEC, VR_E2E_BLEND) submit a few seconds
  // after boot, and stop by the quit policy: app/headless/drivers.ts.
  startHeadlessDrivers({
    jobSpecPath: process.env.VR_JOB_SPEC,
    e2eBlend: process.env.VR_E2E_BLEND,
    lifecycle,
    kick: () => scheduler.kick()
  })

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // Headless batch runs must survive the window going away — a crashed or
  // closed renderer window would otherwise quit the main process
  // mid-campaign and orphan paid instances. The scheduler/nodeManager live
  // in main and need no window.
  if (process.env.VR_JOB_SPEC || process.env.VR_E2E_BLEND) return
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
