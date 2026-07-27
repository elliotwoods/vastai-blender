/**
 * The fleet scheduler: assigns pending chunks to idle nodes, dispatches them
 * to the node agent (upload blend → write job spec → tail progress → download
 * results), requeues on failure with re-splitting around downloaded frames,
 * and scales the fleet up/down within the user's limits.
 *
 * Single loop, event-kicked + 15s timer. All chunk/job state lives in
 * SQLite; the scheduler is restart-safe (in-flight chunks are re-attached by
 * re-reading the agent's state files).
 */

import { posix } from 'path'
import { getDb } from '../db/db'
import { emit } from '../ipc'
import { refreshJobState } from '../jobs/jobs'
import { installBlender, installExtension, REMOTE_ROOT } from '../nodes/provisioner'
import { getAddon } from '../addons/addons'
import { nodeManager } from '../nodes/nodeManager'
import { getSettings } from '../settings'
import { sftpRename, sftpWriteFile, uploadFileVerified } from '../ssh/sftp'
import { recordThroughput } from '../vast/offers'
import type { SshConnection } from '../ssh/sshConnection'
import { ChunkDownloader } from '../transfer/frameDownloader'
import { missingRanges } from './chunker'
import type { ChunkState, EngineId } from '../../shared/models'

const TICK_MS = 15_000
const STATE_POLL_MS = 5_000
// 4: with many concurrent runs per node, transient SSH channel contention can
// fail a dispatch attempt — the retry budget must absorb a few of those on
// top of genuine render failures.
const MAX_RETRIES = 4

/**
 * Per-node preparation mutex. With nodeSlots > 1 several ChunkRuns dispatch
 * to one node concurrently; the prep steps (Blender install, extension
 * install/enable + save_userpref, scene upload) are idempotent but NOT
 * concurrency-safe — two blender processes writing userpref/extension repo at
 * once fail with exit 1. Serialize prep per node; the renders themselves
 * still run in parallel.
 */
const nodePrepLocks = new Map<string, Promise<void>>()

/**
 * Extensions already installed per node this session (nodeId:version:id:hash
 * → bootstrap expr or null). Installing is idempotent but costs two blender
 * launches; with many chunks per node it must happen once, not per chunk —
 * repeat runs also proved fragile under SSH channel pressure.
 */
const installedExtensions = new Map<string, string | null>()
async function withNodePrep<T>(nodeId: string, fn: () => Promise<T>): Promise<T> {
  const prev = nodePrepLocks.get(nodeId) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  nodePrepLocks.set(
    nodeId,
    prev.then(() => gate)
  )
  await prev
  try {
    return await fn()
  } finally {
    release()
  }
}

interface ChunkRow {
  id: string
  job_id: string
  frame_start: number
  frame_end: number
  state: ChunkState
  node_id: string | null
  frames_done: number
  retries: number
}

interface JobRow {
  id: string
  blend_path: string
  engine: EngineId
  frame_step: number
  blender_version: string | null
  addon_ids: string
  state: string
}

interface AgentState {
  status: 'rendering' | 'encoding' | 'done' | 'failed'
  currentFrame: number | null
  framesDone: number
  framesTotal?: number
  error?: string
  exitCode: number | null
  /** epoch seconds of the agent's last state write */
  updatedAt?: number
}

/**
 * Stall watchdog: the agent rewrites the chunk state at least every ~2s while
 * its blender is producing output. A state file frozen for this long means
 * the render process died or hung without the agent noticing (observed in
 * the wild: zombie blender after an agent restart) — fail the chunk so the
 * requeue path re-renders only what's missing instead of polling forever.
 */
const STATE_STALL_MS = 15 * 60_000

class ChunkRun {
  private stopped = false
  private downloader: ChunkDownloader | null = null
  private stopTail: (() => void) | null = null
  private dispatchedAt = Date.now()

  constructor(
    readonly chunkId: string,
    readonly jobId: string,
    readonly nodeId: string,
    private readonly ssh: SshConnection
  ) {}

  private setChunk(patch: Record<string, unknown>): void {
    const keys = Object.keys(patch)
    getDb()
      .prepare(`UPDATE chunks SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...keys.map((k) => patch[k]), this.chunkId)
  }

  private chunk(): ChunkRow {
    return getDb().prepare('SELECT * FROM chunks WHERE id = ?').get(this.chunkId) as ChunkRow
  }

  private job(): JobRow {
    return getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(this.jobId) as JobRow
  }

  async dispatch(): Promise<void> {
    const chunk = this.chunk()
    const job = this.job()
    const settings = getSettings()
    const node = nodeManager.get(this.nodeId)
    if (!node) throw new Error('node vanished')

    this.setChunk({ state: 'assigned', node_id: this.nodeId })
    node.setState('rendering')
    refreshJobState(this.jobId)

    // Steps 1-3 are serialized per node (see withNodePrep) — with multiple
    // slots two dispatches would otherwise race on userpref/extension state.
    const remoteBlend = `${this.jobId}.blend`
    const bootstrapExprs: string[] = await withNodePrep(this.nodeId, async () => {
      // 1. Blender version (idempotent, cheap when already installed).
      if (job.blender_version && !node.snapshot.blenderVersions.includes(job.blender_version)) {
        await installBlender(this.ssh, this.nodeId, job.blender_version)
      }

      // 1b. Octane jobs need the X11/VNC + OctaneServer environment (and an
      // OctaneBlender build on the node — see docs/OCTANE.md).
      if (job.engine === 'octane' && !node.snapshot.octaneReady) {
        const { setupOctane } = await import('../octane/octaneLicense')
        await setupOctane(this.ssh, this.nodeId)
      }

      // 2. Extensions for this job (once per node+version+zip — cached; the
      //    bootstrap mechanism contributes a register() expression instead).
      const exprs: string[] = []
      for (const addonId of JSON.parse(job.addon_ids) as string[]) {
        const addon = getAddon(addonId)
        if (!addon) {
          emit('alert', {
            level: 'warn',
            message: `addon ${addonId} missing from registry — skipped`
          })
          continue
        }
        if (job.blender_version) {
          const key = `${this.nodeId}:${job.blender_version}:${addon.id}:${addon.zipHash}`
          let expr: string | null
          if (installedExtensions.has(key)) {
            expr = installedExtensions.get(key) ?? null
          } else {
            expr = await installExtension(this.ssh, this.nodeId, job.blender_version, addon)
            installedExtensions.set(key, expr)
          }
          if (expr) exprs.push(expr)
        }
      }

      // 3. Scene upload (hash-skipped when the node already has this version).
      const result = await uploadFileVerified(
        this.ssh,
        job.blend_path,
        posix.join(REMOTE_ROOT, 'work', 'scenes', remoteBlend)
      )
      emit('render:logLine', {
        nodeId: this.nodeId,
        chunkId: this.chunkId,
        line: `scene upload: ${result}`,
        ts: Date.now()
      })
      return exprs
    })

    // 4. Job spec — written atomically (agent ignores *.tmp.json).
    const spec = {
      chunkId: this.chunkId,
      blendFile: remoteBlend,
      blenderVersion: job.blender_version,
      engine: job.engine,
      frameStart: chunk.frame_start,
      frameEnd: chunk.frame_end,
      frameStep: job.frame_step,
      // Concurrent render slots on the node (1 = historical single-slot).
      nodeSlots: settings.nodeSlots ?? 1,
      extraArgs: [],
      pythonExprs: bootstrapExprs,
      encode: {
        sdr: true,
        hdr: true,
        proxy: true,
        codec: settings.proxyCodec,
        fps: 25
      }
    }
    const sftp = await this.ssh.sftp()
    const inbox = posix.join(REMOTE_ROOT, 'jobs', 'inbox')
    await sftpWriteFile(sftp, `${inbox}/${this.chunkId}.tmp.json`, JSON.stringify(spec))
    await sftpRename(sftp, `${inbox}/${this.chunkId}.tmp.json`, `${inbox}/${this.chunkId}.json`)

    this.setChunk({ state: 'rendering' })
    refreshJobState(this.jobId)

    // 5. Live downloads + log tail + state poll.
    this.downloader = new ChunkDownloader({
      jobId: this.jobId,
      chunkId: this.chunkId,
      nodeId: this.nodeId,
      ssh: this.ssh,
      remoteChunkDir: posix.join(REMOTE_ROOT, 'renders', this.chunkId)
    })
    this.downloader.start()
    // Per-chunk log tails hold one SSH channel each for the chunk's whole
    // lifetime; with many slots per node they alone exhaust the server's
    // channel cap (OpenSSH MaxSessions ~10). State polling remains the
    // durable progress source — only tail on low-concurrency nodes.
    if ((settings.nodeSlots ?? 1) <= 2) void this.tailLog()
    await this.pollUntilDone()
  }

  private async tailLog(): Promise<void> {
    try {
      const { stop } = await this.ssh.execStream(
        `touch ${REMOTE_ROOT}/logs/${this.chunkId}.log && tail -n +1 -F ${REMOTE_ROOT}/logs/${this.chunkId}.log`,
        (line) =>
          emit('render:logLine', {
            nodeId: this.nodeId,
            chunkId: this.chunkId,
            line,
            ts: Date.now()
          })
      )
      this.stopTail = stop
    } catch {
      // tail is best-effort; state polling is the durable source
    }
  }

  private async readAgentState(): Promise<AgentState | null> {
    try {
      const r = await this.ssh.exec(`cat ${REMOTE_ROOT}/state/${this.chunkId}.json 2>/dev/null`)
      if (r.stdout.trim()) return JSON.parse(r.stdout) as AgentState
    } catch {
      // connection hiccup — caller keeps polling
    }
    return null
  }

  private async pollUntilDone(): Promise<void> {
    const chunk = this.chunk()
    const framesTotal =
      Math.floor((chunk.frame_end - chunk.frame_start) / this.job().frame_step) + 1
    for (;;) {
      if (this.stopped) return
      const state = await this.readAgentState()
      if (state) {
        this.setChunk({ frames_done: state.framesDone })
        emit('chunk:progress', {
          chunkId: this.chunkId,
          jobId: this.jobId,
          currentFrame: state.currentFrame,
          framesDone: state.framesDone,
          framesTotal
        })
        if (state.status === 'encoding') this.setChunk({ state: 'encoding' })
        if (state.status === 'done') {
          this.setChunk({ state: 'downloading' })
          refreshJobState(this.jobId)
          await this.downloader?.drain()
          this.finish('complete')
          return
        }
        if (state.status === 'failed') {
          await this.downloader?.drain()
          this.finish('failed', state.error ?? `exit ${state.exitCode}`)
          return
        }
        if (
          state.updatedAt != null &&
          Date.now() - state.updatedAt * 1000 > STATE_STALL_MS &&
          ['rendering', 'encoding'].includes(state.status)
        ) {
          await this.downloader?.drain()
          this.finish(
            'failed',
            `render stalled — no agent state update for ${Math.round(STATE_STALL_MS / 60000)} min`
          )
          return
        }
      }
      await new Promise((r) => setTimeout(r, STATE_POLL_MS))
    }
  }

  private finish(state: 'complete' | 'failed', error?: string): void {
    this.cleanup()
    this.setChunk({ state })
    if (error) {
      emit('alert', { level: 'warn', message: `chunk ${this.chunkId} failed: ${error}` })
    }
    if (state === 'complete') {
      // Feed the machine-selection strategy with measured throughput.
      const elapsedH = (Date.now() - this.dispatchedAt) / 3_600_000
      const chunk = this.chunk()
      const frames = Math.floor((chunk.frame_end - chunk.frame_start) / this.job().frame_step) + 1
      const gpuName = nodeManager.get(this.nodeId)?.snapshot.gpuName
      if (gpuName && elapsedH > 0.005) {
        recordThroughput(gpuName, frames / elapsedH)
      }
    }
    scheduler.onChunkFinished(this)
  }

  /** External stop (cancel / node death). */
  abort(): void {
    this.stopped = true
    this.cleanup()
  }

  private cleanup(): void {
    this.stopped = true
    this.stopTail?.()
    this.downloader?.stop()
  }
}

class Scheduler {
  private runs = new Map<string, ChunkRun>() // chunkId → run
  private byNode = new Map<string, Set<ChunkRun>>() // nodeId → in-flight runs
  private timer: NodeJS.Timeout | null = null
  private requestingNode = false

  private nodeRuns(nodeId: string): Set<ChunkRun> {
    let s = this.byNode.get(nodeId)
    if (!s) {
      s = new Set()
      this.byNode.set(nodeId, s)
    }
    return s
  }

  private dropRun(run: ChunkRun): void {
    this.runs.delete(run.chunkId)
    const s = this.byNode.get(run.nodeId)
    if (s) {
      s.delete(run)
      if (s.size === 0) this.byNode.delete(run.nodeId)
    }
  }

  start(): void {
    // Restart recovery: chunks stranded in transient states (their ChunkRun
    // died with the previous process) go back to pending. The node agent
    // skips already-manifested frames, and downloads resume from the
    // manifest, so re-dispatch only redoes unfinished work.
    getDb()
      .prepare(
        `UPDATE chunks SET state = 'pending', node_id = NULL
         WHERE state IN ('assigned', 'rendering', 'encoding', 'downloading')`
      )
      .run()
    this.timer = setInterval(() => void this.tick(), TICK_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  kick(): void {
    void this.tick()
  }

  currentChunkForNode(nodeId: string): string | null {
    const s = this.byNode.get(nodeId)
    if (!s || s.size === 0) return null
    return [...s].map((r) => r.chunkId).join(', ')
  }

  private pendingChunks(): ChunkRow[] {
    return getDb()
      .prepare(
        `SELECT c.* FROM chunks c JOIN jobs j ON j.id = c.job_id
         WHERE c.state = 'pending' AND j.state IN ('queued', 'running')
         ORDER BY j.submitted_at, c.frame_start`
      )
      .all() as ChunkRow[]
  }

  async tick(): Promise<void> {
    const pending = this.pendingChunks()
    const slots = Math.max(1, getSettings().nodeSlots ?? 1)
    // Prefetch: keep the node's inbox slightly over-full (slots + 2) so a
    // finishing slot always has a queued spec to pick up without waiting a
    // scheduler round-trip. Single-slot behaviour unchanged.
    const perNodeLimit = slots > 1 ? slots + 2 : 1

    // Assign to nodes with free slots ('rendering' nodes included — a node
    // running fewer chunks than its slot count can take more).
    for (const node of nodeManager.list()) {
      if (pending.length === 0) break
      if (!['ready', 'idle', 'rendering'].includes(node.state)) continue
      const managed = nodeManager.get(node.id)
      if (!managed?.ssh) continue

      while (pending.length > 0 && this.nodeRuns(node.id).size < perNodeLimit) {
        // Affinity: prefer a chunk whose job's blender version is installed.
        const idx = pending.findIndex((c) => {
          const job = getDb()
            .prepare('SELECT blender_version FROM jobs WHERE id = ?')
            .get(c.job_id) as { blender_version: string | null } | undefined
          return !job?.blender_version || node.blenderVersions.includes(job.blender_version)
        })
        const chunk = idx >= 0 ? pending.splice(idx, 1)[0] : pending.shift()!

        const run = new ChunkRun(chunk.id, chunk.job_id, node.id, managed.ssh)
        this.runs.set(chunk.id, run)
        this.nodeRuns(node.id).add(run)
        void run.dispatch().catch((e) => {
          emit('alert', {
            level: 'error',
            message: `dispatch ${chunk.id} failed: ${(e as Error).message}`
          })
          this.requeue(chunk.id)
          this.dropRun(run)
          const n = nodeManager.get(node.id)
          if (n && !this.byNode.has(node.id) && n.state === 'rendering') n.setState('idle')
        })
      }
    }

    this.scalePolicy(pending.length)
  }

  /** Called by a run when its chunk reaches complete/failed. */
  onChunkFinished(run: ChunkRun): void {
    this.dropRun(run)
    const chunk = getDb().prepare('SELECT * FROM chunks WHERE id = ?').get(run.chunkId) as ChunkRow
    if (chunk.state === 'failed') this.requeue(run.chunkId)
    refreshJobState(run.jobId)
    const node = nodeManager.get(run.nodeId)
    // Only fall back to idle when the node has no other in-flight chunks.
    if (node && node.state === 'rendering' && !this.byNode.has(run.nodeId)) node.setState('idle')
    this.kick()
  }

  /**
   * Requeue a failed chunk: re-split around already-downloaded frames so only
   * missing work re-renders; give up after MAX_RETRIES.
   */
  private requeue(chunkId: string): void {
    const db = getDb()
    const chunk = db.prepare('SELECT * FROM chunks WHERE id = ?').get(chunkId) as ChunkRow
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(chunk.job_id) as JobRow
    if (chunk.retries >= MAX_RETRIES) {
      db.prepare("UPDATE chunks SET state = 'failed' WHERE id = ?").run(chunkId)
      refreshJobState(chunk.job_id)
      return
    }
    const downloaded = new Set(
      (
        db
          .prepare("SELECT frame FROM frames WHERE chunk_id = ? AND state = 'downloaded'")
          .all(chunkId) as Array<{ frame: number }>
      ).map((r) => r.frame)
    )
    const ranges = missingRanges(
      { start: chunk.frame_start, end: chunk.frame_end },
      job.frame_step,
      downloaded
    )
    if (ranges.length === 0) {
      db.prepare("UPDATE chunks SET state = 'complete' WHERE id = ?").run(chunkId)
      refreshJobState(chunk.job_id)
      return
    }
    const rewrite = db.transaction(() => {
      // Narrow the original chunk to the first missing range, add new chunks
      // for the rest, and re-point frame rows.
      const first = ranges[0]
      db.prepare(
        `UPDATE chunks SET state='pending', node_id=NULL, frames_done=?, retries=?, frame_start=?, frame_end=? WHERE id = ?`
      ).run(0, chunk.retries + 1, first.start, first.end, chunkId)
      for (const range of ranges.slice(1)) {
        const newId = `${chunk.job_id.slice(0, 8)}-${range.start}-${range.end}-r${chunk.retries + 1}`
        db.prepare(
          `INSERT INTO chunks (id, job_id, frame_start, frame_end, state, frames_done, retries)
           VALUES (?, ?, ?, ?, 'pending', 0, ?)`
        ).run(newId, chunk.job_id, range.start, range.end, chunk.retries + 1)
        db.prepare(
          `UPDATE frames SET chunk_id = ? WHERE job_id = ? AND frame BETWEEN ? AND ? AND state != 'downloaded'`
        ).run(newId, chunk.job_id, range.start, range.end)
      }
    })
    rewrite()
    refreshJobState(chunk.job_id)
  }

  /** Scale up when there's queued work; scale down long-idle nodes. */
  private scalePolicy(pendingCount: number): void {
    const settings = getSettings()
    const nodes = nodeManager.list()
    const active = nodes.filter((n) => !['destroyed', 'destroying', 'failed'].includes(n.state))
    const perHour = active.reduce((a, n) => a + (n.dphTotal ?? 0), 0)

    // Scale up: queued work beyond in-flight capacity, below limits.
    // Capacity is counted in SLOTS (free concurrent-render slots), not nodes.
    const slots = Math.max(1, settings.nodeSlots ?? 1)
    const capacityFree = active
      .filter((n) => ['ready', 'idle', 'rendering'].includes(n.state))
      .reduce((a, n) => a + Math.max(0, slots - (this.byNode.get(n.id)?.size ?? 0)), 0)
    if (
      pendingCount > capacityFree &&
      active.length < settings.maxActiveNodes &&
      (settings.spendCapPerHour == null || perHour < settings.spendCapPerHour) &&
      !this.requestingNode
    ) {
      this.requestingNode = true
      void nodeManager
        .requestNode()
        .catch((e) =>
          emit('alert', { level: 'warn', message: `scale-up failed: ${(e as Error).message}` })
        )
        .finally(() => {
          this.requestingNode = false
        })
    }

    // Scale down: idle with nothing pending for idleTimeout.
    if (pendingCount === 0) {
      for (const n of active) {
        if (n.state !== 'idle' && n.state !== 'ready') continue
        if (this.byNode.has(n.id)) continue
        const idleSince = this.idleSince.get(n.id) ?? Date.now()
        this.idleSince.set(n.id, idleSince)
        if (Date.now() - idleSince > settings.idleTimeoutMinutes * 60_000) {
          this.idleSince.delete(n.id)
          emit('alert', { level: 'info', message: `destroying idle node ${n.gpuName}` })
          void nodeManager.destroyNode(n.id)
        }
      }
    } else {
      this.idleSince.clear()
    }
  }

  private idleSince = new Map<string, number>()

  /** Cancel a job: kill running chunks on their nodes, mark rows. */
  async cancelJob(jobId: string): Promise<void> {
    const db = getDb()
    db.prepare("UPDATE jobs SET state = 'cancelled' WHERE id = ?").run(jobId)
    const chunks = db.prepare('SELECT * FROM chunks WHERE job_id = ?').all(jobId) as ChunkRow[]
    for (const chunk of chunks) {
      const run = this.runs.get(chunk.id)
      if (run) {
        run.abort()
        this.dropRun(run)
        const node = nodeManager.get(run.nodeId)
        if (node?.ssh) {
          // Remove queued spec + kill any in-flight blender for this chunk.
          await node.ssh
            .exec(
              `rm -f ${REMOTE_ROOT}/jobs/inbox/${chunk.id}.json; pkill -f '${chunk.id}' || true`
            )
            .catch(() => {})
        }
        if (node && node.state === 'rendering' && !this.byNode.has(run.nodeId)) {
          node.setState('idle')
        }
      }
      if (!['complete', 'failed'].includes(chunk.state)) {
        db.prepare("UPDATE chunks SET state = 'failed' WHERE id = ?").run(chunk.id)
      }
    }
    emitJobCancelled(jobId)
  }
}

function emitJobCancelled(jobId: string): void {
  refreshJobState(jobId)
}

export const scheduler = new Scheduler()
