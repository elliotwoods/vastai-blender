/**
 * Registers every ipcMain.handle channel from the shared contract and owns
 * the event-push helper. Real implementations arrive phase by phase; anything
 * not yet built returns an honest empty/stub result (and mock data under
 * VR_MOCK=1 for UI development).
 */

import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { relative, sep } from 'path'
import type { EventChannel, IpcEventMap, InvokeChannel, IpcInvokeMap } from '../shared/ipc'
import type { JobSummary, NodeSnapshot } from '../shared/models'
import { getSettings, setSecret, updateSettings } from './settings'
import { findOffers } from './vast/offers'
import { currentUser } from './vast/vastClient'
import { nodeManager } from './nodes/nodeManager'
import { listAddons, registerAddon, removeAddon } from './addons/addons'
import { createJob, getJob, listJobs } from './jobs/jobs'
import { scheduler } from './scheduler/scheduler'
import { getDb } from './db/db'
import { REMOTE_ROOT } from './nodes/provisioner'

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
    currentChunkId: 'chunk-3 (frames 51–75)',
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
      cpuLoad1: 6.3,
      cpuCores: 16,
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
    currentChunkId: null,
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
    blenderVersion: '4.5.3'
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
    blenderVersion: '4.3.2'
  }
]

export function registerIpc(): void {
  // -- settings (real) ------------------------------------------------------
  handle('settings:get', () => getSettings())
  handle('settings:set', (patch) => updateSettings(patch))
  handle('settings:setSecret', (key, value) => setSecret(key, value))

  // -- shell / dialogs (real) ----------------------------------------------
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

  // -- jobs -----------------------------------------------------------------
  handle('jobs:list', () => (MOCK ? mockJobs() : listJobs()))
  handle('job:get', (id) => getJob(id))
  handle('job:create', async (sub) => {
    const jobId = await createJob(sub)
    scheduler.kick()
    return { jobId }
  })
  handle('job:cancel', (id) => scheduler.cancelJob(id))
  handle('job:retryMissing', () => {})

  // -- addons ---------------------------------------------------------------
  handle('addons:list', () => listAddons())
  handle('addon:register', (zipPath) => registerAddon(zipPath))
  handle('addon:remove', (id) => removeAddon(id))

  // -- assets ---------------------------------------------------------------
  handle('assets:index', (jobId) => {
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
    const root = getSettings().projectRoot
    const toMediaUrl = (absPath: string): string =>
      `media://project/${relative(root, absPath).split(sep).join('/')}`
    const clips = rows
      .filter((r) => r.kind !== 'frame')
      .map((r) => ({
        kind: r.kind as 'previewSdr' | 'previewHdr' | 'proxy',
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
