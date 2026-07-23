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
  // used for automated visual verification during development.
  const shotPath = process.env.VR_SHOT
  if (shotPath) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const image = await mainWindow.webContents.capturePage()
        const { writeFileSync } = await import('fs')
        writeFileSync(shotPath, image.toPNG())
        console.log(`[shot] saved ${shotPath}`)
      }, 2500)
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
  nodeManager.onReady = async ({ id, ssh }) => {
    await provisionBase(ssh, id)
    const version = await resolveBlenderRelease('4.5')
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
        const { createJob, listJobs } = await import('./jobs/jobs')
        const { registerAddon } = await import('./addons/addons')
        const { updateSettings } = await import('./settings')

        const spec = JSON.parse(readFileSync(jobSpecPath, 'utf-8'))

        const patch: Record<string, number> = {}
        if (spec.maxActiveNodes) patch.maxActiveNodes = spec.maxActiveNodes
        if (spec.spendCapPerHour) patch.spendCapPerHour = spec.spendCapPerHour
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

        let blends: string[] = spec.blends ?? []
        if (!blends.length && spec.blendDir) {
          blends = readdirSync(spec.blendDir)
            .filter((f: string) => f.toLowerCase().endsWith('.blend'))
            .sort()
            .map((f: string) => join(spec.blendDir, f))
        }
        if (!blends.length) {
          console.error('[spec] no blends resolved — nothing submitted')
          return
        }

        const active = listJobs().filter((j) => ['queued', 'running'].includes(j.state))
        let created = 0
        for (const blendPath of blends) {
          if (active.some((j) => j.blendPath === blendPath)) {
            console.log(`[spec] skip (already active): ${blendPath}`)
            continue
          }
          const jobId = await createJob({
            blendPath,
            engine: spec.engine ?? 'eevee',
            frameStart: spec.frameStart ?? 1,
            frameEnd: spec.frameEnd ?? 200,
            frameStep: spec.frameStep ?? 1,
            addonIds,
            chunkSize: spec.chunkSize ?? null
          })
          created++
          console.log(`[spec] job ${created}/${blends.length} ${jobId} ${blendPath}`)
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
