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
import { emitChunkChanged, emitChunksChanged, refreshJobState } from '../jobs/jobs'
import { installBlender, installExtension, REMOTE_ROOT } from '../nodes/provisioner'
import { getAddon } from '../addons/addons'
import { nodeManager } from '../nodes/nodeManager'
import { getSettings } from '../settings'
import { sftpRename, sftpWriteFile, uploadFileVerified } from '../ssh/sftp'
import { recordThroughput } from '../vast/offers'
import type { SshConnection } from '../ssh/sshConnection'
import { ChunkDownloader } from '../transfer/frameDownloader'
import { missingRanges } from './chunker'
import { admits, hasRoom, type NodeOccupancy } from './admission'
import { decide, hardCap, initialState, recordNodeSlots, type SlotState } from './slotController'
import type { ChunkState, EngineId, NodeSnapshot } from '../../shared/models'

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

/** A pending chunk joined to the few job columns assignment needs. */
interface PendingChunk extends ChunkRow {
  /** 0 = exclusive (needs the node to itself), 1 = may co-run */
  share_node: number
  blender_version: string | null
}

interface JobRow {
  id: string
  blend_path: string
  engine: EngineId
  frame_step: number
  blender_version: string | null
  addon_ids: string
  state: string
  share_node: number
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

/** EWMA weight for the per-chunk frame-rate estimate (30% new sample). */
const RATE_ALPHA = 0.3

class ChunkRun {
  private stopped = false
  private downloader: ChunkDownloader | null = null
  private stopTail: (() => void) | null = null
  private dispatchedAt = Date.now()

  /** EWMA of frames/sec while rendering; null until two progress samples land. */
  private framesPerSec: number | null = null
  private lastFramesDone = 0
  private lastSampleAt = 0
  /** Running mean of how many chunks shared this node during the render. */
  private concurrencySum = 0
  private concurrencySamples = 0

  constructor(
    readonly chunkId: string,
    readonly jobId: string,
    readonly nodeId: string,
    /** may this chunk share its node? (mirrors the job's share_node flag) */
    readonly shareNode: boolean,
    private readonly ssh: SshConnection
  ) {}

  /**
   * Measured frames/sec, or null while it is still unknown. This is the
   * feedback signal the slot controller hill-climbs on; it comes free from
   * the progress polling we already do, so no agent change is needed.
   */
  rate(): number | null {
    return this.framesPerSec
  }

  /**
   * Fold one progress sample into the rate estimate. Only called while the
   * agent reports 'rendering' — encoding and downloading produce no frames,
   * and counting them would read as a throughput collapse.
   */
  private sampleRate(framesDone: number, concurrency: number): void {
    const now = Date.now()
    this.concurrencySum += concurrency
    this.concurrencySamples += 1
    if (this.lastSampleAt > 0 && framesDone > this.lastFramesDone) {
      const rate = (framesDone - this.lastFramesDone) / ((now - this.lastSampleAt) / 1000)
      if (Number.isFinite(rate) && rate > 0) {
        this.framesPerSec =
          this.framesPerSec == null
            ? rate
            : this.framesPerSec * (1 - RATE_ALPHA) + rate * RATE_ALPHA
      }
    }
    // Advance the baseline only on a frame boundary, so a slow frame is
    // measured over its true duration instead of decaying towards zero
    // across the polls that elapse while it renders.
    if (this.lastSampleAt === 0 || framesDone > this.lastFramesDone) {
      this.lastFramesDone = framesDone
      this.lastSampleAt = now
    }
  }

  /** Mean node occupancy observed during this run (>= 1). */
  private meanConcurrency(): number {
    if (this.concurrencySamples === 0) return 1
    return Math.max(1, this.concurrencySum / this.concurrencySamples)
  }

  private setChunk(patch: Record<string, unknown>): void {
    const keys = Object.keys(patch)
    getDb()
      .prepare(`UPDATE chunks SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...keys.map((k) => patch[k]), this.chunkId)
    // Only lifecycle moves are announced. The `{frames_done}` write below
    // happens once per chunk per 5s poll and has its own high-rate channel
    // (chunk:progress); emitting here too would turn every progress tick into
    // a query invalidation across the whole UI.
    if ('state' in patch) emitChunkChanged(this.chunkId)
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
    const slotTarget = this.shareNode ? scheduler.slotTargetFor(this.nodeId) : 1

    this.setChunk({ state: 'assigned', node_id: this.nodeId, assigned_at: Date.now() })
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

    // Node prep can take MINUTES (a Blender download, an extension install, the
    // scene upload) and is serialised behind every other prep queued on this
    // node. A cancel or a node death lands in that window routinely — and
    // `stopped` was previously only read once polling had started, so prep
    // resumed and handed the agent a chunk nobody wanted: the spec was written,
    // the row flipped back to 'rendering' over the 'failed' cancelJob had just
    // set, and a downloader was started whose stop() was already unreachable,
    // leaving it polling for the life of the process.
    if (this.abandoned('after node prep')) return

    // 4. Job spec — written atomically (agent ignores *.tmp.json).
    const spec = {
      chunkId: this.chunkId,
      blendFile: remoteBlend,
      blenderVersion: job.blender_version,
      engine: job.engine,
      frameStart: chunk.frame_start,
      frameEnd: chunk.frame_end,
      frameStep: job.frame_step,
      // Concurrent render slots the agent may use (1 = single-slot). This is
      // the node's current auto-judged target, not a global setting.
      nodeSlots: slotTarget,
      // Backstop for the agent: the scheduler already refuses to co-locate an
      // exclusive chunk, but a spec landing as a node drains could still race.
      exclusive: !this.shareNode,
      extraArgs: [],
      pythonExprs: bootstrapExprs,
      encode: {
        sdr: true,
        hdr: true,
        proxy: true,
        codec: settings.proxyCodec,
        fps: 25,
        thumbs: settings.thumbnails !== false,
        thumbWidth: 320,
        live: {
          mode: settings.livePreview ?? 'onDemand',
          width: settings.livePreviewWidth ?? 960,
          crf: 22,
          minFrames: 5,
          maxAgeSec: 20
        }
      }
    }
    // Remove any leftover state file from a previous attempt of this chunk
    // BEFORE queueing the new spec: the stall watchdog must only ever see
    // state written by the attempt it is polling. (Observed failure: chunks
    // re-dispatched after a crash sat queued behind busy slots while the
    // watchdog read the dead attempt's frozen state and burned every retry.)
    await this.ssh.exec(`rm -f ${REMOTE_ROOT}/state/${this.chunkId}.json`).catch(() => {})
    if (this.abandoned('before queueing the spec')) return
    const sftp = await this.ssh.sftp()
    const inbox = posix.join(REMOTE_ROOT, 'jobs', 'inbox')
    await sftpWriteFile(sftp, `${inbox}/${this.chunkId}.tmp.json`, JSON.stringify(spec))
    await sftpRename(sftp, `${inbox}/${this.chunkId}.tmp.json`, `${inbox}/${this.chunkId}.json`)
    // The spec is now live: from here the agent may pick it up at any moment, so
    // a cancel that landed during the write has to be retracted rather than just
    // returned from.
    if (this.stopped) {
      await this.retractSpec()
      return
    }

    // Re-assert any subscription made while this chunk was still pending —
    // there was no node to write the flag to at the time.
    await scheduler.reassertPreviewSubscription(this.chunkId, this.nodeId)

    if (this.abandoned('before starting downloads')) {
      await this.retractSpec()
      return
    }
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
    if (slotTarget <= 2) void this.tailLog()
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
    const frameStep = this.job().frame_step
    for (;;) {
      if (this.stopped) return
      const state = await this.readAgentState()
      if (state) {
        // Re-read the range every iteration rather than computing it once:
        // requeue() can narrow this chunk mid-flight, and a cached total then
        // reports progress against a range that no longer exists.
        const chunk = this.chunk()
        const framesTotal = Math.floor((chunk.frame_end - chunk.frame_start) / frameStep) + 1
        this.setChunk({ frames_done: state.framesDone })
        emit('chunk:progress', {
          chunkId: this.chunkId,
          jobId: this.jobId,
          nodeId: this.nodeId,
          currentFrame: state.currentFrame,
          framesDone: state.framesDone,
          framesTotal
        })
        if (state.status === 'rendering') {
          this.sampleRate(state.framesDone, scheduler.slotsInUse(this.nodeId))
        }
        if (state.status === 'encoding') this.setChunk({ state: 'encoding' })
        if (state.status === 'done') {
          this.setChunk({ state: 'downloading' })
          refreshJobState(this.jobId)
          const lost = (await this.downloader?.drain()) ?? []
          if (lost.length > 0) {
            // The render succeeded but frames did not reach us, and this was
            // the last download pass. Failing sends it through requeue(), which
            // re-splits around the frames that DID land — so only the missing
            // ones re-render, rather than the chunk quietly completing with a
            // hole in it.
            this.finish(
              'failed',
              `${lost.length} frame(s) could not be downloaded: ${lost.slice(0, 3).join(', ')}`
            )
            return
          }
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
        // Scale by the concurrency this chunk actually ran under. gpu_perf
        // ranks OFFERS, so it must mean "frames/hour the whole node delivers".
        // A chunk sharing a node with five others takes ~6x as long in
        // wall-clock; recording that unscaled would teach the offer scorer
        // that packing makes a GPU slow, and it would stop buying the models
        // that pack best.
        recordThroughput(gpuName, (frames / elapsedH) * this.meanConcurrency())
      }
    }
    scheduler.onChunkFinished(this)
  }

  /**
   * True once this run has been abandoned (cancelled, or its node went away).
   *
   * Checked after every await in `dispatch`. Deliberately returns rather than
   * throwing: a throw lands in the tick's catch, which calls `requeue()` — and
   * requeueing a cancelled chunk sets it straight back to 'pending' for
   * re-dispatch, resurrecting the very work that was just cancelled.
   */
  private abandoned(where: string): boolean {
    if (!this.stopped) return false
    emit('render:logLine', {
      nodeId: this.nodeId,
      chunkId: this.chunkId,
      line: `dispatch abandoned ${where}`,
      ts: Date.now()
    })
    return true
  }

  /**
   * Withdraw a spec already queued on the node.
   *
   * `cancelJob` does this too, but it can only remove what exists when it runs;
   * a spec written moments later would survive it, and the agent would render a
   * cancelled chunk. Best-effort: the agent may already have claimed it, in
   * which case the `pkill` is what stops it.
   */
  private async retractSpec(): Promise<void> {
    await this.ssh
      .exec(
        `rm -f ${REMOTE_ROOT}/jobs/inbox/${this.chunkId}.json; pkill -f '${this.chunkId}' || true`
      )
      .catch(() => {})
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

const EMPTY_RUNS: ReadonlySet<ChunkRun> = new Set()

class Scheduler {
  private runs = new Map<string, ChunkRun>() // chunkId → run
  private byNode = new Map<string, Set<ChunkRun>>() // nodeId → in-flight runs
  private timer: NodeJS.Timeout | null = null
  /** Chunks the UI is currently watching; re-asserted on dispatch. */
  private previewSubs = new Set<string>()
  private requestingNode = false
  /** auto-judged concurrency per node (see slotController) */
  private slots = new Map<string, SlotState>()
  /**
   * At most one node at a time may be held empty for a waiting exclusive
   * chunk. See reserveForExclusive.
   */
  private reservation: { nodeId: string; chunkId: string } | null = null
  /** Startup-recovered chunks awaiting confirmation before renting. See start(). */
  private recoveryHold: number | null = null

  /**
   * The node's run set, CREATING it if absent. Only for the dispatch path —
   * every read must go through `runsOn`/`hasRuns` instead.
   *
   * This used to be the only accessor, and the read paths (the slot controller
   * runs it for every eligible node on every tick) left an empty Set behind for
   * any node that had ever been looked at. `byNode.has(id)` then answered true
   * forever, which meant an idle node was never scale-down destroyed — observed
   * live: a rented A4000 sat idle and billing with all its work finished.
   */
  private nodeRunsMut(nodeId: string): Set<ChunkRun> {
    let s = this.byNode.get(nodeId)
    if (!s) {
      s = new Set()
      this.byNode.set(nodeId, s)
    }
    return s
  }

  /** In-flight runs on a node. Read-only: never creates an entry. */
  private runsOn(nodeId: string): ReadonlySet<ChunkRun> {
    return this.byNode.get(nodeId) ?? EMPTY_RUNS
  }

  /**
   * Does this node have in-flight work? Size-based, never `byNode.has()`, so a
   * stray empty set can't read as "busy".
   */
  private hasRuns(nodeId: string): boolean {
    return (this.byNode.get(nodeId)?.size ?? 0) > 0
  }

  private dropRun(run: ChunkRun): void {
    this.runs.delete(run.chunkId)
    const s = this.byNode.get(run.nodeId)
    if (s) {
      s.delete(run)
      if (s.size === 0) this.byNode.delete(run.nodeId)
    }
  }

  /**
   * Forget a node that has gone away, and release the work it was holding.
   *
   * The learned concurrency goes first: node ids are never reused, so leaving
   * entries behind would only leak, and the useful part of what this node
   * taught us is already in gpu_slots, keyed by GPU model.
   *
   * Then the in-flight runs. Nothing else aborts them — `abort()` is otherwise
   * only reached from cancelJob — and a destroyed node's SSH connection is
   * closed, so `readAgentState` throws, the throw is swallowed to null, and the
   * stall watchdog can't fire because it only runs on a non-null state. Left
   * alone, such a run polls a dead connection every 5s for the life of the
   * process, its chunk stays 'rendering' against a node that no longer exists,
   * the job never reaches complete/partial, and `workRemaining` keeps the
   * eager-fleet scale-up buying GPUs for work nobody is doing.
   */
  forgetNode(nodeId: string): void {
    this.slots.delete(nodeId)
    if (this.reservation?.nodeId === nodeId) this.reservation = null

    const orphaned = [...this.runsOn(nodeId)]
    this.byNode.delete(nodeId)
    if (orphaned.length === 0) return
    for (const run of orphaned) {
      run.abort()
      this.dropRun(run)
      this.dropPreviewSubscription(run.chunkId, nodeId)
      // Treated exactly like a failed chunk: re-split around whatever frames
      // did land so only missing work re-renders, and burn a retry so a node
      // that dies repeatedly still gives up eventually.
      this.requeue(run.chunkId)
      refreshJobState(run.jobId)
    }
    emit('alert', {
      level: 'warn',
      message: `${orphaned.length} chunk(s) requeued — node went away mid-render`
    })
    this.kick()
  }

  start(): void {
    // Restart recovery: chunks stranded in transient states (their ChunkRun
    // died with the previous process) go back to pending. The node agent
    // skips already-manifested frames, and downloads resume from the
    // manifest, so re-dispatch only redoes unfinished work.
    const db = getDb()
    const stranded = db
      .prepare(
        `SELECT id FROM chunks WHERE state IN ('assigned', 'rendering', 'encoding', 'downloading')`
      )
      .all() as Array<{ id: string }>
    db.prepare(
      `UPDATE chunks SET state = 'pending', node_id = NULL
       WHERE state IN ('assigned', 'rendering', 'encoding', 'downloading')`
    ).run()
    emitChunksChanged(stranded.map((c) => c.id))
    // Recovered work is real work, and the very next tick would buy a whole
    // fleet for it. That is right when you meant to resume and expensive when
    // you did not: a profile left with a day-old half-finished campaign starts
    // renting up to maxActiveNodes the moment the app opens, before you have
    // seen a single screen. Hold scale-up until it is confirmed. One node is
    // not worth asking about; a fleet is.
    if (stranded.length > 0 && getSettings().maxActiveNodes > 1) {
      this.recoveryHold = stranded.length
      emit('alert', {
        level: 'warn',
        message:
          `${stranded.length} chunk(s) recovered from the last session — ` +
          `fleet scale-up is paused until you resume`
      })
    }
    this.timer = setInterval(() => void this.tick(), TICK_MS)
  }

  /**
   * Chunks recovered at startup whose scale-up is waiting on confirmation, or
   * null when nothing is held. Only ever blocks BUYING: existing nodes are still
   * dispatched to, idle ones still scale down, and an explicit "add node" still
   * works — so resuming is never the only way out.
   */
  recoveryHoldCount(): number | null {
    return this.recoveryHold
  }

  resumeRecovery(): void {
    if (this.recoveryHold == null) return
    this.recoveryHold = null
    this.kick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  kick(): void {
    void this.tick()
  }

  /**
   * What this node is rendering right now. Drives both the fleet row's
   * "current chunk" text and the per-job cost split in accrueCosts — a node
   * with two runs in flight has its minute divided between them.
   */
  activeWorkForNode(nodeId: string): Array<{ chunkId: string; jobId: string }> {
    const s = this.byNode.get(nodeId)
    if (!s || s.size === 0) return []
    return [...s].map((r) => ({ chunkId: r.chunkId, jobId: r.jobId }))
  }

  /**
   * Pending chunks, oldest job first, carrying their job's sharing flag and
   * blender version. Joining here rather than re-querying per candidate keeps
   * the assignment loop to one query per tick instead of one per (node,
   * candidate) pair.
   */
  private pendingChunks(): PendingChunk[] {
    return getDb()
      .prepare(
        `SELECT c.*, j.share_node, j.blender_version FROM chunks c JOIN jobs j ON j.id = c.job_id
         WHERE c.state = 'pending' AND j.state IN ('queued', 'running')
         ORDER BY j.submitted_at, c.frame_start`
      )
      .all() as PendingChunk[]
  }

  /** The node's current concurrency target; 1 until the controller has seen it. */
  slotTargetFor(nodeId: string): number {
    return this.slots.get(nodeId)?.target ?? 1
  }

  /** Chunks in flight on a node right now. */
  slotsInUse(nodeId: string): number {
    return this.byNode.get(nodeId)?.size ?? 0
  }

  /**
   * Is this chunk actually being driven right now? Deliberately not derivable
   * from `chunks.state`: a run that dies leaves the row reading 'rendering'
   * until restart recovery or the stall watchdog catches it, and a node panel
   * that trusted the row would show a machine busy on work nobody is driving.
   */
  isLive(chunkId: string): boolean {
    return this.runs.has(chunkId)
  }

  /**
   * Ask the node to build a rolling preview for a chunk (or stop).
   *
   * Held in memory as well as written to the node, because a subscription can
   * be made before the chunk is dispatched — the overlay opens on a pending
   * chunk, there is no node yet, and the flag has to be re-asserted at
   * dispatch or the request is silently lost.
   */
  async setPreviewSubscription(chunkId: string, on: boolean): Promise<void> {
    if (on) this.previewSubs.add(chunkId)
    else this.previewSubs.delete(chunkId)
    const row = getDb().prepare('SELECT node_id FROM chunks WHERE id = ?').get(chunkId) as
      { node_id: string | null } | undefined
    if (row?.node_id) await this.writePreviewFlag(row.node_id, chunkId, on)
  }

  private async writePreviewFlag(nodeId: string, chunkId: string, on: boolean): Promise<void> {
    const ssh = nodeManager.get(nodeId)?.ssh
    if (!ssh) return
    const path = posix.join(REMOTE_ROOT, 'control', `${chunkId}.live`)
    try {
      // A shell touch/rm rather than SFTP: it creates the directory in the
      // same round trip, and sftpWriteFile does no mkdir (unlike
      // uploadFileVerified, which calls remoteMkdirp).
      await ssh.exec(on ? `mkdir -p ${posix.dirname(path)} && touch '${path}'` : `rm -f '${path}'`)
    } catch {
      // Best effort: a missed flag costs a preview, never a render.
    }
  }

  /** Clear a chunk's subscription once it can no longer produce a live clip. */
  private dropPreviewSubscription(chunkId: string, nodeId: string): void {
    if (!this.previewSubs.delete(chunkId)) return
    void this.writePreviewFlag(nodeId, chunkId, false)
  }

  async reassertPreviewSubscription(chunkId: string, nodeId: string): Promise<void> {
    if (this.previewSubs.has(chunkId)) await this.writePreviewFlag(nodeId, chunkId, true)
  }

  private occupancy(nodeId: string): NodeOccupancy {
    const runs = this.runsOn(nodeId)
    return {
      inFlight: runs.size,
      hasExclusive: [...runs].some((r) => !r.shareNode),
      reservedFor: this.reservation?.nodeId === nodeId ? this.reservation.chunkId : null,
      slotTarget: this.slotTargetFor(nodeId)
    }
  }

  private slotStateFor(node: NodeSnapshot, maxNodeSlots: number): SlotState {
    let s = this.slots.get(node.id)
    if (!s) {
      s = initialState(node.gpuName, hardCap(node.metrics, maxNodeSlots), Date.now())
      this.slots.set(node.id, s)
    }
    return s
  }

  /**
   * Advance the per-node concurrency auto-judge. Runs every tick; the
   * controller itself decides when it has enough evidence to move.
   */
  private runSlotController(eligible: NodeSnapshot[]): void {
    const maxNodeSlots = Math.max(0, getSettings().maxNodeSlots ?? 0)
    const now = Date.now()
    for (const node of eligible) {
      const runs = this.runsOn(node.id)
      // An exclusive chunk holds the node alone by construction, so it says
      // nothing about how well this node packs — don't let it move the target.
      if ([...runs].some((r) => !r.shareNode)) continue
      const prev = this.slotStateFor(node, maxNodeSlots)

      // Only the runs the agent is actually rendering produce frames; the
      // prefetch tail sits in its inbox. Require a rate from at least the
      // target's worth of runs, or the sum understates the node and the
      // climb reads its own ramp-up as degradation.
      const rates = [...runs].map((r) => r.rate()).filter((r): r is number => r != null)
      const throughput =
        rates.length >= prev.target && rates.length > 0 ? rates.reduce((a, b) => a + b, 0) : null

      const { state, settledAt, reason } = decide({
        state: prev,
        metrics: node.metrics,
        inFlight: runs.size,
        throughput,
        maxNodeSlots,
        now
      })
      this.slots.set(node.id, state)
      // `!prev.converged` alone hid every backoff after the first, because the
      // first one sets converged — so a node stepping down under memory
      // pressure did it silently. Report any step that actually moved the
      // target, plus the initial convergence.
      if (settledAt != null && (state.target !== prev.target || !prev.converged)) {
        emit('alert', { level: 'info', message: `${node.gpuName ?? node.id}: ${reason}` })
        if (node.gpuName && state.bestThroughput > 0) {
          recordNodeSlots(node.gpuName, state.bestTarget, state.bestThroughput)
        }
      }
      if (state.target !== prev.target) nodeManager.get(node.id)?.emitChanged()
    }
  }

  /**
   * Keep an exclusive chunk at the head of the queue from starving.
   *
   * Assignment prefers whatever fits, and a shared chunk fits a busy node
   * while an exclusive one needs an empty one. With a steady stream of shared
   * work every node stays occupied forever, so an older exclusive job would
   * never start. When that happens, stop feeding one node and let it drain.
   *
   * One node at a time: reserving more would idle the fleet to satisfy a
   * single chunk.
   */
  private reserveForExclusive(pending: PendingChunk[], eligible: NodeSnapshot[]): void {
    if (this.reservation) {
      const stillWaiting = pending.some((c) => c.id === this.reservation!.chunkId)
      const nodeUsable = eligible.some((n) => n.id === this.reservation!.nodeId)
      if (stillWaiting && nodeUsable) return
      this.reservation = null
    }
    const head = pending[0]
    if (!head || head.share_node === 1) return
    // Something is already free — no need to hold a node back.
    if (eligible.some((n) => this.runsOn(n.id).size === 0)) return
    // Drain whichever node is closest to empty.
    let best: { id: string; size: number } | null = null
    for (const n of eligible) {
      const size = this.runsOn(n.id).size
      if (!best || size < best.size) best = { id: n.id, size }
    }
    if (best) this.reservation = { nodeId: best.id, chunkId: head.id }
  }

  async tick(): Promise<void> {
    const pending = this.pendingChunks()

    const eligible = nodeManager
      .list()
      .filter((n) => ['ready', 'idle', 'rendering'].includes(n.state))
      .filter((n) => nodeManager.get(n.id)?.ssh)

    this.runSlotController(eligible)
    this.reserveForExclusive(pending, eligible)

    // Assign ROUND-ROBIN across nodes with room ('rendering' nodes included —
    // a node below its slot target can take more). One chunk per node per
    // pass, so early-ready nodes don't swallow the whole queue into their
    // prefetch while later nodes sit idle.
    let assignedInPass = true
    while (pending.length > 0 && assignedInPass) {
      assignedInPass = false
      for (const node of eligible) {
        if (pending.length === 0) break
        const occ = this.occupancy(node.id)
        if (!hasRoom(occ)) continue
        const managed = nodeManager.get(node.id)
        if (!managed?.ssh) continue

        // Among the chunks this node may take, prefer one whose blender
        // version is already installed. Admission comes first: an exclusive
        // chunk needs an empty node, so on a busy node only shared work is
        // eligible however good its version affinity.
        const idx = this.pickChunk(pending, occ, node)
        if (idx < 0) continue
        const chunk = pending.splice(idx, 1)[0]
        assignedInPass = true
        if (this.reservation?.chunkId === chunk.id) this.reservation = null

        const run = new ChunkRun(
          chunk.id,
          chunk.job_id,
          node.id,
          chunk.share_node === 1,
          managed.ssh
        )
        this.runs.set(chunk.id, run)
        this.nodeRunsMut(node.id).add(run)
        void run.dispatch().catch((e) => {
          emit('alert', {
            level: 'error',
            message: `dispatch ${chunk.id} failed: ${(e as Error).message}`
          })
          this.requeue(chunk.id)
          this.dropRun(run)
          const n = nodeManager.get(node.id)
          if (n && !this.hasRuns(node.id) && n.state === 'rendering') n.setState('idle')
        })
      }
    }

    this.scalePolicy(pending)
  }

  /**
   * Index of the best pending chunk for this node, or -1 if it may take none.
   * Queue order (oldest job first) breaks ties, so an admissible chunk is only
   * passed over for one that saves a Blender install.
   */
  private pickChunk(pending: PendingChunk[], occ: NodeOccupancy, node: NodeSnapshot): number {
    let fallback = -1
    for (let i = 0; i < pending.length; i++) {
      const c = pending[i]
      if (!admits(occ, { id: c.id, sharesNode: c.share_node === 1 })) continue
      if (!c.blender_version || node.blenderVersions.includes(c.blender_version)) return i
      if (fallback < 0) fallback = i
    }
    return fallback
  }

  /** Called by a run when its chunk reaches complete/failed. */
  onChunkFinished(run: ChunkRun): void {
    this.dropRun(run)
    // A finished chunk can never produce another live frame, so the flag is
    // dead weight on the node from here on.
    this.dropPreviewSubscription(run.chunkId, run.nodeId)
    const chunk = getDb().prepare('SELECT * FROM chunks WHERE id = ?').get(run.chunkId) as ChunkRow
    if (chunk.state === 'failed') this.requeue(run.chunkId)
    refreshJobState(run.jobId)
    const node = nodeManager.get(run.nodeId)
    // Only fall back to idle when the node has no other in-flight chunks.
    if (node && node.state === 'rendering' && !this.hasRuns(run.nodeId)) node.setState('idle')
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
      emitChunkChanged(chunkId)
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
      emitChunkChanged(chunkId)
      refreshJobState(chunk.job_id)
      return
    }
    const touched: string[] = [chunkId]
    const rewrite = db.transaction(() => {
      // Narrow the original chunk to the first missing range, add new chunks
      // for the rest, and re-point frame rows.
      const first = ranges[0]
      db.prepare(
        `UPDATE chunks SET state='pending', node_id=NULL, frames_done=?, retries=?, frame_start=?, frame_end=?, assigned_at=NULL WHERE id = ?`
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
        touched.push(newId)
      }
    })
    rewrite()
    // After the transaction commits: these ids include rows that did not exist
    // a moment ago, so anything caching a node's chunk list has to re-read.
    emitChunksChanged(touched)
    refreshJobState(chunk.job_id)
  }

  /** Scale up when there's queued work; scale down long-idle nodes. */
  private scalePolicy(pending: PendingChunk[]): void {
    const settings = getSettings()
    const pendingCount = pending.length
    const nodes = nodeManager.list()
    const active = nodes.filter((n) => !['destroyed', 'destroying', 'failed'].includes(n.state))
    const perHour = active.reduce((a, n) => a + (n.dphTotal ?? 0), 0)
    const usable = active.filter((n) => ['ready', 'idle', 'rendering'].includes(n.state))

    // Shared and exclusive work draw on different supplies, so they need
    // separate demand tests. Shared chunks consume free SLOTS; an exclusive
    // chunk consumes a whole EMPTY NODE however many slots it has. Counting
    // them together would let a fleet packed with shared work look like it
    // had room for exclusive chunks that can never be placed on it.
    const pendingShared = pending.filter((c) => c.share_node === 1).length
    const pendingExclusive = pendingCount - pendingShared
    const sharedCapacity = usable
      // A node locked by an exclusive chunk, or being drained for one, will
      // not take shared work however many slots it nominally has.
      .filter((n) => !this.occupancy(n.id).hasExclusive && this.reservation?.nodeId !== n.id)
      .reduce(
        (a, n) => a + Math.max(0, this.slotTargetFor(n.id) - (this.byNode.get(n.id)?.size ?? 0)),
        0
      )
    const exclusiveCapacity = usable.filter((n) => (this.byNode.get(n.id)?.size ?? 0) === 0).length

    // Buy-ahead (eagerFleet): rent to maxActiveNodes while ANY chunk is
    // unfinished. Demand-driven scaling alone can never widen a fleet whose
    // nodes prefetch the entire queue (pending pins at 0), which strands a
    // long CPU-bound drain on however many nodes happened to boot first.
    const workRemaining = pendingCount + this.runs.size
    const wantMore =
      pendingShared > sharedCapacity ||
      pendingExclusive > exclusiveCapacity ||
      (settings.eagerFleet === true && workRemaining > 0)
    if (
      wantMore &&
      // Startup recovery not yet confirmed — see start(). Scale-DOWN below is
      // deliberately still live, so a held fleet cannot also be a stuck one.
      this.recoveryHold == null &&
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
        if (this.hasRuns(n.id)) continue
        // Never destroy a node we are deliberately holding empty for a
        // waiting exclusive chunk.
        if (this.reservation?.nodeId === n.id) continue
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
        if (node && node.state === 'rendering' && !this.hasRuns(run.nodeId)) {
          node.setState('idle')
        }
      }
      if (!['complete', 'failed'].includes(chunk.state)) {
        db.prepare("UPDATE chunks SET state = 'failed' WHERE id = ?").run(chunk.id)
        emitChunkChanged(chunk.id)
      }
    }
    emitJobCancelled(jobId)
  }
}

function emitJobCancelled(jobId: string): void {
  refreshJobState(jobId)
}

export const scheduler = new Scheduler()
