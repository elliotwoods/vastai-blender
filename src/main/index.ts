import { app, shell, BrowserWindow, net, protocol } from 'electron'
import { join, normalize } from 'path'
import { pathToFileURL } from 'url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { resolveBlenderRelease } from './blender/blendInfo'
import { registerIpc } from './ipc'
import { nodeManager, setCurrentChunkProvider } from './nodes/nodeManager'
import { installBlender, probeEevee, provisionBase } from './nodes/provisioner'
import { scheduler } from './scheduler/scheduler'
import { getSettings } from './settings'

// Dev aid: VR_USERDATA=<dir> runs against a throwaway profile (own settings,
// own SQLite state, no API key) — used with VR_MOCK=1 to drive the UI for
// screenshots without touching the real fleet. Must be set before app ready.
if (process.env.VR_USERDATA) {
  app.setPath('userData', process.env.VR_USERDATA)
}

// media:// serves local media (proxy clips, fixtures) to the renderer with
// Range-request support for <video> seeking. Registered before app ready.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
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

function registerMediaProtocol(): void {
  protocol.handle('media', (request) => {
    const url = new URL(request.url)
    const root = mediaRoots()[url.host]
    if (!root) return new Response('unknown media root', { status: 404 })
    const abs = normalize(join(root, decodeURIComponent(url.pathname)))
    if (!abs.startsWith(normalize(root))) return new Response('forbidden', { status: 403 })
    return net.fetch(pathToFileURL(abs).toString())
  })
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#131417',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

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

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const screen = process.env.VR_SCREEN
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'] + (screen ? `?screen=${screen}` : ''))
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.kimchiandchips.vastai-blender')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerMediaProtocol()
  registerIpc()
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
  setCurrentChunkProvider((nodeId) => scheduler.currentChunkForNode(nodeId))
  nodeManager.init()
  scheduler.start()
  createWindow()

  // Headless batch driver: VR_JOB_SPEC=<path to .json> submits a whole campaign at boot.
  // Generalises VR_E2E_BLEND (pinned to one blend, Cycles, frames 1-20, no addons) so a
  // scripted run can set engine, frame range, addon zips and fleet size. Spec shape:
  //   {
  //     "blends": ["C:/.../suzanne.blend", ...]  // or "blendDir": "C:/.../blends/<cfg>"
  //     "engine": "eevee", "frameStart": 1, "frameEnd": 200, "frameStep": 1,
  //     "addonZips": ["C:/.../auroravision-0.2.0.zip"],
  //     "chunkSize": null, "maxActiveNodes": 4, "spendCapPerHour": 2
  //   }
  const jobSpecPath = process.env.VR_JOB_SPEC
  if (jobSpecPath) {
    setTimeout(() => {
      void (async () => {
        const { readFileSync, readdirSync } = await import('fs')
        const { createJob, listJobs, refreshJobState } = await import('./jobs/jobs')
        const { registerAddon } = await import('./addons/addons')
        const { updateSettings } = await import('./settings')
        const { getDb } = await import('./db/db')

        const spec = JSON.parse(readFileSync(jobSpecPath, 'utf-8'))

        const patch: Record<string, unknown> = {}
        if (spec.maxActiveNodes) patch.maxActiveNodes = spec.maxActiveNodes
        if (spec.spendCapPerHour) patch.spendCapPerHour = spec.spendCapPerHour
        // Concurrent render slots per node (agent runs N blender processes).
        if (spec.nodeSlots) patch.nodeSlots = spec.nodeSlots
        // Partial offer-filter overrides (e.g. {"cpuBound": true}) merge over
        // the stored filters via updateSettings' offerFilters merge.
        if (spec.offerFilters) patch.offerFilters = spec.offerFilters
        if (Object.keys(patch).length) {
          updateSettings(patch)
          console.log(`[spec] settings ${JSON.stringify(patch)}`)
        }

        // Register each zip fresh: the registry keys on the manifest id and re-hashes the
        // file, so re-running after an extension rebuild replaces the stale entry even
        // when the version string is unchanged.
        const addonIds: string[] = []
        for (const zip of spec.addonZips ?? []) {
          const info = registerAddon(zip)
          addonIds.push(info.id)
          console.log(`[spec] addon ${info.id} v${info.version} ${info.zipHash.slice(0, 12)}`)
        }

        // Blend list entries are either plain paths or objects with per-blend
        // frame overrides: {"path": "...", "frameStart": 1, "frameEnd": 120}.
        // Needed for mixed-length submissions (e.g. experiment scenes with
        // different animation lengths in one campaign spec).
        interface BlendEntry {
          path: string
          frameStart?: number
          frameEnd?: number
          frameStep?: number
        }
        let blends: BlendEntry[] = (spec.blends ?? []).map((b: string | BlendEntry): BlendEntry =>
          typeof b === 'string' ? { path: b } : b
        )
        if (!blends.length && spec.blendDir) {
          blends = readdirSync(spec.blendDir)
            .filter((f: string) => f.toLowerCase().endsWith('.blend'))
            .sort()
            .map((f: string): BlendEntry => ({ path: join(spec.blendDir, f) }))
        }
        if (!blends.length) {
          console.error('[spec] no blends resolved — nothing submitted')
          return
        }

        // 'partial' included: resubmitting a spec HEALS a half-done job
        // (failed chunks revived below) instead of duplicating it.
        const active = listJobs().filter((j) => ['queued', 'running', 'partial'].includes(j.state))
        let created = 0
        for (const blend of blends) {
          const existing = active.find((j) => j.blendPath === blend.path)
          if (existing) {
            // Revive permanently-failed chunks (retry budget exhausted, e.g.
            // by a since-fixed dispatch bug) so the scheduler re-runs only
            // the missing work — downloaded frames are never re-rendered
            // because requeue narrowed the chunk ranges already.
            const revived = getDb()
              .prepare(
                `UPDATE chunks SET state='pending', node_id=NULL, retries=0
                 WHERE job_id = ? AND state='failed'`
              )
              .run(existing.id).changes
            if (revived > 0) refreshJobState(existing.id)
            console.log(
              `[spec] skip (already active): ${blend.path}` +
                (revived ? ` — revived ${revived} failed chunk(s)` : '')
            )
            continue
          }
          const jobId = await createJob({
            blendPath: blend.path,
            engine: spec.engine ?? 'eevee',
            frameStart: blend.frameStart ?? spec.frameStart ?? 1,
            frameEnd: blend.frameEnd ?? spec.frameEnd ?? 200,
            frameStep: blend.frameStep ?? spec.frameStep ?? 1,
            addonIds,
            chunkSize: spec.chunkSize ?? null
          })
          created++
          console.log(`[spec] job ${created}/${blends.length} ${jobId} ${blend.path}`)
        }
        console.log(`[spec] submitted ${created} job(s)`)
        scheduler.kick()
      })().catch((e) => console.error('[spec] submission failed:', e))
    }, 3000)
  }

  // Headless E2E driver: VR_E2E_BLEND=<path> submits a small Cycles job at
  // boot; the scheduler then scales up, renders, downloads, and idles down.
  const e2eBlend = process.env.VR_E2E_BLEND
  if (e2eBlend) {
    setTimeout(() => {
      void (async () => {
        const { createJob, listJobs } = await import('./jobs/jobs')
        // Guard against duplicate submissions across main-process restarts.
        const existing = listJobs().find(
          (j) => j.blendPath === e2eBlend && ['queued', 'running'].includes(j.state)
        )
        if (existing) {
          console.log(`[e2e] active job already exists: ${existing.id}`)
          scheduler.kick()
          return
        }
        const jobId = await createJob({
          blendPath: e2eBlend,
          engine: 'cycles',
          frameStart: 1,
          frameEnd: 20,
          frameStep: 1,
          addonIds: [],
          chunkSize: null
        })
        console.log(`[e2e] job created: ${jobId}`)
        scheduler.kick()
      })().catch((e) => console.error('[e2e] job creation failed:', e))
    }, 3000)
  }

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
