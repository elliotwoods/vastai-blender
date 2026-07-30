import { app, shell, BrowserWindow, protocol } from 'electron'
import { createReadStream, statSync } from 'fs'
import { extname, join, normalize, sep } from 'path'
import { Readable } from 'stream'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { resolveBlenderRelease } from './blender/blendInfo'
import { registerIpc } from './ipc'
import {
  nodeManager,
  setActiveWorkProvider,
  setForgetNodeProvider,
  setSlotInfoProvider
} from './nodes/nodeManager'
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
    const abs = normalize(join(root, decodeURIComponent(url.pathname)))
    // Trailing separator: without it `C:\renders` also admits `C:\renders-old`.
    const guard = normalize(root) + sep
    if (abs !== normalize(root) && !abs.startsWith(guard)) {
      return new Response('forbidden', { status: 403 })
    }

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
  setActiveWorkProvider((nodeId) => scheduler.activeWorkForNode(nodeId))
  setSlotInfoProvider((nodeId) => ({
    inUse: scheduler.slotsInUse(nodeId),
    target: scheduler.slotTargetFor(nodeId)
  }))
  setForgetNodeProvider((nodeId) => scheduler.forgetNode(nodeId))
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
  //     "chunkSize": null, "maxActiveNodes": 4, "spendCapPerHour": 2,
  //     "shareNode": true,      // jobs may co-run on one node (per-blend override too)
  //     "maxNodeSlots": 0       // 0 = let the app judge concurrency per node
  //   }
  const jobSpecPath = process.env.VR_JOB_SPEC
  if (jobSpecPath) {
    setTimeout(() => {
      void (async () => {
        const { readFileSync, readdirSync } = await import('fs')
        const { createJob, emitChunksChanged, listJobs, refreshJobState } =
          await import('./jobs/jobs')
        const { registerAddon } = await import('./addons/addons')
        const { updateSettings } = await import('./settings')
        const { getDb } = await import('./db/db')

        const spec = JSON.parse(readFileSync(jobSpecPath, 'utf-8'))

        const patch: Record<string, unknown> = {}
        if (spec.maxActiveNodes) patch.maxActiveNodes = spec.maxActiveNodes
        if (spec.spendCapPerHour) patch.spendCapPerHour = spec.spendCapPerHour
        // Cap on the auto-judged render slots per node; 0/absent = auto.
        // `nodeSlots` is the pre-2.1 name for the same knob.
        const slotCap = spec.maxNodeSlots ?? spec.nodeSlots
        if (slotCap != null) patch.maxNodeSlots = slotCap
        // Buy-ahead fleet: rent to maxActiveNodes while any chunk is open.
        if (spec.eagerFleet != null) patch.eagerFleet = spec.eagerFleet
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
          /** may co-run with other chunks on one node; falls back to spec.shareNode */
          shareNode?: boolean
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
        const allJobs = listJobs()
        const active = allJobs.filter((j) => ['queued', 'running', 'partial'].includes(j.state))
        let created = 0
        for (const blend of blends) {
          // Satisfied: a prior job for the same blend AND the same frame
          // range already completed — re-running the spec must not re-render
          // finished work. (Observed: complete jobs were re-created on every
          // respec because dedup only looked at ACTIVE jobs.)
          const wantStart = blend.frameStart ?? spec.frameStart ?? 1
          const wantEnd = blend.frameEnd ?? spec.frameEnd ?? 200
          const satisfied = allJobs.find(
            (j) =>
              j.state === 'complete' &&
              j.blendPath === blend.path &&
              j.frameStart === wantStart &&
              j.frameEnd === wantEnd
          )
          if (satisfied) {
            console.log(`[spec] skip (already complete): ${blend.path}`)
            continue
          }
          const existing = active.find((j) => j.blendPath === blend.path)
          if (existing) {
            // Revive permanently-failed chunks (retry budget exhausted, e.g.
            // by a since-fixed dispatch bug) so the scheduler re-runs only
            // the missing work — downloaded frames are never re-rendered
            // because requeue narrowed the chunk ranges already.
            const failed = getDb()
              .prepare(`SELECT id FROM chunks WHERE job_id = ? AND state = 'failed'`)
              .all(existing.id) as Array<{ id: string }>
            const revived = getDb()
              .prepare(
                `UPDATE chunks SET state='pending', node_id=NULL, retries=0
                 WHERE job_id = ? AND state='failed'`
              )
              .run(existing.id).changes
            if (revived > 0) {
              emitChunksChanged(failed.map((c) => c.id))
              refreshJobState(existing.id)
            }
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
            chunkSize: spec.chunkSize ?? null,
            shareNode: blend.shareNode ?? spec.shareNode ?? false
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
  // Headless batch runs must survive the window going away — a crashed or
  // closed renderer window would otherwise quit the main process
  // mid-campaign and orphan paid instances. The scheduler/nodeManager live
  // in main and need no window.
  if (process.env.VR_JOB_SPEC || process.env.VR_E2E_BLEND) return
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
