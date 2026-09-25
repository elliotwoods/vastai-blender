/**
 * Registers every ipcMain.handle channel from the shared contract, and
 * forwards the main-process event bus (events.ts) to the renderer windows.
 * Real implementations arrive phase by phase; anything not yet built returns
 * an honest empty/stub result (and mock data under VR_MOCK=1 for UI
 * development).
 */

import { BrowserWindow, Notification, clipboard, dialog, ipcMain, shell } from 'electron'
import {
  isStickyAlert,
  type InvokeChannel,
  type IpcEventMap,
  type IpcEventMapPending,
  type IpcInvokeMap,
  isBillingRisk
} from '../shared/ipc'
import type {
  AlertEvent,
  AssetIndex,
  ChunkSnapshot,
  ChunkState,
  ClipAsset,
  ClipKind,
  FrameSegment,
  EngineId,
  FleetHoldKind,
  JobDetail,
  HistoryRange,
  HistorySummary,
  JobState,
  JobSummary,
  NodeChunkView,
  NodeSnapshot,
  RequestNodeOptions,
  ThumbAsset
} from '../shared/models'
import { applySettingsPatch, describeFieldErrors, type GateOptions } from './app/settingsGate'
import { cancelJob, reprovisionNode, retryMissing } from './app/recovery'
import { externalUrl, openPathVerdict, revealPath } from './app/windowPolicy'
import { dismissAlerts, emit, onAlertSurfaced, onEvent, recentAlerts } from './events'
import { hostPathFlavour } from './paths'
import { getSettings, setSecret, updateSettings } from './settings'
import { findOffers } from './vast/offers'
import { testVastKey } from './vast/keyTest'
import { nodeManager } from './nodes/nodeManager'
import {
  fleetGpuHistory,
  nodeHistory,
  onSample,
  record as recordMetrics
} from './nodes/metricsHistory'
import { listAddons, registerAddon, removeAddon } from './addons/addons'
import { createJob, getJob, listJobs, setJobShareNode } from './jobs/jobs'
import { scheduler } from './scheduler/scheduler'
import { co2Grams, intensityFor } from './carbon/intensity'
import { getDb } from './db/db'
import { jobFileMediaUrl, toMediaUrl } from './mediaUrl'
import { resolveRange, summary as historySummary } from './history/history'
import { REMOTE_ROOT } from './nodes/provisioner'
import { shq } from './ssh/shq'
import { openSshTerminal, sshTargetFor } from './ssh/sshTerminal'

type Handler<C extends InvokeChannel> = (
  ...args: IpcInvokeMap[C]['args']
) => Promise<IpcInvokeMap[C]['result']> | IpcInvokeMap[C]['result']

function handle<C extends InvokeChannel>(channel: C, handler: Handler<C>): void {
  ipcMain.handle(channel, (_event, ...args) => handler(...(args as IpcInvokeMap[C]['args'])))
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
              j.name AS job_name, j.engine, j.frame_step, j.output_dir
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
    output_dir: string
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
    gpu: scheduler.gpuOf(r.id),
    assignedAt: r.assigned_at,
    thumbUrl: thumbByChunk.has(r.id)
      ? jobFileMediaUrl(r.job_id, r.output_dir, thumbByChunk.get(r.id) as string)
      : null
  }))
}

/** A job's jobs.output_dir, or null for no such job. */
function jobOutputDir(jobId: string): string | null {
  const row = getDb().prepare('SELECT output_dir FROM jobs WHERE id = ?').get(jobId) as
    { output_dir: string } | undefined
  return row?.output_dir ?? null
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
  const outputDir = rows.length > 0 ? jobOutputDir(jobId) : null
  return rows.map((r) => ({
    frame: r.frame,
    chunkId: r.chunk_id,
    absPath: r.thumb_path,
    mediaUrl: outputDir ? jobFileMediaUrl(jobId, outputDir, r.thumb_path) : toMediaUrl(r.thumb_path)
  }))
}

/**
 * The folders shell:openPath may open things in: the project root, and every
 * job's output folder, since a job keeps the folder it was created under when
 * the project root later moves.
 */
function openableRoots(): string[] {
  const jobDirs = getDb().prepare('SELECT DISTINCT output_dir FROM jobs').all() as Array<{
    output_dir: string
  }>
  return [getSettings().projectRoot, ...jobDirs.map((r) => r.output_dir)]
}

/**
 * What shell:showItemInFolder may reveal: the folders shell:openPath opens
 * things in, plus the files the renderer reveals that live outside them — a
 * job's .blend, an addon's zip, the SSH key. Anything else (a UNC path, which
 * on Windows would hand an NTLM hash to whoever serves it) is refused.
 */
function revealablePlaces(): string[] {
  const blends = getDb().prepare('SELECT DISTINCT blend_path FROM jobs').all() as Array<{
    blend_path: string
  }>
  return [
    ...openableRoots(),
    ...blends.map((r) => r.blend_path),
    ...listAddons().map((a) => a.zipPath),
    getSettings().sshKeyPath
  ]
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
  // One stitched job clip, so VR_MOCK exercises the overlay's job mode. The
  // fixture is 100 frames; claim the first 100 frames of the job for it.
  if (detail) {
    const job = fixtureClip('previewSdr', '', 'probe_sdr_hevc.mp4', false)
    const end = Math.min(detail.frameEnd, detail.frameStart + 99 * detail.frameStep)
    clips.push({
      ...job,
      scope: 'job',
      label: 'job SDR',
      segments: [{ start: detail.frameStart, end }]
    })
  }
  return { jobId, clips, frames: [] }
}

function fixtureClip(kind: ClipKind, chunkId: string, file: string, hdr: boolean): ClipAsset {
  return {
    kind,
    scope: 'chunk',
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
    gpu: 0,
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
    gpu: 1,
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
    gpu: null,
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
    gpu: null,
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

/**
 * Bring the app's window to the front, or open one when there is none: on
 * macOS the app keeps running, and the fleet billing, with its window closed.
 * As index.ts does for a second launch.
 */
function showWindow(createWindow: (() => void) | undefined): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) {
    createWindow?.()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/**
 * Notifications not yet clicked or closed. An Electron Notification that
 * nothing references any more can be garbage-collected, and its click handler
 * with it, so each is held here until then. Only the newest few: an older one
 * let go stays on the desktop, and a click on it just does nothing.
 */
const heldNotifications = new Set<Notification>()
const MAX_HELD_NOTIFICATIONS = 20

/**
 * An OS notification for an error or billing risk that has just surfaced
 * (events.ts's onAlertSurfaced) while no window of the app is in front: it is
 * behind another app, minimised, or closed altogether. The banner is where it
 * is dealt with; clicking this goes there. Raised here in main rather than in
 * the window, which cannot notify while closed, and whose own window.focus()
 * may not bring a backgrounded app forward on macOS. A repeat that only
 * counts up does not surface, so a failure every 15 s notifies once per quiet
 * period; a billing risk has none (RESURFACE_MS).
 */
function notifyUnattended(alert: AlertEvent, createWindow: (() => void) | undefined): void {
  if (!isStickyAlert(alert) || BrowserWindow.getFocusedWindow()) return
  if (!Notification.isSupported()) return
  // Billing risks always notify at once: they are rare, and each one is an
  // instance that may be costing money. Plain errors come in storms — a dead
  // node fails dispatch for every pending chunk, each with its own message —
  // so they are paced, and whatever is held back becomes one summary.
  if (!isBillingRisk(alert)) {
    const now = Date.now()
    const wait = lastErrorNotifyAt + ERROR_NOTIFY_GAP_MS - now
    if (wait > 0) {
      heldBackErrors++
      trailingNotify ??= setTimeout(() => {
        trailingNotify = null
        const n = heldBackErrors
        heldBackErrors = 0
        if (n === 0 || BrowserWindow.getFocusedWindow() || !Notification.isSupported()) return
        lastErrorNotifyAt = Date.now()
        showNotification(
          `${n} more error${n === 1 ? '' : 's'} — open Vast Render to see them`,
          createWindow
        )
      }, wait)
      return
    }
    lastErrorNotifyAt = now
  }
  showNotification(alert.message, createWindow)
}

/** Errors (not billing risks) notify at most this often; see notifyUnattended. */
const ERROR_NOTIFY_GAP_MS = 20_000
let lastErrorNotifyAt = -Infinity
let heldBackErrors = 0
let trailingNotify: ReturnType<typeof setTimeout> | null = null

function showNotification(body: string, createWindow: (() => void) | undefined): void {
  const n = new Notification({ title: 'Vast Render', body })
  const release = (): void => {
    heldNotifications.delete(n)
  }
  n.on('click', () => {
    release()
    showWindow(createWindow)
  })
  n.on('close', release)
  heldNotifications.add(n)
  if (heldNotifications.size > MAX_HELD_NOTIFICATIONS) {
    const [oldest] = heldNotifications
    heldNotifications.delete(oldest)
  }
  n.show()
}

/** settings.ts, as the settings gate reads and saves it. */
const settingsStore = {
  getSettings: () => getSettings(),
  updateSettings: (patch: Parameters<typeof updateSettings>[0]) => updateSettings(patch)
}

function gateOptions(): GateOptions {
  return { pathFlavour: hostPathFlavour() }
}

/** Every push channel, the bus's and Phase 1's pending ones. */
type PushMap = IpcEventMap & IpcEventMapPending

/** A push to every window, for a channel the bus does not carry (IpcEventMapPending). */
function sendPush<C extends keyof PushMap>(channel: C, payload: PushMap[C]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send(channel, payload)
    } catch (e) {
      // A window going away mid-send: the rest still hear it.
      console.warn(`[ipc] ${channel} to a window failed:`, e)
    }
  }
}

const HOLD_KINDS: ReadonlySet<string> = new Set<FleetHoldKind>([
  'account',
  'recovery',
  'localSink',
  'scale',
  'octaneSignIn'
])

/**
 * fleet:requestNode's options as main will act on them: an over-cap flag
 * only when it is `true`, and a price bound only when it is a finite
 * non-negative number. The renderer's argument is only as typed as the
 * renderer (#159).
 */
function requestOptions(opts: RequestNodeOptions | undefined): RequestNodeOptions {
  const max = opts?.maxPerHour
  return {
    overSpendCap: opts?.overSpendCap === true,
    maxPerHour: typeof max === 'number' && Number.isFinite(max) && max >= 0 ? max : null
  }
}

/** A history query's numbers, whatever arrived: metricsHistory clamps what is left. */
function historyQuery(
  q: Partial<{ fromMs: number; toMs: number; maxPoints: number }> | undefined
): {
  fromMs: number
  toMs: number
  maxPoints: number
} {
  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback
  const now = Date.now()
  return {
    fromMs: num(q?.fromMs, now - 60 * 60_000),
    toMs: num(q?.toMs, now),
    maxPoints: num(q?.maxPoints, 240)
  }
}

/**
 * VR_MOCK: six hours of GPU usage for the mock nodes, then a sample every
 * 15 s, so the Fleet screen's usage graphs have shape for screenshots
 * (Feature G). Deterministic: the same instant gives the same readings.
 * node-a's two GPUs render with a dip and an idle stretch on GPU 1 while
 * it holds a run (paid but idle), and a gap where the node was unreachable;
 * node-b is newer and idle.
 */
function startMockMetrics(): void {
  const STEP = 15_000 // the real probe cadence: a coarser backfill leaves every other 30 s bucket empty
  const reading = (nodeId: string, ts: number): Parameters<typeof recordMetrics>[1] => {
    const t = ts / 60_000
    const gpus =
      nodeId === 'node-a'
        ? [0, 1].map((index) => {
            const idleStretch = index === 1 && Math.floor(t / 45) % 5 === 2
            const util = idleStretch
              ? 3
              : Math.round(
                  88 + 9 * Math.sin(t / (7 + index * 3)) - (Math.floor(t) % 29 === 0 ? 40 : 0)
                )
            return {
              index,
              util,
              vramUsedGb: Math.round((14 + 3 * Math.sin(t / 23 + index)) * 10) / 10,
              vramTotalGb: 24,
              temp: 60 + Math.round(util / 8),
              powerW: Math.round(90 + util * 3.4)
            }
          })
        : [{ index: 0, util: 1, vramUsedGb: 0.4, vramTotalGb: 24, temp: 34, powerW: 21 }]
    const util = gpus.reduce((a, g) => a + g.util, 0) / gpus.length
    return {
      gpuUtil: util,
      vramUsedGb: gpus.reduce((a, g) => a + g.vramUsedGb, 0),
      vramTotalGb: gpus.reduce((a, g) => a + g.vramTotalGb, 0),
      gpuTemp: Math.max(...gpus.map((g) => g.temp)),
      powerW: gpus.reduce((a, g) => a + g.powerW, 0),
      powerLimitW: 450 * gpus.length,
      cpuUtil: nodeId === 'node-a' ? 40 + 10 * Math.sin(t / 11) : 2,
      cpuLoad1: 4,
      cpuCores: 16,
      ramUsedGb: nodeId === 'node-a' ? 21 : 3,
      ramTotalGb: 64,
      updatedAt: ts,
      gpus
    }
  }
  const runs = (nodeId: string): { runs: number[]; unpinned: number } =>
    nodeId === 'node-a' ? { runs: [1, 1], unpinned: 1 } : { runs: [0], unpinned: 0 }
  const sample = (nodeId: string, ts: number): void => {
    // node-a unreachable for ten minutes an hour and a half ago: a gap.
    const ago = Date.now() - ts
    const gap = nodeId === 'node-a' && ago > 90 * 60_000 && ago < 100 * 60_000
    recordMetrics(nodeId, gap ? null : reading(nodeId, ts), runs(nodeId), {
      numGpus: nodeId === 'node-a' ? 2 : 1,
      ts
    })
  }
  // node-b was rented three minutes ago (mockNodes).
  const now = Date.now()
  for (let ts = now - 6 * 60 * 60_000; ts <= now; ts += STEP) {
    sample('node-a', ts)
    if (ts >= now - 3 * 60_000) sample('node-b', ts)
  }
  setInterval(() => {
    sample('node-a', Date.now())
    sample('node-b', Date.now())
  }, 15_000)
}

export interface RegisterIpcOptions {
  /**
   * index.ts's createWindow, for a notification clicked while no window is
   * open. Without it such a click does nothing.
   */
  createWindow?: () => void
}

export function registerIpc(opts: RegisterIpcOptions = {}): void {
  // -- events ---------------------------------------------------------------
  // Every bus event goes to every window. Subscribed here, once, before
  // index.ts starts the node manager and scheduler (the first emitters) and
  // before any window exists, so nothing a window could receive is missed.
  onEvent(({ channel, payload }) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(channel, payload)
    }
  })
  // Phase 1's push channels (shared/ipc.ts IpcEventMapPending), straight to
  // the windows: holds as they change, the unclaimed list as a reconcile
  // changes it, and every metrics sample.
  scheduler.onHoldsChanged((holds) => sendPush('fleet:holds', holds))
  nodeManager.onUnclaimedChanged((list) => sendPush('fleet:unclaimed', list))
  onSample((sample) => sendPush('node:metricsSample', sample))
  if (MOCK) startMockMetrics()
  // An error or billing risk nobody is looking at: an OS notification too.
  // This runs inside emit, before the windows hear the alert, so a failure
  // here is logged and goes no further. It must never cost the user the
  // alert itself, or throw into the destroy path that raised it.
  onAlertSurfaced((alert) => {
    try {
      notifyUnattended(alert, opts.createWindow)
    } catch (e) {
      console.warn('[alerts] OS notification failed:', e)
    }
  })
  // What a window missed: alerts raised before it existed (or while it was
  // closed) went to no one above. events.ts keeps the recent ones.
  handle('alerts:recent', () => recentAlerts())
  handle('alerts:dismiss', (keys) => dismissAlerts(keys))

  // -- settings (real) ------------------------------------------------------
  // VR_MOCK asserts the key too: mock mode exists to drive the UI on a
  // throwaway profile, and without this Fleet renders its "no API key" empty
  // state instead of the mock nodes, so the mocks are unreachable.
  handle('settings:get', () => (MOCK ? { ...getSettings(), hasVastApiKey: true } : getSettings()))
  // Every patch from the renderer goes through the sanitizer, and only what
  // passed is saved (plan 1.14, app/settingsGate.ts). settings:update says
  // which fields did not and why; settings:set keeps its contract for its
  // callers and only logs them.
  handle('settings:set', (patch) => {
    const { settings, errors } = applySettingsPatch(patch, settingsStore, gateOptions())
    if (errors.length) console.warn(`[settings] not saved as sent: ${describeFieldErrors(errors)}`)
    return settings
  })
  handle('settings:update', (patch) => applySettingsPatch(patch, settingsStore, gateOptions()))
  handle('settings:setSecret', (key, value) => {
    setSecret(key, value)
    // A new key may be another account, and a hold the old key caused says
    // nothing about it (plan 1.20): reconcile and read the balance now
    // rather than at the next cost tick, and lift an auth hold (plan 1.3).
    if (key === 'vastApiKey' && !MOCK) void nodeManager.onApiKeySaved()
  })

  // -- shell / dialogs (real) ----------------------------------------------
  handle('clipboard:write', (text) => {
    clipboard.writeText(text)
  })
  handle('shell:openExternal', async (url) => {
    // http(s) links only (billing page etc.) — never arbitrary protocols.
    const safe = externalUrl(url)
    if (safe) await shell.openExternal(safe)
  })
  handle('shell:openPath', async (p) => {
    // openPath is "double-click this": on Windows it runs an .exe or .bat, and
    // frame paths are named by rented nodes. So only folders and images or
    // clips inside the project or a job's folder are opened; anything else
    // there is revealed in Explorer/Finder instead, and anything outside is
    // refused. See windowPolicy.ts.
    const verdict = openPathVerdict(p, openableRoots())
    if (verdict.action === 'open') {
      const err = await shell.openPath(verdict.path)
      if (err) console.warn(`[shell] could not open ${verdict.path}: ${err}`)
    } else if (verdict.action === 'reveal') {
      shell.showItemInFolder(verdict.path)
    } else {
      console.warn(`[shell] refused to open ${JSON.stringify(p)}: ${verdict.reason}`)
    }
  })
  handle('shell:showItemInFolder', (p) => {
    const abs = revealPath(p, revealablePlaces())
    if (!abs) {
      console.warn(
        `[shell] refused to reveal ${JSON.stringify(p)}: not a file or folder the app shows`
      )
      return
    }
    shell.showItemInFolder(abs)
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
  handle('vast:testKey', () => testVastKey())
  handle('vast:searchOffers', (partial) => {
    const filters = { ...getSettings().offerFilters, ...partial }
    return findOffers(filters)
  })

  // -- fleet / nodes --------------------------------------------------------
  if (MOCK) {
    // The real fleet is empty under VR_MOCK, so nodeManager's once-a-minute
    // fleet:cost reads $0 and the toolbar pills never show the mock nodes.
    // Emitting faster than it keeps the mock figures on screen.
    const tick = (): void => {
      const live = mockNodes().filter((n) => n.state !== 'destroyed')
      emit('fleet:cost', {
        perHour: live.reduce((a, n) => a + (n.dphTotal ?? 0), 0),
        sessionTotal: 18.42,
        sessionWh: 9120,
        sessionCo2g: mockCo2(9120),
        balance: 142.37
      })
    }
    setInterval(tick, 2000)
  }
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
    // Through the gate like any settings change: "1e3" or NaN from a
    // stepper is refused, not saved as 1000 or as a number no reader
    // expects. A refusal rejects the invoke, so the caller hears of it.
    const { errors } = applySettingsPatch({ maxActiveNodes: n }, settingsStore, gateOptions())
    const refused = errors.filter((e) => e.outcome === 'rejected')
    if (refused.length) throw new Error(describeFieldErrors(refused))
  })
  handle('fleet:requestNode', async (opts) => {
    if (MOCK) return
    await nodeManager.requestNode(requestOptions(opts))
  })
  handle('fleet:cost', () =>
    MOCK
      ? { perHour: 0.822, sessionTotal: 0.44, sessionWh: 612, sessionCo2g: 0, balance: 42.17 }
      : nodeManager.fleetCost()
  )
  handle('fleet:clearFailed', () => nodeManager.clearFailed())
  // The Unclaimed panel (plan 1.3): instances on the account no node of this
  // profile holds. Only one of them may be destroyed from here, and only by
  // its id as the list shows it: nodeManager refuses anything else, the
  // instance of a node of this profile included.
  handle('fleet:unclaimed', () => (MOCK ? [] : nodeManager.listUnclaimed()))
  handle('fleet:destroyUnclaimed', async (instanceId) => {
    if (!Number.isSafeInteger(instanceId) || instanceId <= 0) {
      return { ok: false, message: `not an instance id: ${JSON.stringify(instanceId)}` }
    }
    if (MOCK) return { ok: false, message: 'mock mode destroys nothing' }
    return nodeManager.destroyUnclaimed(instanceId)
  })
  // Every reason the fleet is not renting, and the user releasing one.
  handle('fleet:holds', () => (MOCK ? {} : scheduler.fleetHolds()))
  handle('fleet:releaseHold', async (kind) => {
    if (!HOLD_KINDS.has(kind)) throw new Error(`no such hold: ${JSON.stringify(kind)}`)
    if (MOCK) return {}
    return scheduler.releaseHold(kind)
  })
  // GPU usage over time (Feature G).
  handle('fleet:gpuHistory', (q) => fleetGpuHistory(historyQuery(q)))
  handle('node:metricsHistory', (q) => {
    if (typeof q?.nodeId !== 'string') throw new Error('node:metricsHistory needs a nodeId')
    return nodeHistory({ ...historyQuery(q), nodeId: q.nodeId })
  })
  handle('node:destroy', (id) => nodeManager.destroyNode(id))
  // Restart the node's agent and requeue its work (plan 1.15, app/recovery.ts).
  handle('node:reprovision', (id) => (MOCK ? { requeued: 0 } : reprovisionNode(id)))
  // Only from the user's "Open VNC login" click: a tunnel opened is taken as
  // the user at the node's desktop, and ends a missed sign-in's hold on
  // Octane rentals (octaneLicense.openVncTunnel).
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
    // createJob refuses a scene that is not a file on this computer
    // (validateSubmission): its path is somewhere shell:showItemInFolder may
    // reveal, and a UNC path there hands the user's NTLM hash to whoever
    // serves the share (Phase 0 review, plans 1.12 and 1.14).
    const jobId = await createJob(sub)
    scheduler.kick()
    return { jobId }
  })
  // Through app/recovery.ts, which notes the cancel until it has stopped the
  // job's renders on the nodes: job:retryMissing waits for that (plan 1.15).
  handle('job:cancel', (id) => cancelJob(id))
  handle('job:setShareNode', (id, shareNode) => {
    setJobShareNode(id, shareNode)
    // Newly shareable chunks may now fit alongside work already in flight.
    scheduler.kick()
  })
  // Queue the frames not yet downloaded again (plan 1.15, app/recovery.ts).
  // A refusal (a job failed outright) rejects, so the caller hears why.
  handle('job:retryMissing', (id) => (MOCK ? { frames: 0, chunks: 0 } : retryMissing(id)))
  // Release a job the retry breaker held (plan 1.17). Without it every hold
  // ended in cancel and resubmit: a new output folder, and every frame
  // already rendered paid for again.
  handle('job:resume', (id) => (MOCK ? false : scheduler.resumeJob(id)))

  // -- scheduler ------------------------------------------------------------
  handle('scheduler:recoveryHold', () => {
    if (MOCK) return null
    const chunks = scheduler.recoveryHoldCount()
    return chunks == null ? null : { chunks }
  })
  handle('scheduler:resumeRecovery', () => scheduler.resumeRecovery())
  handle('scheduler:scaleStatus', () => (MOCK ? null : scheduler.scaleStatus()))

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
      segments: string | null
    }>
    const outputDir = jobOutputDir(jobId)
    // Allow-list, not `kind !== 'frame'`: a deny-list silently admits every
    // future asset kind into the gallery, mislabelled as SDR.
    const clips = rows
      .filter((r) => CLIP_KINDS.includes(r.kind))
      .map((r) => ({
        kind: r.kind as ClipKind,
        // chunk_id NULL = a stitched job clip (see transfer/jobClip.ts)
        scope: r.chunk_id == null ? ('job' as const) : ('chunk' as const),
        segments: r.segments ? (JSON.parse(r.segments) as FrameSegment[]) : undefined,
        chunkId: r.chunk_id ?? '',
        label: `${r.chunk_id ?? 'job'} ${r.kind === 'previewHdr' ? 'HDR' : r.kind === 'proxy' ? 'proxy' : 'SDR'}`,
        absPath: r.abs_path,
        mediaUrl: outputDir
          ? jobFileMediaUrl(jobId, outputDir, r.abs_path)
          : toMediaUrl(r.abs_path),
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
    // A chunk id names a file on the node: only one shaped like the ids this
    // app makes (no '/', no '..'), whatever the renderer sent.
    if (chunkId != null && !/^[\w-]+$/.test(chunkId)) return []
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
    const n = Math.max(1, Math.min(5000, Math.floor(Number(lines)) || 200))
    const r = await node.ssh.exec(`tail -n ${n} ${shq(file)} 2>/dev/null`, {
      timeoutMs: 30_000,
      label: 'read log'
    })
    return r.stdout.split('\n')
  })
}
