/**
 * Registers every ipcMain.handle channel from the shared contract and owns
 * the event-push helper. Real implementations arrive phase by phase; anything
 * not yet built returns an honest empty/stub result (and mock data under
 * VR_MOCK=1 for UI development).
 */

import { BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import type { EventChannel, IpcEventMap, InvokeChannel, IpcInvokeMap } from '../shared/ipc'
import type {
  AssetIndex,
  ChunkSnapshot,
  ChunkState,
  ClipAsset,
  ClipKind,
  EngineId,
  JobDetail,
  HistoryRange,
  HistorySummary,
  JobState,
  JobSummary,
  NodeChunkView,
  NodeSnapshot,
  ThumbAsset
} from '../shared/models'
import { getSettings, setSecret, updateSettings } from './settings'
import { findOffers } from './vast/offers'
import { currentUser } from './vast/vastClient'
import { nodeManager } from './nodes/nodeManager'
import { listAddons, registerAddon, removeAddon } from './addons/addons'
import { createJob, getJob, listJobs, setJobShareNode } from './jobs/jobs'
import { scheduler } from './scheduler/scheduler'
import { co2Grams, intensityFor } from './carbon/intensity'
import { getDb } from './db/db'
import { toMediaUrl } from './mediaUrl'
import { resolveRange, summary as historySummary } from './history/history'
import { REMOTE_ROOT } from './nodes/provisioner'
import { openSshTerminal, sshTargetFor } from './ssh/sshTerminal'

type Handler<C extends InvokeChannel> = (
  ...args: IpcInvokeMap[C]['args']
) => Promise<IpcInvokeMap[C]['result']> | IpcInvokeMap[C]['result']

function handle<C extends InvokeChannel>(channel: C, handler: Handler<C>): void {
  ipcMain.handle(channel, (_event, ...args) => handler(...(args as IpcInvokeMap[C]['args'])))
}

/** Push an event to every window. */
export function emit<C extends EventChannel>(channel: C, payload: IpcEventMap[C]): void {
  // E2E observability: mirror events to stdout when driving headless tests. Both headless
  // drivers need this — without it a scripted run has no way to see why a chunk failed,
  // because the node's render log otherwise only ever reaches the renderer window.
  const headless = process.env.VR_E2E_BLEND || process.env.VR_JOB_SPEC
  if (headless && channel !== 'render:logLine') {
    console.log(`[event] ${channel} ${JSON.stringify(payload).slice(0, 240)}`)
  }
  if (headless && channel === 'render:logLine') {
    const l = payload as IpcEventMap['render:logLine']
    console.log(`[log:${l.nodeId.slice(0, 8)}] ${l.line}`)
  }
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

const MOCK = process.env.VR_MOCK === '1'

/**
 * Asset kinds that are playable clips. Everything else in `assets` is not.
 *
 * `live` belongs here: it is a real clip and the preview overlay's whole
 * purpose is to play it while a chunk renders. Keeping it OUT of this list
 * (to hide it from the Gallery wall) silently broke the live preview
 * end-to-end — with no definitive clips yet, assets:index returned nothing and
 * the overlay fell back to blowing up a 320px thumbnail, which also left the
 * grade panel with no video to act on. The wall excludes live at the
 * point of use instead — see media/renditions.ts.
 */
const CLIP_KINDS: string[] = ['previewSdr', 'previewHdr', 'proxy', 'live']

/**
 * Chunks on a node, joined to their jobs — the "what is this machine actually
 * rendering" query. Live work first, then most recently assigned, because a
 * node that has just finished should still show what it was doing.
 */
function nodeChunks(nodeId: string, limit = 12): NodeChunkView[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT c.id, c.job_id, c.frame_start, c.frame_end, c.state, c.retries, c.assigned_at,
              j.name AS job_name, j.engine, j.frame_step
         FROM chunks c JOIN jobs j ON j.id = c.job_id
        WHERE c.node_id = ?
        ORDER BY c.assigned_at IS NULL, c.assigned_at DESC, c.frame_start
        LIMIT ?`
    )
    .all(nodeId, limit) as Array<{
    id: string
    job_id: string
    frame_start: number
    frame_end: number
    state: ChunkState
    retries: number
    assigned_at: number | null
    job_name: string
    engine: EngineId
    frame_step: number
  }>
  if (rows.length === 0) return []

  // Two batched lookups rather than two queries per row.
  const ids = rows.map((r) => r.id)
  const marks = ids.map(() => '?').join(',')
  const doneByChunk = new Map<string, number>()
  for (const r of db
    .prepare(
      `SELECT chunk_id, COUNT(*) AS n FROM frames
        WHERE chunk_id IN (${marks}) AND state = 'downloaded' GROUP BY chunk_id`
    )
    .all(...ids) as Array<{ chunk_id: string; n: number }>) {
    doneByChunk.set(r.chunk_id, r.n)
  }
  const thumbByChunk = new Map<string, string>()
  for (const r of db
    .prepare(
      `SELECT chunk_id, thumb_path FROM frames
        WHERE chunk_id IN (${marks}) AND thumb_path IS NOT NULL ORDER BY frame`
    )
    .all(...ids) as Array<{ chunk_id: string; thumb_path: string }>) {
    // Later frames overwrite earlier ones, so this lands on the newest.
    thumbByChunk.set(r.chunk_id, r.thumb_path)
  }

  return rows.map((r) => ({
    chunkId: r.id,
    jobId: r.job_id,
    jobName: r.job_name,
    engine: r.engine,
    frameStart: r.frame_start,
    frameEnd: r.frame_end,
    frameStep: r.frame_step,
    state: r.state,
    framesDone: doneByChunk.get(r.id) ?? 0,
    framesTotal: Math.floor((r.frame_end - r.frame_start) / r.frame_step) + 1,
    retries: r.retries,
    live: scheduler.isLive(r.id),
    assignedAt: r.assigned_at,
    thumbUrl: thumbByChunk.has(r.id) ? toMediaUrl(thumbByChunk.get(r.id) as string) : null
  }))
}

/** Thumbnails for a frame range — the filmstrip's visible window. */
function frameThumbs(jobId: string, from: number, to: number): ThumbAsset[] {
  const rows = getDb()
    .prepare(
      `SELECT frame, chunk_id, thumb_path FROM frames
        WHERE job_id = ? AND frame BETWEEN ? AND ? AND thumb_path IS NOT NULL
        ORDER BY frame`
    )
    .all(jobId, from, to) as Array<{ frame: number; chunk_id: string; thumb_path: string }>
  return rows.map((r) => ({
    frame: r.frame,
    chunkId: r.chunk_id,
    absPath: r.thumb_path,
    mediaUrl: toMediaUrl(r.thumb_path)
  }))
}

// Four fixture thumbnails cycled across the range, so a mocked filmstrip has
// varied content without needing a real render on disk.
const mockThumbs = (from: number, to: number): ThumbAsset[] => {
  const out: ThumbAsset[] = []
  for (let f = Math.max(1, from); f <= Math.min(to, 100); f++) {
    // Leave a visible gap so the placeholder vocabulary is exercised too.
    if (f % 7 === 0) continue
    const n = String((f % 4) + 1).padStart(4, '0')
    out.push({
      frame: f,
      chunkId: 'job1abcd-51-75',
      absPath: `fixtures/thumbs/${n}.jpg`,
      mediaUrl: `media://fixtures/thumbs/${n}.jpg`
    })
  }
  return out
}

/**
 * Mock job detail + assets, backed by the fixture clips.
 *
 * Without these `VR_MOCK=1` populated the fleet and the jobs list but left the
 * Gallery, the filmstrip and the preview overlay empty — so the mock mode
 * could not drive the half of the UI that is about looking at renders.
 */
function mockJobDetail(jobId: string): JobDetail | null {
  const summary = mockJobs().find((j) => j.id === jobId) ?? mockJobs()[0]
  if (!summary) return null
  const chunks: ChunkSnapshot[] = mockNodeAChunks()
    .filter((c) => c.jobId === summary.id)
    .map((c) => ({
      id: c.chunkId,
      jobId: c.jobId,
      frameStart: c.frameStart,
      frameEnd: c.frameEnd,
      state: c.state,
      nodeId: 'node-a',
      framesDone: c.framesDone,
      retries: c.retries
    }))
  return { ...summary, chunks, addonIds: [] }
}

function mockAssets(jobId: string): AssetIndex {
  const detail = mockJobDetail(jobId)
  const clips = (detail?.chunks ?? []).flatMap((c) => [
    fixtureClip('previewSdr', c.id, 'probe_sdr_hevc.mp4', false),
    fixtureClip('previewHdr', c.id, 'probe_hlg_hevc.mp4', true),
    fixtureClip('proxy', c.id, 'probe_sdr_hevc.mp4', false)
  ])
  return { jobId, clips, frames: [] }
}

function fixtureClip(kind: ClipKind, chunkId: string, file: string, hdr: boolean): ClipAsset {
  return {
    kind,
    chunkId,
    label: `${chunkId} ${kind}`,
    absPath: `fixtures/${file}`,
    mediaUrl: `media://fixtures/${file}`,
    fps: 25,
    frames: 100,
    width: 1024,
    height: 1024,
    codec: 'hevc',
    hdr
  }
}

// Node-aware: the real handler filters by node_id, so a mock that ignored it
// would show the provisioning node rendering someone else's chunks.
const mockNodeChunks = (nodeId: string): NodeChunkView[] =>
  nodeId === 'node-a' ? mockNodeAChunks() : []

const mockNodeAChunks = (): NodeChunkView[] => [
  {
    chunkId: 'job1abcd-51-75',
    jobId: 'job-1',
    jobName: 'hero_shot_v12',
    engine: 'cycles',
    frameStart: 51,
    frameEnd: 75,
    frameStep: 1,
    state: 'rendering',
    framesDone: 18,
    framesTotal: 25,
    retries: 0,
    live: true,
    assignedAt: Date.now() - 11 * 60_000,
    thumbUrl: 'media://fixtures/thumbs/0001.jpg'
  },
  {
    chunkId: 'job1abcd-76-100-r1',
    jobId: 'job-1',
    jobName: 'hero_shot_v12',
    engine: 'cycles',
    frameStart: 76,
    frameEnd: 100,
    frameStep: 1,
    state: 'rendering',
    framesDone: 3,
    framesTotal: 25,
    retries: 1,
    live: true,
    assignedAt: Date.now() - 4 * 60_000,
    thumbUrl: 'media://fixtures/thumbs/0002.jpg'
  },
  {
    chunkId: 'job2abcd-1-25',
    jobId: 'job-2',
    jobName: 'turntable_b',
    engine: 'eevee',
    frameStart: 1,
    frameEnd: 25,
    frameStep: 1,
    state: 'encoding',
    framesDone: 25,
    framesTotal: 25,
    retries: 0,
    live: true,
    assignedAt: Date.now() - 26 * 60_000,
    thumbUrl: 'media://fixtures/thumbs/0003.jpg'
  },
  {
    chunkId: 'job2abcd-26-50',
    jobId: 'job-2',
    jobName: 'turntable_b',
    engine: 'eevee',
    frameStart: 26,
    frameEnd: 50,
    frameStep: 1,
    state: 'complete',
    framesDone: 25,
    framesTotal: 25,
    retries: 0,
    live: false,
    assignedAt: Date.now() - 55 * 60_000,
    thumbUrl: 'media://fixtures/thumbs/0004.jpg'
  }
]

const mockNodes = (): NodeSnapshot[] => [
  {
    id: 'node-a',
    instanceId: 1234567,
    state: 'rendering',
    gpuName: 'RTX 4090',
    numGpus: 2,
    dphTotal: 0.612,
    sshHost: '203.0.113.7',
    sshPort: 41234,
    startedAt: Date.now() - 42 * 60_000,
    accumulatedCost: 0.43,
    energyWh: 612,
    co2g: co2Grams(612, 'Frankfurt, DE', 1.6),
    geolocation: 'Frankfurt, DE',
    // Deliberately one multi-slot node AND one retry id — the two shapes the
    // old currentChunkId regex could not parse.
    currentWork: [
      { chunkId: 'job1abcd-51-75', jobId: 'job-1' },
      { chunkId: 'job1abcd-76-100-r1', jobId: 'job-1' },
      { chunkId: 'job2abcd-1-25', jobId: 'job-2' }
    ],
    // 3 of 4 — deliberately leaves one idle slot visible in the panel.
    slotsInUse: 3,
    slotTarget: 4,
    eeveeCapable: true,
    octaneReady: false,
    octaneNeedsManualLogin: false,
    blenderVersions: ['4.5.3'],
    lastError: null,
    metrics: {
      gpuUtil: 97,
      vramUsedGb: 14.2,
      vramTotalGb: 24,
      gpuTemp: 71,
      powerW: 812,
      powerLimitW: 900,
      cpuUtil: 43,
      cpuLoad1: 6.3,
      cpuCores: 16,
      ramUsedGb: 21.7,
      ramTotalGb: 64,
      updatedAt: Date.now()
    }
  },
  {
    id: 'node-b',
    instanceId: 1234568,
    state: 'provisioning',
    gpuName: 'RTX 3090',
    numGpus: 1,
    dphTotal: 0.21,
    sshHost: null,
    sshPort: null,
    startedAt: Date.now() - 3 * 60_000,
    accumulatedCost: 0.01,
    energyWh: 0,
    co2g: 0,
    geolocation: 'Oslo, NO',
    currentWork: [],
    slotsInUse: 0,
    slotTarget: 1,
    eeveeCapable: null,
    octaneReady: false,
    octaneNeedsManualLogin: false,
    blenderVersions: [],
    lastError: null,
    metrics: null
  }
]

const mockJobs = (): JobSummary[] => [
  {
    id: 'job-1',
    name: 'hero_shot_v12',
    blendPath: 'C:/scenes/hero_shot_v12.blend',
    engine: 'cycles',
    frameStart: 1,
    frameEnd: 250,
    frameStep: 1,
    state: 'running',
    framesDone: 117,
    framesTotal: 250,
    costSoFar: 1.24,
    submittedAt: Date.now() - 55 * 60_000,
    outputDir: 'C:/renders/job-1',
    blenderVersion: '4.5.3',
    shareNode: false
  },
  {
    id: 'job-2',
    name: 'lookdev_turntable',
    blendPath: 'C:/scenes/lookdev_turntable.blend',
    engine: 'eevee',
    frameStart: 1,
    frameEnd: 120,
    frameStep: 1,
    state: 'queued',
    framesDone: 0,
    framesTotal: 120,
    costSoFar: 0,
    submittedAt: Date.now() - 4 * 60_000,
    outputDir: 'C:/renders/job-2',
    blenderVersion: '4.3.2',
    shareNode: true
  }
]

/**
 * A mock fleet split across a dirty and a clean grid, so the CO2 breakdown has
 * something to show rather than one uniform number.
 */
const MOCK_GRIDS: Array<{ geo: string; share: number }> = [
  { geo: 'Frankfurt, DE', share: 0.62 },
  { geo: 'Oslo, NO', share: 0.38 }
]

/** Mock CO2 for some Wh, run through the real intensity maths. */
const mockCo2 = (wh: number): number =>
  MOCK_GRIDS.reduce((a, g) => a + co2Grams(wh * g.share, g.geo, getSettings().co2OverheadFactor), 0)

/**
 * Synthetic usage history for `VR_MOCK=1` screenshot/dev runs — a fleet that
 * ramps up, renders through the night and winds down, so every chart has shape
 * instead of a flat line. Deterministic (seeded off the bucket index) so
 * successive screenshots are identical.
 */
const mockHistory = (range: HistoryRange, now = Date.now()): HistorySummary => {
  const earliestMs = now - 34 * 24 * 3_600_000
  const { fromMs, bucketMs } = resolveRange(range, now, earliestMs)
  const count = Math.max(1, Math.floor((now - fromMs) / bucketMs))
  const minutesPerBucket = bucketMs / 60_000

  const buckets = Array.from({ length: count }, (_, i) => {
    const tsStart = fromMs + i * bucketMs
    // Two beats: a slow multi-day swell and a diurnal cycle.
    const swell = 0.5 + 0.5 * Math.sin((i / count) * Math.PI * 3)
    const daily = 0.55 + 0.45 * Math.sin((tsStart / 3_600_000 / 24) * Math.PI * 2)
    const load = swell * daily
    const nodeCount = Math.round(load * 5)
    const powerW = nodeCount * (240 + 60 * daily)
    return {
      tsStart,
      cost: nodeCount * 0.42 * (minutesPerBucket / 60),
      wh: (powerW * minutesPerBucket) / 60,
      co2g: mockCo2((powerW * minutesPerBucket) / 60),
      avgPowerW: nodeCount > 0 ? powerW : null,
      gpuUtil: nodeCount > 0 ? 62 + 34 * daily : null,
      nodeCount
    }
  })

  const spend = buckets.reduce((a, b) => a + b.cost, 0)
  const wh = buckets.reduce((a, b) => a + b.wh, 0)
  const co2 = (x: number): number => mockCo2(x)
  const nodeMinutes = buckets.reduce((a, b) => a + b.nodeCount * minutesPerBucket, 0)
  const draws = buckets.map((b) => b.avgPowerW ?? 0)

  // Balance falls with spend, with a top-up two-thirds of the way through.
  let running = 80 + spend
  const balancePoints = buckets
    .filter((_, i) => i % Math.max(1, Math.floor(count / 40)) === 0)
    .map((b, i, arr) => {
      running -= spend / arr.length
      if (i === Math.floor(arr.length * 0.66)) running += 50
      return { ts: b.tsStart, balance: Math.round(running * 100) / 100 }
    })

  // Jobs take a fixed share of the total between them, leaving a plausible
  // idle/provisioning remainder — the mock has to reconcile the same way the
  // real query does, or the screenshot shows a story that can't happen.
  const names = ['hero_shot_v12', 'lookdev_turntable', 'bg_plate_a', 'fx_smoke_r3', 'title_seq']
  const ATTRIBUTED = 0.83
  const weights = names.map((_, i) => 1 / (i + 1.6))
  const weightSum = weights.reduce((a, x) => a + x, 0)
  const topJobs = names.map((name, i) => {
    const share = (weights[i] / weightSum) * ATTRIBUTED
    const cost = spend * share
    const framesDone = 420 - i * 71
    return {
      jobId: `job-${i + 1}`,
      name,
      engine: (i % 2 === 0 ? 'cycles' : 'eevee') as EngineId,
      state: (i === 0 ? 'running' : 'complete') as JobState,
      cost,
      wh: wh * share,
      co2g: co2(wh * share),
      gpuHours: (nodeMinutes * share) / 60,
      framesDone,
      costPerFrame: cost / framesDone
    }
  })
  const attributed = topJobs.reduce((a, j) => a + j.cost, 0)

  return {
    range,
    bucketMs,
    fromMs,
    earliestMs,
    buckets,
    balancePoints,
    totals: {
      cost: spend,
      wh,
      co2g: co2(wh),
      co2Sources: MOCK_GRIDS.map((g) => ({ ...intensityFor(g.geo), wh: wh * g.share }))
        .map(({ country, gPerKwh, wh: w }) => ({ country, gPerKwh, wh: w }))
        .sort((a, b) => a.gPerKwh - b.gPerKwh),
      nodeHours: nodeMinutes / 60,
      avgPowerW: draws.reduce((a, x) => a + x, 0) / draws.length,
      peakPowerW: Math.max(...draws),
      peakNodes: Math.max(0, ...buckets.map((b) => b.nodeCount)),
      balanceStart: balancePoints[0]?.balance ?? null,
      balanceEnd: balancePoints[balancePoints.length - 1]?.balance ?? null
    },
    topJobs,
    unattributedCost: Math.max(0, spend - attributed),
    unattributedWh: Math.max(0, wh - topJobs.reduce((a, j) => a + j.wh, 0)),
    unattributedCo2g: co2(Math.max(0, wh - topJobs.reduce((a, j) => a + j.wh, 0)))
  }
}

export function registerIpc(): void {
  // -- settings (real) ------------------------------------------------------
  // VR_MOCK asserts the key too: mock mode exists to drive the UI on a
  // throwaway profile, and without this Fleet renders its "no API key" empty
  // state instead of the mock nodes, so the mocks are unreachable.
  handle('settings:get', () => (MOCK ? { ...getSettings(), hasVastApiKey: true } : getSettings()))
  handle('settings:set', (patch) => updateSettings(patch))
  handle('settings:setSecret', (key, value) => setSecret(key, value))

  // -- shell / dialogs (real) ----------------------------------------------
  handle('clipboard:write', (text) => {
    clipboard.writeText(text)
  })
  handle('shell:openExternal', async (url) => {
    // http(s) links only (billing page etc.) — never arbitrary protocols.
    if (/^https?:\/\//.test(url)) await shell.openExternal(url)
  })
  handle('shell:openPath', async (p) => {
    await shell.openPath(p)
  })
  handle('shell:showItemInFolder', (p) => {
    shell.showItemInFolder(p)
  })
  handle('dialog:pickBlendFiles', async () => {
    const r = await dialog.showOpenDialog({
      title: 'Choose .blend files',
      filters: [{ name: 'Blender scenes', extensions: ['blend'] }],
      properties: ['openFile', 'multiSelections']
    })
    return r.canceled ? [] : r.filePaths
  })
  handle('dialog:pickZipFile', async () => {
    const r = await dialog.showOpenDialog({
      title: 'Choose extension zip',
      filters: [{ name: 'Extension zip', extensions: ['zip'] }],
      properties: ['openFile']
    })
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  })
  handle('dialog:pickFolder', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  })

  // -- vast.ai --------------------------------------------------------------
  handle('vast:testKey', async () => {
    try {
      const u = await currentUser()
      const credit = u.credit ?? u.balance
      return {
        ok: true,
        message: `OK — account ${u.email ?? u.user ?? u.id}${credit != null ? `, credit $${Number(credit).toFixed(2)}` : ''}`
      }
    } catch (e) {
      return { ok: false, message: (e as Error).message }
    }
  })
  handle('vast:searchOffers', (partial) => {
    const filters = { ...getSettings().offerFilters, ...partial }
    return findOffers(filters)
  })

  // -- fleet / nodes --------------------------------------------------------
  handle('nodes:list', () => (MOCK ? mockNodes() : nodeManager.list()))
  handle('node:chunks', ({ nodeId, limit }) =>
    MOCK ? mockNodeChunks(nodeId) : nodeChunks(nodeId, limit)
  )
  handle('frames:thumbs', ({ jobId, from, to }) =>
    MOCK ? mockThumbs(from, to) : frameThumbs(jobId, from, to)
  )
  handle('preview:subscribe', async ({ chunkId, on }) => {
    if (MOCK) return
    await scheduler.setPreviewSubscription(chunkId, on)
  })
  handle('fleet:setMaxNodes', (n) => {
    updateSettings({ maxActiveNodes: n })
  })
  handle('fleet:requestNode', async () => {
    await nodeManager.requestNode()
  })
  handle('node:destroy', (id) => nodeManager.destroyNode(id))
  handle('node:reprovision', () => {})
  handle('node:openVncTunnel', async (nodeId) => {
    const node = nodeManager.get(nodeId)
    if (!node?.ssh) throw new Error('node not connected')
    const { openVncTunnel } = await import('./octane/octaneLicense')
    return openVncTunnel(node.ssh, nodeId)
  })
  handle('node:sshCommand', (nodeId) => {
    const snap = MOCK
      ? (mockNodes().find((n) => n.id === nodeId) ?? null)
      : (nodeManager.get(nodeId)?.snapshot ?? null)
    return snap ? sshTargetFor(snap) : null
  })
  handle('node:openSshTerminal', (nodeId) => {
    const snap = MOCK
      ? (mockNodes().find((n) => n.id === nodeId) ?? null)
      : (nodeManager.get(nodeId)?.snapshot ?? null)
    const target = snap ? sshTargetFor(snap) : null
    if (!target) return { ok: false, message: 'node has no ssh endpoint yet' }
    return openSshTerminal(target)
  })

  // -- jobs -----------------------------------------------------------------
  handle('jobs:list', () => (MOCK ? mockJobs() : listJobs()))
  handle('job:get', (id) => (MOCK ? mockJobDetail(id) : getJob(id)))
  handle('job:create', async (sub) => {
    const jobId = await createJob(sub)
    scheduler.kick()
    return { jobId }
  })
  handle('job:cancel', (id) => scheduler.cancelJob(id))
  handle('job:setShareNode', (id, shareNode) => {
    setJobShareNode(id, shareNode)
    // Newly shareable chunks may now fit alongside work already in flight.
    scheduler.kick()
  })
  handle('job:retryMissing', () => {})

  // -- scheduler ------------------------------------------------------------
  handle('scheduler:recoveryHold', () => {
    if (MOCK) return null
    const chunks = scheduler.recoveryHoldCount()
    return chunks == null ? null : { chunks }
  })
  handle('scheduler:resumeRecovery', () => scheduler.resumeRecovery())

  // -- history --------------------------------------------------------------
  handle('history:summary', (range) => (MOCK ? mockHistory(range) : historySummary(range)))

  // -- addons ---------------------------------------------------------------
  handle('addons:list', () => listAddons())
  handle('addon:register', (zipPath) => registerAddon(zipPath))
  handle('addon:remove', (id) => removeAddon(id))

  // -- assets ---------------------------------------------------------------
  handle('assets:index', (jobId) => {
    if (MOCK) return mockAssets(jobId)
    const db = getDb()
    const rows = db
      .prepare('SELECT * FROM assets WHERE job_id = ? ORDER BY created_at')
      .all(jobId) as Array<{
      chunk_id: string | null
      kind: string
      abs_path: string
      fps: number | null
      frames: number | null
      width: number | null
      height: number | null
      codec: string | null
      hdr: number
    }>
    // Allow-list, not `kind !== 'frame'`: a deny-list silently admits every
    // future asset kind into the gallery, mislabelled as SDR.
    const clips = rows
      .filter((r) => CLIP_KINDS.includes(r.kind))
      .map((r) => ({
        kind: r.kind as ClipKind,
        chunkId: r.chunk_id ?? '',
        label: `${r.chunk_id ?? ''} ${r.kind === 'previewHdr' ? 'HDR' : r.kind === 'proxy' ? 'proxy' : 'SDR'}`,
        absPath: r.abs_path,
        mediaUrl: toMediaUrl(r.abs_path),
        fps: r.fps ?? 25,
        frames: r.frames ?? 0,
        width: r.width ?? 0,
        height: r.height ?? 0,
        codec: (r.codec ?? 'hevc') as 'hevc' | 'av1',
        hdr: r.hdr === 1
      }))
    const frameRows = db
      .prepare(
        "SELECT frame, chunk_id, local_path, size_bytes FROM frames WHERE job_id = ? AND state = 'downloaded' ORDER BY frame"
      )
      .all(jobId) as Array<{
      frame: number
      chunk_id: string
      local_path: string | null
      size_bytes: number | null
    }>
    const frames = frameRows
      .filter((f) => f.local_path)
      .map((f) => ({
        frame: f.frame,
        chunkId: f.chunk_id,
        absPath: f.local_path as string,
        sizeBytes: f.size_bytes ?? 0
      }))
    return { jobId, clips, frames }
  })

  // -- logs -----------------------------------------------------------------
  handle('logs:getTail', async ({ nodeId, chunkId, lines }) => {
    let targetNodeId = nodeId
    if (!targetNodeId && chunkId) {
      const row = getDb().prepare('SELECT node_id FROM chunks WHERE id = ?').get(chunkId) as
        { node_id: string | null } | undefined
      targetNodeId = row?.node_id ?? undefined
    }
    if (!targetNodeId) return []
    const node = nodeManager.get(targetNodeId)
    if (!node?.ssh) return []
    const file = chunkId ? `${REMOTE_ROOT}/logs/${chunkId}.log` : `${REMOTE_ROOT}/logs/agent.log`
    const r = await node.ssh.exec(`tail -n ${Math.min(lines, 5000)} '${file}' 2>/dev/null`)
    return r.stdout.split('\n')
  })
}
