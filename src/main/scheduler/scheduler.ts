/**
 * The fleet scheduler: assigns pending chunks to idle nodes, dispatches them
 * to the node agent (upload blend → write job spec → tail progress → download
 * results), requeues on failure with re-splitting around downloaded frames,
 * and scales the fleet up/down within the user's limits.
 *
 * Single loop, event-kicked + 15s timer. All chunk/job state lives in
 * SQLite, so a restart loses no bookkeeping. It does lose in-flight work:
 * nothing re-attaches to a render the previous process started. start()
 * sends each such chunk back to pending, narrowed around the frames already
 * downloaded, so its next dispatch renders only what this computer lacks
 * (see start()).
 */

import { posix } from 'path'
import { getDb, readAppState, writeAppState } from '../db/db'
import { classify, describeError, type AgentFailure, type Classification } from '../errors'
import { emit } from '../events'
import {
  emitChunkChanged,
  emitChunksChanged,
  emitJobChanged,
  noteChunkError,
  refreshJobState
} from '../jobs/jobs'
import { agentAlive, installBlender, installExtension, REMOTE_ROOT } from '../nodes/provisioner'
import { listAddons } from '../addons/addons'
import { nodeManager } from '../nodes/nodeManager'
import { getSettings } from '../settings'
import { uploadFileVerified, writeRemoteFileAtomic } from '../ssh/sftp'
import { recordThroughput } from '../vast/offers'
import type { SshConnection } from '../ssh/sshConnection'
import { ChunkDownloader, localSinkHold } from '../transfer/frameDownloader'
import { jobClips } from '../transfer/jobClip'
import { missingRanges } from './chunker'
import {
  admits,
  breakerKey,
  budgetFor,
  chargeFor,
  chunkBackoffMs,
  exclusiveLanesFor,
  freeExclusiveLanes,
  hasRoom,
  JobBreaker,
  NODE_REST_BASE_MS,
  nodeRestMs,
  renderOnMachine,
  type AttemptStage,
  type NodeOccupancy,
  type RetryBudget
} from './admission'
import {
  dispatchLanePlan,
  guardedLanePlan,
  guardLanes,
  initialGuard,
  normaliseSlotsPerGpu,
  perGpuFramesPerHour,
  planLanes,
  runsOnGpu,
  type LaneGuard,
  type LaneGuardContext,
  type LanePlan
} from './gpuLanes'
import { planScaling, type ScalingPlan } from './scaling'
import { decide, hardCap, initialState, recordNodeSlots, type SlotState } from './slotController'
import type {
  AlertEvent,
  ChunkState,
  EngineId,
  FleetHolds,
  JobAttention,
  JobAttentionKind,
  NodeSnapshot
} from '../../shared/models'
import { capacityBudget, isBooting, isDispatchable } from '../../shared/nodeState'

const TICK_MS = 15_000
const STATE_POLL_MS = 5_000
/**
 * Failed renders a chunk may have before it fails for good: the scene or
 * Blender failing, what `chunks.retries` counts (plan 1.17). A dispatch that
 * lost its SSH channel, a node that died or stalled, a download that failed
 * are the machines' failures and never charged here: they used to be, and
 * job 1d59516c's 16 chunks spent all four on two instances Vast had stopped.
 */
const MAX_RETRIES = 4
/**
 * Failed attempts a chunk may have for the machines' and the network's
 * reasons (`chunks.infra_retries`): larger, because none of them says the
 * render is wrong, but still a bound, because each one can cost a paid
 * render (a node that dies mid-chunk, a transfer that never lands).
 */
const MAX_INFRA_RETRIES = 8

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

/**
 * How long one dispatch's node prep may hold the node's prep lock. Longer
 * than any healthy step (a Blender download that needs a second mirror, a
 * large scene upload); shorter than install-blender's own ceiling of two
 * rounds of four mirrors at 30 min each, which is no healthy node's.
 */
const PREP_DEADLINE_MS = 60 * 60_000

/**
 * Node preps still running past their deadline, by node: the step, and since
 * when. Until it ends, however it ends, the node is sent nothing (see
 * Scheduler.nodeUnfit): its lock is free, and a second prep would run beside
 * the stuck one, two installs writing one download, which is what the lock
 * is for.
 */
const stuckPreps = new Map<string, { since: number; step: string }>()

/** A node's prep ran past PREP_DEADLINE_MS, or an earlier one on the node still is. */
class NodePrepTimeout extends Error {
  override readonly name = 'NodePrepTimeout'
}

/**
 * Run `fn` holding the node's prep lock, under PREP_DEADLINE_MS. `fn` names
 * the step it is on with `step`, for the error.
 *
 * The lock was released only when `fn` settled, and nothing in it had a
 * deadline of its own (a Blender download that trickles, a command on a
 * wedged connection), so one hung step held the lock for good: every later
 * dispatch to the node queued behind it, its chunk 'assigned' and its node
 * billing (#82, #139). At the deadline the lock is released and the dispatch
 * fails; the step itself cannot be cancelled from here, so it is marked
 * stuck (stuckPreps) until it ends, and a prep that finds it so fails at once.
 */
async function withNodePrep<T>(
  nodeId: string,
  fn: (step: (what: string) => void) => Promise<T>
): Promise<T> {
  const prev = nodePrepLocks.get(nodeId) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  nodePrepLocks.set(
    nodeId,
    prev.then(() => gate)
  )
  await prev
  let timer: NodeJS.Timeout | undefined
  try {
    const stuck = stuckPreps.get(nodeId)
    if (stuck) {
      throw new NodePrepTimeout(
        `setting up the node is stuck: ${stuck.step} has been running for ` +
          `${Math.round((Date.now() - stuck.since) / 60_000)} min`
      )
    }
    const startedAt = Date.now()
    let step = 'setting up the node'
    const work = fn((what) => {
      step = what
    })
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const entry = { since: startedAt, step }
        stuckPreps.set(nodeId, entry)
        const ended = (): void => {
          if (stuckPreps.get(nodeId) === entry) stuckPreps.delete(nodeId)
        }
        work.then(ended, ended)
        reject(
          new NodePrepTimeout(
            `setting up the node did not finish in ${PREP_DEADLINE_MS / 60_000} min: ${step} ` +
              'is still running, and nothing more is sent to the node until it ends'
          )
        )
      }, PREP_DEADLINE_MS)
    })
    return await Promise.race([work, deadline])
  } finally {
    clearTimeout(timer)
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
  infra_retries: number
  /** epoch ms before which it is not dispatched (a transient failure's backoff) */
  not_before: number | null
  /** the last failed attempt's ErrorClass */
  error_kind: string | null
}

/** A pending chunk joined to the few job columns assignment needs. */
interface PendingChunk extends ChunkRow {
  /** 0 = exclusive (needs the node to itself), 1 = may co-run */
  share_node: number
  /** the job's engine: what its lanes are planned for (gpuLanes.planLanes) */
  engine: EngineId
  blender_version: string | null
  /** frames of its range not yet downloaded: what a node would render for it */
  frames_left: number
}

/**
 * SQL (a FROM ... WHERE body, for `SELECT 1 FROM ${...}` or COUNT) for the
 * frames of chunk `c`'s current range that have not landed on this
 * computer. By job and range, never by frames.chunk_id: requeue()
 * re-points only rows that were not yet downloaded, so a frame's chunk_id
 * says which chunk last owned it, not which chunk covers it now.
 */
const UNDOWNLOADED_OF_C = `frames f
  WHERE f.job_id = c.job_id AND f.frame BETWEEN c.frame_start AND c.frame_end
    AND f.state != 'downloaded'`

/**
 * What a requeue or re-split did, for announcing once it has committed.
 * - complete: every frame of the range had already landed
 * - pending: back in the queue, narrowed to the frames still missing
 * - failed: out of retries
 */
interface Resplit {
  outcome: 'complete' | 'pending' | 'failed'
  /** chunks whose rows it wrote, the ones it created included */
  touched: string[]
}

/** What settling a failed attempt did, for announcing once it has committed. */
interface Settled {
  /** null = nothing written (a cancelled job's chunk) */
  r: Resplit | null
  /** what to tell the user: why it failed and what happens next */
  alerts: AlertEvent[]
}

/** The startup recovery hold as app_state keeps it (key 'recovery_hold'). */
interface RecoveryHoldRecord {
  /** the jobs that had unfinished work when the hold was set */
  jobIds: string[]
  /** epoch ms the hold was first set, kept across relaunches */
  since: number
}

interface JobRow {
  id: string
  name: string
  blend_path: string
  engine: EngineId
  frame_step: number
  blender_version: string | null
  addon_ids: string
  state: string
  share_node: number
  /** JSON JobAttention: why the job waits on the user; null = it does not */
  attention: string | null
}

/** noderunner.py's state/<chunkId>.json; see its header. Fields are only ever added. */
interface AgentState {
  status: 'rendering' | 'encoding' | 'done' | 'failed'
  currentFrame: number | null
  framesDone: number
  framesTotal?: number
  error?: string
  exitCode: number | null
  /** epoch seconds of the agent's last state write */
  updatedAt?: number
  /** GPU index the agent pinned this chunk's Blender to; absent/null = unpinned */
  gpu?: number | null
  /** why a failed state failed: scene | job | machine | transient (noderunner ERROR_KINDS) */
  errorKind?: string | null
  /** the chunk log's last lines, on a failed state */
  logTail?: string[]
  /** epoch seconds of the last real progress (a frame saved or started) */
  lastProgressAt?: number
  /** the engine the scene really renders with, once Blender loaded it */
  engine?: string | null
  /** Blender reported running out of GPU memory */
  oom?: boolean
  /** the app asked for a pinned render and the agent could not pin it */
  pinFailed?: boolean
  /** preflight.py's report (plan 1.16) */
  preflight?: {
    ok: boolean
    summary?: string
    missing?: Array<{ kind: string; name: string; path: string; packable?: boolean }>
    problems?: string[]
    warnings?: string[]
  } | null
}

/** Where in an attempt a chunk failed (admission.ts AttemptStage). */
type FailureStage = AttemptStage

/** A failed attempt, as the retry policy (plan 1.17) weighs it. */
interface ChunkFailure {
  /** whose fault, and why in words that always carry the error's code */
  c: Classification
  stage: FailureStage
  /** the node it failed on */
  nodeId: string
  /**
   * No node can render the job as it stands: the agent said errorKind scene
   * (the preflight, a scene guard) or job (an engine no node has, the job's
   * own expression raising), or the job needs an extension the registry no
   * longer has. The job fails at once with this as its attention, and no
   * chunk of it is sent again (plan 1.16).
   */
  fatal?: JobAttentionKind
}

/** A failure the scheduler found itself, which it need not ask classify() about. */
function own(kind: Classification['kind'], rule: string, reason: string): Classification {
  return { kind, rule, reason, retryable: kind !== 'localFs', outcomeUnknown: false }
}

/**
 * Thrown in dispatch when a job needs an add-on and the registry lists none.
 * addons.ts reads an unreadable registry.json as empty (EMFILE under a heavy
 * download, EBUSY or EPERM on Windows while saveRegistry renames it), so an
 * empty list says nothing about the add-on: this computer's failure, which
 * waits and is tried again, and holds the job if it recurs (the breaker's
 * localFs), never the job's failure.
 */
class AddonRegistryUnread extends Error {
  override readonly name = 'AddonRegistryUnread'
}

/** Thrown in dispatch for a job no node can run as it stands. */
class JobCannotRun extends Error {
  override readonly name = 'JobCannotRun'

  constructor(
    readonly kind: JobAttentionKind,
    message: string
  ) {
    super(message)
  }
}

/**
 * The engines a node's report may relabel a job between: both run in stock
 * Blender, so the label changes nothing that is sent. Never into or out of
 * Octane (see ChunkRun.noteEngine).
 */
const STOCK_ENGINES: ReadonlySet<string> = new Set<EngineId>(['cycles', 'eevee'])

/**
 * A node's engine report as the user may read it. The agent writes
 * scene.render.engine lower-cased (noderunner ENGINE_NAMES), but the state
 * file is the host's to write, and the engine went unclipped into the job's
 * reason and its alert: any length, any words, "sign in again at …".
 */
function engineName(engine: string): string {
  return /^[a-z0-9_]{1,32}$/.test(engine) ? engine : 'an unknown engine'
}

/**
 * What a failed agent state means for the retry policy. classify() reads
 * errorKind 'scene' and the exit code; the agent's errorKind 'job' and
 * 'machine' are read here too, because a job no node can run is not a crash
 * that may pass, and a node that ran out of GPU memory or lacks a GPU is the
 * machine's failure whatever Blender's exit code says (an out-of-memory stop
 * is the agent's own SIGTERM).
 */
function agentFailure(state: AgentState, nodeId: string): ChunkFailure {
  const f: AgentFailure = {
    exitCode: typeof state.exitCode === 'number' ? state.exitCode : null,
    error: state.error ?? null,
    errorKind: state.errorKind ?? null,
    gpu: typeof state.gpu === 'number' ? state.gpu : null
  }
  const kind = state.errorKind
  if (kind === 'scene' || kind === 'job') {
    // The agent's own words: they name what failed ("scene preflight failed:
    // 2 file(s) not packed..."), and describeError adds the exit code.
    const message = describeError(f)
    const c =
      kind === 'scene'
        ? { ...classify(f), reason: message }
        : own('job', 'agent-job', `the job asks for what no node has: ${message}`)
    return {
      c: { ...c, retryable: false },
      stage: 'render',
      nodeId,
      fatal: attentionKind(kind, message)
    }
  }
  // Out of memory is agent-oom whatever else the error says: its text quotes
  // Blender's "CUDA error: Out of memory", which classify reads as the GPU
  // failing, and a node is rested for that but not for this (rest()).
  if (state.oom === true) {
    return {
      c: own('machine', 'agent-oom', `out of GPU memory on this node: ${describeError(f)}`),
      stage: 'render',
      nodeId
    }
  }
  const c = classify(f)
  if (kind === 'machine' && c.kind !== 'machine') {
    return {
      c: own('machine', 'agent-machine', `this node cannot render it: ${describeError(f)}`),
      stage: 'render',
      nodeId
    }
  }
  return { c, stage: 'render', nodeId }
}

/** The attention a job gets for the agent's errorKind scene or job. */
function attentionKind(errorKind: 'scene' | 'job', message: string): JobAttentionKind {
  if (errorKind === 'scene') return 'scene'
  if (/octane/i.test(message)) return 'engine'
  if (/python expression|extension|add-?on/i.test(message)) return 'extension'
  return 'scene'
}

/**
 * Stall watchdog: the agent rewrites the chunk state at least every ~2s while
 * its blender is producing output. A state file frozen for this long means
 * the render process died or hung without the agent noticing (observed in
 * the wild: zombie blender after an agent restart) — fail the chunk so the
 * requeue path re-renders only what's missing instead of polling forever.
 */
const STATE_STALL_MS = 15 * 60_000

/**
 * A render that is alive (its state kept fresh) but has made no progress,
 * no frame started or saved, for at least this long is taken as hung and
 * stopped (ChunkRun.hungFor)...
 */
const HUNG_MIN_MS = 45 * 60_000
/**
 * ...and for at least this many times the longest a frame of its job has
 * been seen to take on the same hardware (Scheduler.frameTimeFor), since a
 * heavy scene legitimately spends a long while on each frame.
 */
const HUNG_SLOWEST_FACTOR = 3
/**
 * The limit while nothing is known of the job's frames on that hardware: no
 * run of it there has yet seen a frame saved. Judged against HUNG_MIN_MS
 * alone, every chunk's first frame was killed once it passed 45 minutes, and
 * again on each retry: noderunner's heartbeat was added for this user's SDF
 * scenes, silent for 15+ minutes a frame on a whole node, and pinned to one
 * card of an eight-GPU node the same frame takes two hours.
 */
const HUNG_UNKNOWN_MS = 3 * 60 * 60_000

/**
 * No state file for this long after the spec was queued, and the run asks
 * the node why (ChunkRun.checkMissingState). The agent writes one within
 * seconds of taking a spec, and the spec stays in its inbox until the render
 * is over, so the only good reason for none is a spec still waiting its turn
 * there (prefetched, behind busy slots), with the agent alive.
 *
 * Field incident 81fe2875: the app was launched twice on one profile, and the
 * second launch re-provisioned every node, deleting the specs waiting in
 * their inboxes. The first launch's runs for them never saw a state file,
 * and the stall watchdog only ever looked at one, so they polled for good:
 * 7 of 24 paid GPUs held by work nobody was doing.
 */
const STATE_MISSING_MS = 3 * 60_000

/**
 * Every read of the state failing (exec throws, times out or loses its
 * channel) for this long, and the run gives its chunk back. A node that
 * stops answering was otherwise polled every 5 s for good, its chunk
 * 'rendering' and its lane held, since the failed reads read as "no news".
 * Noticing a dead node and letting it go is the node supervisor's (plan
 * 1.7); this is the run's own bound on it.
 */
const STATE_UNREADABLE_MS = 10 * 60_000

/** Deadline on the agentAlive heartbeat check, which has none of its own. */
const AGENT_CHECK_TIMEOUT_MS = 30_000

/** A state read, as the run needs to tell them apart. */
type StateRead =
  | { kind: 'state'; state: AgentState }
  /** no state file: cat said there is none */
  | { kind: 'missing' }
  /** the read itself failed: nothing is known */
  | { kind: 'unread'; error: string }

/** Resolve `p`, or null once `ms` pass or it rejects. */
function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      () => {
        clearTimeout(timer)
        resolve(null)
      }
    )
  })
}

/** EWMA weight for the per-chunk frame-rate estimate (30% new sample). */
const RATE_ALPHA = 0.3

class ChunkRun {
  private stopped = false
  private downloader: ChunkDownloader | null = null
  private stopTail: (() => void) | null = null
  private dispatchedAt = Date.now()
  private engineNoted = false
  /** Since when the state file has been missing / every read of it failed, in a row (epoch ms). */
  private missingSince: number | null = null
  private unreadSince: number | null = null
  /** The latest lastProgressAt this run has seen (agent epoch s), and the longest gap between two. */
  private progressAt: number | null = null
  private slowestProgressS = 0
  /**
   * framesDone at the last state read, and whether a frame was saved while
   * this run watched: only then does its longest gap span a whole frame.
   */
  private framesSeen: number | null = null
  private timedFrame = false

  /** EWMA of frames/sec while rendering; null until two progress samples land. */
  private framesPerSec: number | null = null
  private lastFramesDone = 0
  private lastSampleAt = 0
  /** Running mean of how many chunks shared this node during the render. */
  private concurrencySum = 0
  private concurrencySamples = 0
  /** Running mean of how many runs shared this run's GPU, while it was pinned to one. */
  private gpuRunsSum = 0
  private gpuRunsSamples = 0
  /** GPU the agent pinned this run to (from its state file); null = unpinned/unknown */
  gpu: number | null = null

  constructor(
    readonly chunkId: string,
    readonly jobId: string,
    readonly nodeId: string,
    /** may this chunk share its node? (mirrors the job's share_node flag) */
    readonly shareNode: boolean,
    private readonly ssh: SshConnection,
    /**
     * The lanes and pinning this chunk is sent with, planned when it was
     * assigned (Scheduler.lanePlanFor): what the node's other runs are
     * admitted beside (admission.ts exclusiveLanesFor).
     */
    readonly lanes: LanePlan,
    /** the job's engine when it was assigned, which `lanes` was planned for */
    readonly engine: EngineId
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
  private sampleRate(framesDone: number, work: ReadonlyArray<{ gpu?: number | null }>): void {
    const now = Date.now()
    this.concurrencySum += Math.max(1, work.length)
    this.concurrencySamples += 1
    if (this.gpu != null) {
      this.gpuRunsSum += runsOnGpu(work, this.gpu)
      this.gpuRunsSamples += 1
    }
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

  /** Chunks the job is split into now, requeue's splits included. */
  private jobChunks(): number {
    return (
      getDb().prepare('SELECT COUNT(*) AS n FROM chunks WHERE job_id = ?').get(this.jobId) as {
        n: number
      }
    ).n
  }

  /**
   * The scene's real engine, from the agent, written back to the job (plan
   * 1.16): the submit dialog's engine is only a label, and the spec, the
   * Jobs list and History all go by it. Once per run; an engine that is not
   * one of the app's (workbench, a render add-on's) leaves the label alone.
   *
   * Only between Cycles and EEVEE. The report is the node's word, and an
   * Octane job is sent the user's OTOY credentials at dispatch (setupOctane):
   * a host that wrote "octane" into a Cycles job's state file had them on the
   * job's next dispatch to it. When the report and the job disagree about
   * Octane, the frames are not what the job asked for either way (stock
   * Blender renders an Octane scene with another engine, #85), so the job
   * keeps its engine and fails, with the reason: the returned failure.
   */
  private noteEngine(engine: string | null | undefined): ChunkFailure | null {
    if (this.engineNoted || typeof engine !== 'string' || engine === '') return null
    this.engineNoted = true
    const asked = this.job().engine
    if ((engine === 'octane') !== (asked === 'octane')) {
      const message =
        engine === 'octane'
          ? `the scene renders with Octane, but the job was submitted as ${asked}, ` +
            'which stock Blender renders with another engine: submit it again as an Octane job'
          : `the job was submitted as Octane, but the scene renders with ${engineName(engine)}: ` +
            'submit it again with the engine the scene uses'
      return {
        c: own('job', 'engine-mismatch', message),
        stage: 'render',
        nodeId: this.nodeId,
        fatal: 'engine'
      }
    }
    if (!STOCK_ENGINES.has(engine) || !STOCK_ENGINES.has(asked)) return null
    const r = getDb()
      .prepare(
        `UPDATE jobs SET engine = ? WHERE id = ? AND engine != ? AND engine IN ('cycles', 'eevee')`
      )
      .run(engine, this.jobId, engine)
    if (r.changes === 0) return null
    emit('render:logLine', {
      nodeId: this.nodeId,
      chunkId: this.chunkId,
      line: `the scene renders with ${engine}: the job's engine is now ${engine}`,
      ts: Date.now()
    })
    emitJobChanged(this.jobId)
    return null
  }

  /**
   * Frames in this chunk's CURRENT range that have not landed locally.
   *
   * By job and range, never by chunk_id: requeue() re-points only rows that
   * were not yet downloaded, so a frame's chunk_id says which chunk last owned
   * it, not which chunk covers it now.
   */
  private undownloadedFrames(): number[] {
    const chunk = this.chunk()
    const rows = getDb()
      .prepare(
        `SELECT frame FROM frames
         WHERE job_id = ? AND frame BETWEEN ? AND ? AND state != 'downloaded'
         ORDER BY frame`
      )
      .all(this.jobId, chunk.frame_start, chunk.frame_end) as Array<{ frame: number }>
    return rows.map((r) => r.frame)
  }

  async dispatch(): Promise<void> {
    const chunk = this.chunk()
    const job = this.job()
    const settings = getSettings()
    const node = nodeManager.get(this.nodeId)
    if (!node) throw new Error('node vanished')
    const slotTarget = this.shareNode ? scheduler.slotTargetFor(this.nodeId) : 1
    const lanes = this.lanes

    this.setChunk({ state: 'assigned', node_id: this.nodeId, assigned_at: Date.now() })
    // State only: setState would also wipe the node's last error, which is how
    // a node that kept refusing dispatches showed nothing wrong between them.
    node.update({ state: 'rendering' })
    refreshJobState(this.jobId)

    // Steps 1-3 are serialized per node (see withNodePrep) — with multiple
    // slots two dispatches would otherwise race on userpref/extension state.
    const remoteBlend = `${this.jobId}.blend`
    const bootstrapExprs: string[] = await withNodePrep(this.nodeId, async (step) => {
      // 1. Blender version (idempotent, cheap when already installed).
      if (job.blender_version && !node.snapshot.blenderVersions.includes(job.blender_version)) {
        step(`installing Blender ${job.blender_version}`)
        await installBlender(this.ssh, this.nodeId, job.blender_version)
      }

      // 1b. Octane jobs need the X11/VNC + OctaneServer environment (and an
      // OctaneBlender build on the node — see docs/OCTANE.md).
      if (job.engine === 'octane' && !node.snapshot.octaneReady) {
        const { setupOctane } = await import('../octane/octaneLicense')
        step('setting up Octane')
        await setupOctane(this.ssh, this.nodeId)
      }

      // 2. Extensions for this job (once per node+version+zip — cached; the
      //    bootstrap mechanism contributes a register() expression instead).
      const exprs: string[] = []
      const addonIds = JSON.parse(job.addon_ids) as string[]
      // Read once: two reads could disagree, one failing and the next not.
      const registry = addonIds.length > 0 ? listAddons() : []
      for (const addonId of addonIds) {
        const addon = registry.find((a) => a.id === addonId)
        if (!addon && registry.length === 0) {
          throw new AddonRegistryUnread(
            `the job needs the add-on ${addonId}, and the add-on registry could not be read ` +
              'or lists no add-ons'
          )
        }
        if (!addon) {
          // Rendering on without it was skipping it: unless the scene guards
          // against that itself, every frame renders wrong and the job
          // completes (#197). No node has it, so the job stops here.
          throw new JobCannotRun(
            'extension',
            `the job needs the add-on ${addonId}, which is no longer in the add-on registry`
          )
        }
        if (job.blender_version) {
          const key = `${this.nodeId}:${job.blender_version}:${addon.id}:${addon.zipHash}`
          let expr: string | null
          if (installedExtensions.has(key)) {
            expr = installedExtensions.get(key) ?? null
          } else {
            step(`installing the add-on ${addon.id}`)
            expr = await installExtension(this.ssh, this.nodeId, job.blender_version, addon)
            installedExtensions.set(key, expr)
          }
          if (expr) exprs.push(expr)
        }
      }

      // 3. Scene upload (hash-skipped when the node already has this version).
      step('uploading the scene')
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
    // pendingChunks offered this chunk with frames left, but prep takes
    // minutes, and the last of them can land meanwhile (another run's
    // download of a frame since moved to this chunk). Sent anyway, the node
    // renders frames this computer already has and holds a lane for them:
    // job da68b61b's leftover sub-chunk sat 'assigned' at 0% GPU.
    if (this.nothingLeft('after node prep')) return

    // 4. Job spec — written atomically (agent ignores *.tmp.json).
    const spec = {
      chunkId: this.chunkId,
      blendFile: remoteBlend,
      blenderVersion: job.blender_version,
      engine: job.engine,
      frameStart: chunk.frame_start,
      frameEnd: chunk.frame_end,
      frameStep: job.frame_step,
      // How many chunks the job is split into, so the scene preflight refuses
      // an unbaked simulation that each chunk would start cold (plan 1.16)
      // before the first one renders, rather than when the second one does.
      jobChunks: this.jobChunks(),
      // Concurrent render slots the agent may use (1 = single-slot). This is
      // the node's current auto-judged target, not a global setting.
      nodeSlots: slotTarget,
      // Backstop for the agent: the scheduler already refuses to co-locate an
      // exclusive chunk, but a spec landing as a node drains could still race.
      exclusive: !this.shareNode,
      // GPU lanes (see gpuLanes): how many exclusive chunks may run side by
      // side (1 = the whole node, as before), and whether each render is
      // pinned to one GPU with CUDA_VISIBLE_DEVICES. Shared chunks are pinned
      // too, to the least-loaded GPU. Older agents ignore both keys.
      lanes: lanes.lanes,
      pinGpus: lanes.pin,
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
    await this.ssh
      .exec(`rm -f ${REMOTE_ROOT}/state/${this.chunkId}.json`, {
        timeoutMs: 30_000,
        label: 'clear agent state'
      })
      .catch(() => {})
    if (this.abandoned('before queueing the spec')) return
    // Written to a name the agent ignores, then moved over the spec's (mv -f
    // semantics), each request on the connection's current SFTP channel and
    // under a deadline (writeRemoteFileAtomic). On a channel another
    // transfer's stall had reset, the write held one wrapper across both
    // requests and was never answered, so the dispatch hung with its chunk
    // 'assigned' and its lane taken (#244, #245).
    const inbox = posix.join(REMOTE_ROOT, 'jobs', 'inbox')
    await writeRemoteFileAtomic(this.ssh, `${inbox}/${this.chunkId}.json`, JSON.stringify(spec), {
      tmpPath: `${inbox}/${this.chunkId}.tmp.json`
    })
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
    // The node took the spec: an error a failed dispatch wrote on it is stale.
    scheduler.dispatchLanded(this.nodeId)

    // 5. Live downloads + log tail + state poll.
    this.downloader = new ChunkDownloader({
      jobId: this.jobId,
      chunkId: this.chunkId,
      nodeId: this.nodeId,
      ssh: this.ssh,
      remoteChunkDir: posix.join(REMOTE_ROOT, 'renders', this.chunkId),
      frames: { start: chunk.frame_start, end: chunk.frame_end, step: job.frame_step }
    })
    this.downloader.start()
    // Per-chunk log tails hold one SSH channel each for the chunk's whole
    // lifetime; with many slots per node they alone exhaust the server's
    // channel cap (OpenSSH MaxSessions ~10). State polling remains the
    // durable progress source — only tail on low-concurrency nodes.
    if (Math.max(slotTarget, lanes.lanes) <= 2) void this.tailLog()
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
          }),
        // No deadline: it runs for the chunk's life, and stop() ends it.
        { label: 'log tail' }
      )
      this.stopTail = stop
    } catch {
      // tail is best-effort; state polling is the durable source
    }
  }

  /**
   * The agent's state for this chunk. A missing file and a failed read used
   * to come back alike, as null, "no news", and the loop polled on for good
   * through either: an agent that never took the spec, a node that stopped
   * answering. Told apart, each has its bound (noState).
   */
  private async readAgentState(): Promise<StateRead> {
    try {
      // Timed out: an exec on a wedged connection never returns, and this loop
      // is the only thing that notices a chunk finishing or failing.
      const r = await this.ssh.exec(`cat ${REMOTE_ROOT}/state/${this.chunkId}.json 2>/dev/null`, {
        timeoutMs: 30_000,
        label: 'read agent state'
      })
      // cat's answer for no such file: exit 1 and nothing printed. Anything
      // else non-zero, null included (the channel closed under it), is a
      // read that did not happen.
      if (r.code === 1 && r.stdout === '') return { kind: 'missing' }
      if (r.code !== 0) return { kind: 'unread', error: `the read ended with exit ${r.code}` }
      return { kind: 'state', state: JSON.parse(r.stdout) as AgentState }
    } catch (e) {
      return { kind: 'unread', error: describeError(e) }
    }
  }

  /**
   * A poll that brought no state: bound how long that may go on. True when
   * the run has settled its chunk and must stop.
   */
  private async noState(read: Exclude<StateRead, { kind: 'state' }>): Promise<boolean> {
    const now = Date.now()
    if (read.kind === 'unread') {
      this.unreadSince ??= now
      if (now - this.unreadSince < STATE_UNREADABLE_MS) return false
      // Withdrawn, in case the node answers again: its agent would render
      // on with nobody to fetch the frames. Bounded, like every exec here.
      await this.retractSpec()
      if (this.stopped) return true
      this.fail(
        'node',
        own(
          'machine',
          'node-silent',
          `the node has not answered for ${Math.round(STATE_UNREADABLE_MS / 60_000)} min ` +
            `(${read.error})`
        )
      )
      return true
    }
    this.unreadSince = null
    this.missingSince ??= now
    if (now - this.missingSince < STATE_MISSING_MS) return false
    const settled = await this.checkMissingState()
    if (settled || this.stopped) return true
    // Waiting its turn, or nothing could be told: ask again in a while.
    this.missingSince = Date.now()
    return false
  }

  /**
   * No state file STATE_MISSING_MS after the spec was queued: is the spec
   * still in the agent's inbox, and is the agent alive (its heartbeat)?
   * - both: it is waiting its turn behind busy slots; wait on.
   * - the agent is not alive: nothing will ever take the spec. It is
   *   withdrawn, the chunk goes to another node, and the node is sent
   *   nothing more (Scheduler.agentDownOn).
   * - the spec is gone with nothing written for it: something else emptied
   *   the inbox, as a second launch of the app re-provisioning the node did
   *   (81fe2875). The chunk goes back in the queue.
   * Neither costs a render retry: no render was paid for. True when it has
   * settled the run.
   */
  private async checkMissingState(): Promise<boolean> {
    const [queued, alive] = await Promise.all([this.specQueued(), this.agentUp()])
    if (this.stopped) return true
    // One of the checks did not answer: nothing can be told this time.
    if (queued == null || alive == null) return false
    if (queued && alive) return false
    if (!alive) {
      await this.retractSpec()
      if (this.stopped) return true
      await this.downloader?.drain()
      if (this.stopped) return true
      const reason =
        "the node's agent is not running (no heartbeat), so nothing takes the chunks sent to it"
      scheduler.agentDownOn(this.nodeId, reason)
      this.fail('dispatch', own('machine', 'agent-down', reason))
      return true
    }
    // Frames of an earlier attempt may be listed: fetched, so the requeue
    // leaves them out.
    await this.downloader?.drain()
    if (this.stopped) return true
    this.fail(
      'dispatch',
      own(
        'machine',
        'spec-lost',
        `the chunk's spec left the node's inbox with no render started for it ` +
          `(${Math.round(STATE_MISSING_MS / 60_000)} min with no state): something else ` +
          're-provisioned the node or restarted its agent'
      )
    )
    return true
  }

  /** Is this chunk's spec still in the agent's inbox? null when that could not be read. */
  private async specQueued(): Promise<boolean | null> {
    try {
      const r = await this.ssh.exec(
        `cat ${REMOTE_ROOT}/jobs/inbox/${this.chunkId}.json 2>/dev/null`,
        { timeoutMs: 30_000, label: 'check agent inbox' }
      )
      if (r.code === 0) return true
      if (r.code === 1 && r.stdout === '') return false
      return null
    } catch {
      return null
    }
  }

  /** The agent's heartbeat is fresh (provisioner's agentAlive); null when that could not be read. */
  private agentUp(): Promise<boolean | null> {
    return within(agentAlive(this.ssh), AGENT_CHECK_TIMEOUT_MS)
  }

  private async pollUntilDone(): Promise<void> {
    const frameStep = this.job().frame_step
    for (;;) {
      if (this.stopped) return
      const read = await this.readAgentState()
      // Aborted during the read: the chunk now belongs to requeue() or
      // cancelJob, and every write below would be to a row this run no longer
      // owns — 'downloading' over the 'pending' a requeue had just set, say.
      if (this.stopped) return
      if (read.kind !== 'state' && (await this.noState(read))) return
      if (read.kind === 'state') {
        const state = read.state
        this.missingSince = null
        this.unreadSince = null
        // Every state, the done one included: a one-frame chunk's frame is
        // timed by the read that finds it done.
        this.noteProgress(state)
        // Re-read the range every iteration rather than computing it once:
        // requeue() can narrow this chunk mid-flight, and a cached total then
        // reports progress against a range that no longer exists.
        const chunk = this.chunk()
        const framesTotal = Math.floor((chunk.frame_end - chunk.frame_start) / frameStep) + 1
        this.setChunk({ frames_done: state.framesDone })
        const gpu = typeof state.gpu === 'number' ? state.gpu : null
        if (gpu !== this.gpu) {
          this.gpu = gpu
          nodeManager.get(this.nodeId)?.emitChanged()
        }
        if (state.pinFailed === true) scheduler.pinFailedOn(this.nodeId)
        emit('chunk:progress', {
          chunkId: this.chunkId,
          jobId: this.jobId,
          nodeId: this.nodeId,
          currentFrame: state.currentFrame,
          framesDone: state.framesDone,
          framesTotal
        })
        if (state.status === 'rendering') {
          this.sampleRate(state.framesDone, scheduler.activeWorkForNode(this.nodeId))
        }
        const mismatch = this.noteEngine(state.engine)
        if (mismatch) {
          // Every frame from here is of an engine the job did not ask for,
          // on a paid node: stop the render rather than drain it.
          await this.retractSpec()
          if (this.stopped) return
          this.finish('failed', mismatch)
          return
        }
        if (state.status === 'encoding') this.setChunk({ state: 'encoding' })
        if (state.status === 'done') {
          this.setChunk({ state: 'downloading' })
          refreshJobState(this.jobId)
          const drained = await this.downloader?.drain()
          // The drain can take minutes. A cancel or a node death in that time
          // has already settled this chunk, and finishing it anyway would
          // overwrite that: 'complete' over frames that never arrived, or
          // 'failed' → requeue → 'pending', resurrecting cancelled work.
          if (this.stopped) return
          // Failing sends the chunk through requeue(), which re-splits around
          // the frames that DID land — so only the missing ones re-render,
          // rather than the chunk quietly completing with a hole in it. The
          // render itself succeeded in the first three cases, so none of them
          // costs it a render retry.
          if (drained && !drained.manifestRead) {
            // What the agent listed since the last good poll was never even
            // seen, so there is no "lost" list to trust.
            this.fail(
              'download',
              own(
                'transient',
                'manifest-unread',
                "could not read the node's manifest for the final download pass"
              )
            )
            return
          }
          const lost = drained?.lost ?? []
          if (lost.length > 0) {
            // The render succeeded but frames did not reach us, and this was
            // the last download pass.
            this.fail(
              'download',
              own(
                'transient',
                'frames-lost',
                `${lost.length} frame(s) could not be downloaded: ${lost.slice(0, 3).join(', ')}`
              )
            )
            return
          }
          // Frames the node has and this computer's disk would not take
          // (plan 1.10): no fault of the render or the node, so nothing is
          // charged. Sent again only once the disk takes files, since tick()
          // dispatches nothing while localSinkHold() is set; charging a retry
          // here re-rendered them after each 20-minute hold, and failed the
          // chunk after four.
          const held = drained?.localSinkBlocked ?? []
          if (held.length > 0) {
            const sink = localSinkHold()
            this.fail(
              'download',
              own(
                'localFs',
                'local-sink',
                `${held.length} frame(s) held back by the local disk: ` +
                  (sink?.reason ?? 'it would not take them')
              )
            )
            return
          }
          // Complete means downloaded, and the frames table is what says so —
          // not the agent's 'done', and not the downloader, which only knows
          // what the manifest listed. A frame Blender never wrote, or never
          // manifested, is in neither: the render's failure, charged to it.
          const missing = this.undownloadedFrames()
          if (missing.length > 0) {
            this.fail(
              'render',
              own(
                'job',
                'frames-missing',
                `${missing.length} frame(s) never arrived: ${missing.slice(0, 3).join(', ')}`
              )
            )
            return
          }
          this.finish('complete')
          return
        }
        if (state.status === 'failed') {
          await this.downloader?.drain()
          if (this.stopped) return
          // Before the requeue, so the chunk is not sent back into the plan
          // it ran out of memory in (#228).
          if (state.oom === true) scheduler.outOfMemoryOn(this)
          this.finish('failed', agentFailure(state, this.nodeId))
          return
        }
        if (
          state.updatedAt != null &&
          Date.now() - state.updatedAt * 1000 > STATE_STALL_MS &&
          ['rendering', 'encoding'].includes(state.status)
        ) {
          await this.downloader?.drain()
          if (this.stopped) return
          // The node's failure, not the render's: its Blender or agent died
          // or hung without saying so.
          this.fail(
            'render',
            own(
              'machine',
              'agent-stalled',
              `render stalled — no agent state update for ${Math.round(STATE_STALL_MS / 60000)} min`
            )
          )
          return
        }
        const hung = this.hungFor(state)
        if (hung != null) {
          // Stopped first: a hung Blender holds its GPU, and nothing else
          // will stop it (the agent has no deadline on a render).
          await this.retractSpec()
          if (this.stopped) return
          await this.downloader?.drain()
          if (this.stopped) return
          const known =
            hung.frameS == null
              ? 'no frame of this job had finished on this hardware yet'
              : `this job's frames have taken up to ${Math.max(1, Math.round(hung.frameS / 60))} ` +
                'min on this hardware'
          this.fail(
            'render',
            own(
              'machine',
              'render-hung',
              `Blender made no progress (no frame started or saved) for ` +
                `${Math.round(hung.idleMs / 60_000)} min while it kept running, where ${known}, ` +
                'so it was stopped'
            )
          )
          return
        }
      }
      await new Promise((r) => setTimeout(r, STATE_POLL_MS))
    }
  }

  /**
   * Fold a state read into what is known of how long the job's frames take
   * on this run's hardware: the longest gap between two progress points
   * (lastProgressAt) the run has seen. That is a frame's time only once a
   * frame was saved while the run watched (framesDone rose between two
   * reads). Before that its gaps are Blender starting and loading the scene,
   * which say nothing of how long a frame takes. From then on it is the
   * job's to know (Scheduler.noteFrameTime), for every run of it there.
   */
  private noteProgress(state: AgentState): void {
    const at = state.lastProgressAt
    if (typeof at === 'number' && Number.isFinite(at)) {
      if (this.progressAt != null && at > this.progressAt) {
        this.slowestProgressS = Math.max(this.slowestProgressS, at - this.progressAt)
      }
      if (this.progressAt == null || at > this.progressAt) this.progressAt = at
    }
    if (typeof state.framesDone === 'number') {
      if (this.framesSeen != null && state.framesDone > this.framesSeen) this.timedFrame = true
      this.framesSeen = state.framesDone
    }
    if (this.timedFrame && this.slowestProgressS > 0) {
      scheduler.noteFrameTime(this, this.slowestProgressS)
    }
  }

  /**
   * How long a render still running has gone without progress, when that
   * is long enough to take it as hung, and what its job's frames are known
   * to take there (seconds; null = nothing known yet); null otherwise.
   *
   * The agent refreshes updatedAt every 60 s while Blender lives, so a state
   * kept fresh says the process is alive, not that it is working, and a
   * hung Blender (a GPU or driver hang, a deadlocked kernel compile, a
   * startup script that never returns) held its paid GPU for good: the stall
   * watchdog above only fires on a state that stops changing (#77, #192).
   * lastProgressAt moves only when Blender starts, and on each frame it
   * starts or saves. Measured against updatedAt, both on the node's clock.
   *
   * A heavy scene's frames can take a long while, so the limit is the longer
   * of HUNG_MIN_MS and HUNG_SLOWEST_FACTOR times the longest the job's frames
   * have taken on this hardware, whichever run of it saw that, and
   * HUNG_UNKNOWN_MS while nothing is known. It was this run's own slowest
   * gap, which on a chunk's first frame is only Blender starting: every
   * frame longer than 45 minutes was killed, on every attempt. An agent that
   * does not report lastProgressAt is never judged.
   */
  private hungFor(state: AgentState): { idleMs: number; frameS: number | null } | null {
    const at = state.lastProgressAt
    if (typeof at !== 'number' || !Number.isFinite(at)) return null
    if (state.status !== 'rendering' || typeof state.updatedAt !== 'number') return null
    const idleMs = (state.updatedAt - at) * 1000
    const frameS = scheduler.frameTimeFor(this)
    const limitMs =
      frameS == null ? HUNG_UNKNOWN_MS : Math.max(HUNG_MIN_MS, HUNG_SLOWEST_FACTOR * frameS * 1000)
    return idleMs > limitMs ? { idleMs, frameS } : null
  }

  /** finish('failed') for a failure this run found itself. */
  private fail(stage: FailureStage, c: Classification): void {
    this.finish('failed', { c, stage, nodeId: this.nodeId })
  }

  /**
   * Settle the attempt. A failure is announced, and charged to whichever
   * budget it belongs to, by the scheduler's requeue (plan 1.17), which
   * knows what happens next.
   */
  private finish(state: 'complete' | 'failed', failure?: ChunkFailure): void {
    this.cleanup()
    // cancelJob settled every chunk of a cancelled job in one go, and nothing
    // may write over that. A run it aborted never gets here (see the stopped
    // checks in pollUntilDone); this holds for any it could not reach.
    // onChunkFinished still runs, to release the run and idle its node —
    // requeue() leaves a cancelled job's chunks alone.
    if (this.job().state === 'cancelled') {
      scheduler.onChunkFinished(this)
      return
    }
    this.setChunk({ state })
    if (state === 'complete') {
      // Feed the machine-selection strategy with measured throughput.
      const elapsedH = (Date.now() - this.dispatchedAt) / 3_600_000
      const chunk = this.chunk()
      const frames = Math.floor((chunk.frame_end - chunk.frame_start) / this.job().frame_step) + 1
      const snap = nodeManager.get(this.nodeId)?.snapshot
      const gpuName = snap?.gpuName
      if (gpuName && elapsedH > 0.005) {
        // Scale by the concurrency this chunk actually ran under. gpu_perf
        // ranks OFFERS, so it must mean "frames/hour the hardware delivers".
        // A chunk sharing a node with five others takes ~6x as long in
        // wall-clock; recording that unscaled would teach the offer scorer
        // that packing makes a GPU slow, and it would stop buying the models
        // that pack best.
        //
        // Stored per GPU, so a 4-GPU node and a 1-GPU node of one model
        // teach the same figure. A pinned run is scaled by the runs that
        // shared ITS card, not by the runs on the node over every GPU: with
        // fewer runs than cards each had a card to itself, and the node
        // figure taught runs/GPUs of the truth (a job's last chunk alone on a
        // 4-GPU node, 25%), which pulled every offer of the model down the
        // ranking, 1-GPU offers included (#225).
        const perGpu = perGpuFramesPerHour({
          runFramesPerHour: frames / elapsedH,
          gpu: this.gpu,
          meanRunsOnGpu: this.gpuRunsSamples > 0 ? this.gpuRunsSum / this.gpuRunsSamples : 1,
          meanRunsOnNode: this.meanConcurrency(),
          numGpus: snap?.numGpus ?? 1,
          engine: this.engine
        })
        if (perGpu != null) recordThroughput(gpuName, perGpu, 1)
      }
      scheduler.onChunkFinished(this, { rendered: true })
      return
    }
    scheduler.onChunkFinished(this, { failure })
  }

  /**
   * Is every frame of the chunk's range already on this computer? Then there
   * is nothing to send: the chunk is completed without a render, and the run
   * lets go of its node. Not through finish(), which would teach gpu_perf a
   * throughput from frames this run never rendered.
   */
  private nothingLeft(where: string): boolean {
    if (this.undownloadedFrames().length > 0) return false
    emit('render:logLine', {
      nodeId: this.nodeId,
      chunkId: this.chunkId,
      line: `every frame already downloaded ${where}: complete, nothing sent to the node`,
      ts: Date.now()
    })
    this.cleanup()
    // As finish(): a cancelled job's chunks stay as cancelJob left them.
    if (this.job().state !== 'cancelled') this.setChunk({ state: 'complete' })
    scheduler.onChunkFinished(this)
    return true
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
   *
   * Timed out: exec has no deadline of its own, and on a wedged connection
   * the call never returned. The run waiting on it never finished, so its
   * chunk stayed in flight and its node 'rendering', and scale-down never
   * let the node go.
   */
  private async retractSpec(): Promise<void> {
    await this.ssh
      .exec(
        `rm -f ${REMOTE_ROOT}/jobs/inbox/${this.chunkId}.json; pkill -f '${this.chunkId}' || true`,
        { timeoutMs: 30_000, label: 'retract spec' }
      )
      .catch(() => {})
  }

  /** True once this run has finished or been aborted: it owns nothing any more. */
  isStopped(): boolean {
    return this.stopped
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
  /** memory guard on each node's exclusive GPU lanes (see gpuLanes) */
  private laneGuards = new Map<string, LaneGuard>()
  /**
   * The most lanes per GPU a node is planned with, below the setting, for
   * the rest of its rental: 1 once a render ran out of GPU memory beside
   * another on its card (outOfMemoryOn), 0 (one unpinned lane) once its
   * agent could not pin (pinFailedOn).
   */
  private laneCeilings = new Map<string, number>()
  /**
   * Nodes whose agent a run found not running (ChunkRun.checkMissingState),
   * and why. Each chunk sent to one waited STATE_MISSING_MS for nothing and
   * cost an infrastructure retry, and nothing brings the agent back by
   * itself, so such a node is sent nothing more and is let go of once idle
   * (scalePolicy). Restarting its agent is the node supervisor's (plan 1.7);
   * forgetNode clears the mark when a node comes back.
   */
  private agentDown = new Map<string, { since: number; reason: string }>()
  /**
   * The longest a frame of each job has been seen to take, in seconds, by
   * the hardware one render of it had (frameTimeKey): what the hung-Blender
   * watchdog judges the job's runs by (ChunkRun.hungFor). Fed by every run
   * of the job; in memory only, so after a restart a job's first frames get
   * HUNG_UNKNOWN_MS again.
   */
  private frameTimes = new Map<string, Map<string, number>>()
  /**
   * At most one node at a time may be held empty for a waiting exclusive
   * chunk. See reserveForExclusive.
   */
  private reservation: { nodeId: string; chunkId: string } | null = null
  /**
   * Unfinished work from an earlier session, whose scale-up waits for the
   * user. Mirrors app_state's 'recovery_hold'. See start().
   */
  private recoveryHold: RecoveryHoldRecord | null = null
  /** The last scale-up decision, and why (see scalePolicy). */
  private lastScalePlan: ScalingPlan | null = null
  /**
   * Nodes resting after an attempt failed for their own or their network's
   * reason (plan 1.17; see rest()): tick() sends them nothing new until
   * `until`. Each failure in a row doubles the rest, and a chunk rendered on
   * the node forgets them. `lastError` is what the rest wrote on the node, so
   * clearing it later clears that and nothing another writer put there.
   */
  private rests = new Map<
    string,
    { until: number; failures: number; lastError: string; stage: FailureStage }
  >()
  /**
   * What each chunk has failed for a machine's reason, until it completes or
   * fails for good: the nodes (it goes back to one of them only when no other
   * node can take it: pickChunk), and the rules of the renders that failed
   * (the same one again is charged to the render, admission.ts chargeFor,
   * and counted by the breaker, breakerKey). The chunks a requeue splits it
   * into share its entry. In memory only: a restart forgets it, and the
   * budgets still bound every chunk.
   */
  private failedOn = new Map<string, { nodes: Set<string>; renderRules: Set<string> }>()
  /** The same failure on two nodes holds its job for the user (plan 1.17). */
  private breaker = new JobBreaker()

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

  /**
   * Forget a run. The chunk's entry goes only if it is still THIS run's: once
   * forgetNode has requeued a chunk it can be re-dispatched at once, and a
   * stale run dropping by chunk id alone deleted its successor's entry. The
   * chunk then read as not live (isLive, the scale-up's work in flight) while
   * it rendered, and a cancel could no longer find the run to stop it.
   */
  private dropRun(run: ChunkRun): void {
    if (this.runs.get(run.chunkId) === run) this.runs.delete(run.chunkId)
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
   * the job never reaches complete/partial, and scale-up keeps counting its
   * frames as work in hand, buying GPUs for work nobody is doing.
   */
  forgetNode(nodeId: string): void {
    this.slots.delete(nodeId)
    this.laneGuards.delete(nodeId)
    this.laneCeilings.delete(nodeId)
    this.agentDown.delete(nodeId)
    this.idleSince.delete(nodeId)
    if (this.reservation?.nodeId === nodeId) this.reservation = null
    // Sent nothing for a while. destroyNode forgets a node before it marks it
    // destroying, and the kick below ran a tick in between: the node still
    // read as usable and empty, and the chunks just requeued went straight
    // back to it. A node that comes back (recoverUnreachable) takes work again
    // once this has passed.
    this.rests.set(nodeId, {
      until: Date.now() + NODE_REST_BASE_MS,
      failures: 0,
      lastError: '',
      stage: 'node'
    })

    const orphaned = [...this.runsOn(nodeId)]
    this.byNode.delete(nodeId)
    if (orphaned.length === 0) return
    let requeued = 0
    for (const run of orphaned) {
      run.abort()
      this.dropRun(run)
      this.dropPreviewSubscription(run.chunkId, nodeId)
      // Treated like a failed chunk: re-split around whatever frames did land
      // so only missing work re-renders. The node's failure, not the
      // render's (plan 1.17): it is charged an infrastructure retry, so a
      // chunk that loses node after node still gives up eventually, and its
      // render retries are untouched. Never a throw from here: destroyNode
      // calls this before it destroys the instance.
      const outcome = this.requeueOrFail(run.chunkId, run.jobId, {
        c: own('machine', 'node-gone', 'the node went away mid-render'),
        stage: 'node',
        nodeId
      })
      if (outcome === 'pending') requeued += 1
    }
    // Only the chunks that went back in the queue: one that had spent its
    // infrastructure retries failed for good, and says so itself
    // (failureAlert).
    if (requeued > 0) {
      emit('alert', {
        level: 'warn',
        message:
          `${requeued} chunk(s) requeued — node went away mid-render ` +
          `(render retries unchanged)`
      })
    }
    this.kick()
  }

  start(): void {
    // Restart recovery: chunks stranded in transient states (their ChunkRun
    // died with the previous process) go back to pending, unassigned, each
    // re-split around the frames already downloaded, as requeue() does but
    // without charging a retry: a restart is no fault of the chunk's. A chunk
    // whose every frame had landed is complete, and is never sent again.
    //
    // Nothing re-attaches to the old render. Resuming a node still runs
    // provision.sh `base`, which restarts its agent, killing its Blender and
    // clearing its inbox. (Except a node that was unreachable at launch and
    // reconnects later: recoverUnreachable skips onReady, so its old agent
    // and renders keep running.) So a frame that was rendered but not yet
    // downloaded is rendered again, and billed. Only that: the narrowed
    // range leaves out every frame this computer has, and the agent renders
    // with Overwrite off, so on the node that had the chunk before, Blender
    // skips each frame still on its disk (51afb89).
    const db = getDb()
    const stranded = db
      .prepare(
        `SELECT id, job_id FROM chunks WHERE state IN ('assigned', 'rendering', 'encoding', 'downloading')`
      )
      .all() as Array<{ id: string; job_id: string }>
    const touched: string[] = []
    const completed = new Set<string>()
    for (const c of stranded) {
      try {
        const r = this.resplitAroundDownloaded(c.id, { charge: 'none' })
        touched.push(...r.touched)
        if (r.outcome === 'complete') completed.add(c.job_id)
      } catch (e) {
        // A range or step missingRanges refuses (see requeueOrFail). Back to
        // pending as it stands, which is what a restart always did.
        db.prepare(`UPDATE chunks SET state = 'pending', node_id = NULL WHERE id = ?`).run(c.id)
        touched.push(c.id)
        emit('alert', {
          level: 'warn',
          message:
            `chunk ${c.id} could not be narrowed to its missing frames after the restart, ` +
            `so all of it renders again: ${describeError(e)}`
        })
      }
    }
    emitChunksChanged(touched)
    for (const jobId of new Set(stranded.map((c) => c.job_id))) {
      refreshJobState(jobId)
      if (completed.has(jobId)) jobClips.schedule(jobId)
    }
    // Before the hold is judged, so a queue whose only work had already
    // landed is not held for.
    this.settleDownloadedPending()

    this.recoveryHold = this.recoverHold()
    const held = this.recoveryHoldCount()
    if (held != null) {
      emit('alert', {
        level: 'warn',
        message:
          `${held} unfinished chunk(s) from an earlier session — ` +
          `fleet scale-up is paused until you resume`
      })
    }
    this.timer = setInterval(() => void this.tick(), TICK_MS)
  }

  /**
   * The recovery hold for this launch, written to app_state, or null.
   *
   * Unfinished work is real work, and the very next tick would buy a whole
   * fleet for it. That is right when you meant to resume and expensive when
   * you did not: a profile left with a day-old half-finished campaign starts
   * renting up to maxActiveNodes the moment the app opens, before you have
   * seen a single screen. So scale-up is held until the user confirms.
   *
   * Judged from every unfinished chunk of a queued or running job, whatever
   * its state. It used to count only the chunks stranded in flight, which
   * start() itself sets back to pending: quit without resuming, and the next
   * launch found none, held nothing and rented a full fleet (#147). A queue
   * whose fleet was still booting at quit was never held at all (#27).
   *
   * One node is not worth asking about; a fleet is. A hold an earlier launch
   * set and nobody resumed is kept whatever maxActiveNodes says now: the user
   * has not confirmed that work yet.
   */
  private recoverHold(): RecoveryHoldRecord | null {
    const db = getDb()
    const stored = this.storedRecoveryHold()
    const jobIds = this.unfinishedJobIds()
    if (jobIds.length === 0) {
      if (stored) writeAppState(db, 'recovery_hold', null)
      return null
    }
    if (!stored && getSettings().maxActiveNodes <= 1) return null
    const hold: RecoveryHoldRecord = { jobIds, since: stored?.since ?? Date.now() }
    writeAppState(db, 'recovery_hold', JSON.stringify(hold))
    return hold
  }

  /** app_state's recovery hold; a value this build cannot read counts as held, for every job. */
  private storedRecoveryHold(): RecoveryHoldRecord | null {
    const raw = readAppState(getDb(), 'recovery_hold')
    if (raw == null) return null
    try {
      const v = JSON.parse(raw) as Partial<RecoveryHoldRecord>
      if (Array.isArray(v.jobIds) && typeof v.since === 'number') {
        return { jobIds: v.jobIds.filter((id) => typeof id === 'string'), since: v.since }
      }
    } catch {
      // unreadable: held, below
    }
    return { jobIds: [], since: Date.now() }
  }

  /** Jobs still queued or running with a chunk that is neither complete nor failed. */
  private unfinishedJobIds(): string[] {
    return (
      getDb()
        .prepare(
          `SELECT DISTINCT c.job_id FROM chunks c JOIN jobs j ON j.id = c.job_id
            WHERE j.state IN ('queued', 'running') AND c.state NOT IN ('complete', 'failed')`
        )
        .all() as Array<{ job_id: string }>
    ).map((r) => r.job_id)
  }

  /**
   * Unfinished chunks of the held jobs, or null when nothing is held. Only
   * ever blocks BUYING: existing nodes are still dispatched to, idle ones
   * still scale down, and an explicit "add node" still works — so resuming is
   * never the only way out.
   *
   * The hold lets itself go once none of its jobs has work left: the user
   * cancelled them, or the fleet already running finished them. A hold kept
   * after that blocked scale-up for any new job until Resume, with a banner
   * about work that no longer existed (#203).
   */
  recoveryHoldCount(): number | null {
    const hold = this.recoveryHold
    if (!hold) return null
    const db = getDb()
    const marks = hold.jobIds.map(() => '?').join(', ')
    const n =
      hold.jobIds.length === 0
        ? 0
        : (
            db
              .prepare(
                `SELECT COUNT(*) AS n FROM chunks c JOIN jobs j ON j.id = c.job_id
                  WHERE c.job_id IN (${marks}) AND j.state IN ('queued', 'running')
                    AND c.state NOT IN ('complete', 'failed')`
              )
              .get(...hold.jobIds) as { n: number }
          ).n
    if (n > 0) return n
    this.releaseRecoveryHold()
    return null
  }

  resumeRecovery(): void {
    if (this.recoveryHold == null) return
    this.releaseRecoveryHold()
    this.kick()
  }

  /** Drop the hold here and in app_state, so no later launch revives it. */
  private releaseRecoveryHold(): void {
    this.recoveryHold = null
    writeAppState(getDb(), 'recovery_hold', null)
  }

  /**
   * Every hold on scale-up that this scheduler knows of. planScaling rents
   * nothing while any is set, and says which.
   */
  fleetHolds(): FleetHolds {
    const holds: FleetHolds = {}
    const recovery = this.recoveryHoldCount()
    if (recovery != null) holds.recovery = recovery
    // A local disk that will not take frames (plan 1.10): a node rented now
    // would render frames with nowhere to land. tick() dispatches nothing
    // meanwhile either.
    const sink = localSinkHold()
    if (sink) holds.localSink = sink
    return holds
  }

  /** The last scale-up decision and its reason (scale status), or null before the first tick. */
  scaleStatus(): Pick<ScalingPlan, 'status' | 'reason'> | null {
    const p = this.lastScalePlan
    return p ? { status: p.status, reason: p.reason } : null
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
  activeWorkForNode(nodeId: string): Array<{ chunkId: string; jobId: string; gpu: number | null }> {
    const s = this.byNode.get(nodeId)
    if (!s || s.size === 0) return []
    return [...s].map((r) => ({ chunkId: r.chunkId, jobId: r.jobId, gpu: r.gpu }))
  }

  /** GPU a live chunk is pinned to, or null (not live, unpinned, not started). */
  gpuOf(chunkId: string): number | null {
    return this.runs.get(chunkId)?.gpu ?? null
  }

  /**
   * This node's GPU lanes for work of `engine`: how many exclusive chunks it
   * may run at once and whether renders are pinned per GPU. Derived on
   * demand from the node's GPU count, the setting and its hardware ceiling,
   * under the memory guard — cheap, and never stale when the setting or
   * metrics change.
   *
   * By engine: lanes are a Cycles idea, and EEVEE or Octane get one unpinned
   * lane, the whole node (#229, #235). Without an engine, the Cycles plan:
   * the most a node offers anything. The guard is a ceiling planLanes plans
   * under (guardedLanePlan), so a limit below the GPU count is one process
   * across every card, never a few pinned lanes with the other cards idle,
   * as keeping the plan's `pin` while cutting its lanes was (#222).
   */
  lanePlanFor(nodeId: string, engine?: EngineId | null): LanePlan {
    const ctx = this.laneContext(nodeId, engine)
    if (!ctx) return { lanes: 1, pin: false }
    return guardedLanePlan(
      ctx.numGpus,
      ctx.slotsPerGpu,
      ctx.cap,
      this.laneGuards.get(nodeId),
      engine
    )
  }

  /**
   * What planLanes and the lane guard need to know about a node, or null
   * when it is gone. Its lanes per GPU are the setting's, under what this
   * node has shown it can take (laneCeilings).
   */
  private laneContext(nodeId: string, engine?: EngineId | null): LaneGuardContext | null {
    const node = nodeManager.get(nodeId)?.laneInputs
    if (!node) return null
    const settings = getSettings()
    return {
      numGpus: node.numGpus,
      slotsPerGpu: Math.min(
        normaliseSlotsPerGpu(settings.slotsPerGpu),
        this.laneCeilings.get(nodeId) ?? Number.POSITIVE_INFINITY
      ),
      cap: hardCap(node.metrics, Math.max(0, settings.maxNodeSlots ?? 0)),
      engine
    }
  }

  /**
   * A render on this node ran out of GPU memory (#228). When the plan it was
   * sent with put more than one scene on its card (two lanes per GPU, or two
   * lanes sharing a one-GPU node), the node drops a lane per GPU before the
   * chunk is requeued. Sent back into the same plan, it ran out of memory
   * beside the same neighbour, retry after retry, each a paid render.
   *
   * At one scene per card nothing lower frees VRAM (one process across every
   * card loads the scene onto each of them too), so the plan stays and the
   * retry policy decides (admission.ts chargeFor). Shared work is the slot
   * controller's, and is left to it.
   */
  outOfMemoryOn(run: ChunkRun): void {
    if (run.shareNode) return
    const ctx = this.laneContext(run.nodeId, run.engine)
    if (!ctx) return
    const gpus = Math.max(1, Math.floor(ctx.numGpus || 1))
    const perCard =
      gpus === 1 ? run.lanes.lanes : run.lanes.pin ? Math.ceil(run.lanes.lanes / gpus) : 1
    if (perCard <= 1 || ctx.slotsPerGpu <= 1) return
    const lanesPerGpu = ctx.slotsPerGpu - 1
    this.laneCeilings.set(run.nodeId, lanesPerGpu)
    emit('alert', {
      level: 'warn',
      message:
        `${this.nodeName(run.nodeId)}: out of GPU memory with ${perCard} renders on a card, ` +
        `so it now runs ${lanesPerGpu} per card`
    })
    nodeManager.get(run.nodeId)?.emitChanged()
  }

  /**
   * The hardware one render of a run has, as frame times are kept by: the
   * GPU model, and how many of its cards a render gets (a fraction when two
   * lanes share a card), or 'shared' for work the slot controller packs.
   * A frame's time on one card of a four-GPU node is not its time across all
   * four, where #224 sends a job's last chunks, nor on another model: taken
   * from the faster, the slower's first frame was judged against a quarter
   * of what it needs.
   */
  private frameTimeKey(run: ChunkRun): string {
    const snap = nodeManager.get(run.nodeId)?.snapshot
    const gpus = Math.max(1, Math.floor(snap?.numGpus || 1))
    const cards = run.shareNode ? 'shared' : (gpus / Math.max(1, run.lanes.lanes)).toFixed(2)
    return `${snap?.gpuName ?? '?'}|${cards}`
  }

  /** A run of the job saw a frame take `seconds` (ChunkRun.noteProgress). */
  noteFrameTime(run: ChunkRun, seconds: number): void {
    let byKey = this.frameTimes.get(run.jobId)
    if (!byKey) {
      byKey = new Map()
      this.frameTimes.set(run.jobId, byKey)
    }
    const key = this.frameTimeKey(run)
    if (seconds > (byKey.get(key) ?? 0)) byKey.set(key, seconds)
  }

  /** The longest the run's job has been seen to take a frame on its hardware, or null. */
  frameTimeFor(run: ChunkRun): number | null {
    return this.frameTimes.get(run.jobId)?.get(this.frameTimeKey(run)) ?? null
  }

  /**
   * A run found this node's agent not running (see agentDown). Announced
   * once, and written on the node, so the fleet view says why it idles.
   */
  agentDownOn(nodeId: string, reason: string): void {
    if (this.agentDown.has(nodeId)) return
    this.agentDown.set(nodeId, { since: Date.now(), reason })
    nodeManager.get(nodeId)?.update({ last_error: reason })
    emit('alert', {
      level: 'error',
      message:
        `${this.nodeName(nodeId)}: ${reason}. Nothing more is sent to it, and it is ` +
        'destroyed once it has been idle for the idle timeout.'
    })
  }

  /**
   * Why the scheduler sends this node nothing whatever is queued, or null:
   * its agent is down, or a setup step on it is stuck past its deadline
   * (withNodePrep). For the fleet view and the node supervisor (plan 1.7).
   */
  nodeUnfit(nodeId: string): string | null {
    const down = this.agentDown.get(nodeId)
    if (down) return down.reason
    const stuck = stuckPreps.get(nodeId)
    if (stuck) return `setting up the node is stuck: ${stuck.step}`
    return null
  }

  /**
   * The agent was asked to pin a Cycles render to one GPU and could not: it
   * sees fewer than two GPUs (nvidia-smi failed as it started, or found
   * fewer cards than the offer listed), so it runs such renders one at a
   * time, each on every card it can see (#230). Planned as N lanes, the node
   * kept being sent specs that waited in its inbox while the app counted
   * them in flight. From now on it is planned as one lane.
   */
  pinFailedOn(nodeId: string): void {
    if (this.laneCeilings.get(nodeId) === 0) return
    this.laneCeilings.set(nodeId, 0)
    emit('alert', {
      level: 'warn',
      message:
        `${this.nodeName(nodeId)}: its agent cannot pin renders to GPUs (it sees fewer than ` +
        'two), so it runs one render at a time across every card'
    })
    nodeManager.get(nodeId)?.emitChanged()
  }

  /**
   * Exclusive lanes on a node for a chunk of `engine`, given the plans its
   * exclusive runs were sent with (admission.ts exclusiveLanesFor).
   */
  private exclusiveLanes(nodeId: string, engine?: EngineId | null): number {
    const running = [...this.runsOn(nodeId)].filter((r) => !r.shareNode).map((r) => r.lanes)
    return exclusiveLanesFor(this.lanePlanFor(nodeId, engine), running)
  }

  /**
   * The lanes an exclusive chunk is sent to this node with: the node's plan
   * for its engine, unless the free lanes the queue can reach outnumber the
   * exclusive chunks waiting for them, when a chunk that finds its node
   * empty goes out as one unpinned process on every card
   * (gpuLanes.dispatchLanePlan).
   *
   * Pinning used to be decided per node, never per chunk, so whenever a job
   * had fewer chunks left than the fleet had lanes (small jobs, and the end
   * of every job) the last chunks rendered one card each while the other
   * cards idled and billed, where one process used to use them all (#224):
   * on 93cbad4's own figures a lone tail chunk took about three times as
   * long. The unpinned chunk then holds its node (exclusiveLanesFor).
   *
   * `pending` is what is still unassigned this tick, without this chunk.
   * Only chunks that render in pinned lanes count as waiting for lanes: an
   * EEVEE or Octane chunk takes a whole node, never a lane.
   */
  private exclusiveDispatchPlan(
    nodeId: string,
    chunk: PendingChunk,
    pending: PendingChunk[],
    eligible: NodeSnapshot[]
  ): LanePlan {
    const plan = this.lanePlanFor(nodeId, chunk.engine)
    const nodeInFlight = this.runsOn(nodeId).size
    // What dispatchLanePlan decides without the counts below, which cost a
    // look at every node: the common case once a node has lanes running.
    if (!plan.pin || nodeInFlight > 0) return plan
    const pins = new Map<EngineId, boolean>()
    const inLanes = (engine: EngineId): boolean => {
      let p = pins.get(engine)
      if (p === undefined) {
        p = this.lanePlanFor(nodeId, engine).pin
        pins.set(engine, p)
      }
      return p
    }
    const waiting = pending.filter((c) => c.share_node !== 1 && inLanes(c.engine)).length
    return dispatchLanePlan({
      plan,
      nodeInFlight,
      freeLanes: eligible.reduce(
        (a, n) => a + freeExclusiveLanes(this.occupancy(n.id, chunk.engine)),
        0
      ),
      pendingExclusive: waiting + 1
    })
  }

  /**
   * The slot count the UI shows for a node: its GPU lanes while it runs
   * exclusive work (or sits empty), otherwise the shared-work target. A
   * node running an unpinned exclusive chunk (EEVEE, Octane, or a Cycles
   * chunk across every card) is full at one.
   */
  displaySlotTarget(nodeId: string): number {
    const runs = this.runsOn(nodeId)
    const lanes = this.exclusiveLanes(nodeId)
    if ([...runs].some((r) => !r.shareNode)) return lanes
    if (runs.size === 0) return Math.max(this.slotTargetFor(nodeId), lanes)
    return this.slotTargetFor(nodeId)
  }

  /**
   * Pending chunks with frames left to render, oldest job first, carrying
   * their job's sharing flag and blender version. Joining here rather than
   * re-querying per candidate keeps the assignment loop to one query per tick
   * instead of one per (node, candidate) pair.
   *
   * A chunk whose every frame is already downloaded is never offered:
   * settleDownloadedPending completes it first. Nor is one whose job waits on
   * the user (jobs.attention, plan 1.17's breaker): it is neither sent out
   * nor rented for. A chunk waiting out a backoff (not_before) is offered,
   * since it is still work the fleet has to do; tick() holds it back.
   */
  private pendingChunks(): PendingChunk[] {
    const rows = getDb()
      .prepare(
        `SELECT c.*, j.share_node, j.engine, j.blender_version,
                (SELECT COUNT(*) FROM ${UNDOWNLOADED_OF_C}) AS frames_left
           FROM chunks c JOIN jobs j ON j.id = c.job_id
          WHERE c.state = 'pending' AND j.state IN ('queued', 'running')
            AND j.attention IS NULL
          ORDER BY j.submitted_at, c.frame_start`
      )
      .all() as PendingChunk[]
    return rows.filter((c) => c.frames_left > 0)
  }

  /**
   * Complete every pending chunk that has nothing left to render: each frame
   * of its range is already on this computer.
   *
   * Job da68b61b: all 1903 frames had landed, yet a leftover 1-frame requeue
   * sub-chunk still read 'pending'. It was dispatched, sat 'assigned' at 0%
   * GPU, and as unfinished work it made the buy-ahead fleet rent two more
   * 8×4090s (~$8/h) for it. A frame can land after its chunk was requeued (a
   * download already under way, or the re-dispatch of the chunk that used to
   * cover it), and nothing looked again before sending the chunk out.
   */
  private settleDownloadedPending(): void {
    const db = getDb()
    const done = db
      .prepare(
        `SELECT c.id, c.job_id FROM chunks c JOIN jobs j ON j.id = c.job_id
          WHERE c.state = 'pending' AND j.state IN ('queued', 'running')
            AND NOT EXISTS (SELECT 1 FROM ${UNDOWNLOADED_OF_C})`
      )
      .all() as Array<{ id: string; job_id: string }>
    if (done.length === 0) return
    const complete = db.prepare(
      `UPDATE chunks SET state = 'complete' WHERE id = ? AND state = 'pending'`
    )
    db.transaction(() => {
      for (const c of done) complete.run(c.id)
    })()
    emitChunksChanged(done.map((c) => c.id))
    for (const jobId of new Set(done.map((c) => c.job_id))) {
      refreshJobState(jobId)
      jobClips.schedule(jobId)
    }
    emit('alert', {
      level: 'info',
      message:
        `${done.length} queued chunk(s) had every frame downloaded already ` +
        `(${done
          .slice(0, 3)
          .map((c) => c.id)
          .join(', ')}${done.length > 3 ? ', …' : ''}) — marked complete, nothing rendered`
    })
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
      // Under a deadline: dispatch awaits this after the spec is live, and
      // on a wedged connection an exec never returns.
      await ssh.exec(
        on ? `mkdir -p ${posix.dirname(path)} && touch '${path}'` : `rm -f '${path}'`,
        {
          timeoutMs: 30_000,
          label: 'preview flag'
        }
      )
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

  /**
   * What the node is running, as admission reads it, for a chunk of `engine`
   * (its exclusive lanes depend on it; see exclusiveLanes). Without an
   * engine, the most lanes the node offers anything: the pre-filter's view.
   */
  private occupancy(nodeId: string, engine?: EngineId | null): NodeOccupancy {
    const runs = this.runsOn(nodeId)
    return {
      inFlight: runs.size,
      hasExclusive: [...runs].some((r) => !r.shareNode),
      reservedFor: this.reservation?.nodeId === nodeId ? this.reservation.chunkId : null,
      slotTarget: this.slotTargetFor(nodeId),
      exclusiveLanes: this.exclusiveLanes(nodeId, engine)
    }
  }

  private slotStateFor(node: NodeSnapshot, maxNodeSlots: number): SlotState {
    let s = this.slots.get(node.id)
    if (!s) {
      // Floor at the node's GPU lanes: with per-GPU pinning, starting shared
      // work below one slot per GPU would idle whole GPUs while the climb
      // crawls up a settle period at a time.
      const lanes = this.lanePlanFor(node.id)
      s = initialState(node.gpuName, hardCap(node.metrics, maxNodeSlots), Date.now(), {
        numGpus: node.numGpus,
        floor: lanes.pin ? lanes.lanes : 1
      })
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
      // What it CAN do is run out of memory when the node has several GPU
      // lanes, each holding a copy of the scene: that has its own guard.
      if ([...runs].some((r) => !r.shareNode)) {
        this.guardExclusiveLanes(node, runs.size, now)
        continue
      }
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
          recordNodeSlots(node.gpuName, state.bestTarget, state.bestThroughput, node.numGpus)
        }
      }
      if (state.target !== prev.target) nodeManager.get(node.id)?.emitChanged()
    }
  }

  /**
   * One step of the exclusive-lane memory guard (see gpuLanes.guardLanes).
   *
   * With the node's context, so the guard moves only between the plans
   * planLanes makes, reads VRAM per card, waits for each step to take effect
   * and steps back up once memory has room. Without it, the guard stepped
   * down one lane every 90 s while the renders that caused the pressure kept
   * running, and never back up: a 4×4090 node under a heavy scene was down to
   * one lane pinned to card 0 in about three minutes, with three paid cards
   * idle for the rest of its rental, while scale-up rented more nodes to make
   * up for it (#222). The plan is the one the node's exclusive runs render:
   * EEVEE's and Octane's is one lane, which no step can lower.
   */
  private guardExclusiveLanes(node: NodeSnapshot, inFlight: number, now: number): void {
    const prev = this.laneGuards.get(node.id) ?? initialGuard()
    const engines = new Set(
      [...this.runsOn(node.id)].filter((r) => !r.shareNode).map((r) => r.engine)
    )
    const ctx = this.laneContext(node.id, engines.size === 1 ? [...engines][0] : undefined)
    if (!ctx) return
    const { guard, reason } = guardLanes(prev, node.metrics, inFlight, now, ctx)
    if (guard === prev) return
    this.laneGuards.set(node.id, guard)
    if (reason) emit('alert', { level: 'warn', message: `${node.gpuName ?? node.id}: ${reason}` })
    nodeManager.get(node.id)?.emitChanged()
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
    // Something is already free (an empty node, or a free GPU lane on a node
    // running exclusive work) — no need to hold a node back.
    const candidate = { id: head.id, sharesNode: false }
    if (eligible.some((n) => admits(this.occupancy(n.id, head.engine), candidate))) return
    // Drain whichever node is closest to empty.
    let best: { id: string; size: number } | null = null
    for (const n of eligible) {
      const size = this.runsOn(n.id).size
      if (!best || size < best.size) best = { id: n.id, size }
    }
    if (best) this.reservation = { nodeId: best.id, chunkId: head.id }
  }

  async tick(): Promise<void> {
    this.settleDownloadedPending()
    const pending = this.pendingChunks()
    const now = Date.now()
    // Chunks that may go out now: none while the local disk refuses frames
    // (plan 1.10; they would render with nowhere to land), and none still
    // waiting out a transient failure's backoff (plan 1.17).
    const sinkHeld = localSinkHold() != null
    const ready = sinkHeld ? [] : pending.filter((c) => c.not_before == null || c.not_before <= now)

    const eligible = nodeManager
      .list()
      .filter((n) => ['ready', 'idle', 'rendering'].includes(n.state))
      .filter((n) => nodeManager.get(n.id)?.ssh)
      .filter((n) => !this.resting(n.id, now))
      .filter((n) => this.nodeUnfit(n.id) == null)

    this.runSlotController(eligible)
    this.reserveForExclusive(ready, eligible)

    // Assign ROUND-ROBIN across nodes with room ('rendering' nodes included —
    // a node below its slot target can take more). One chunk per node per
    // pass, so early-ready nodes don't swallow the whole queue into their
    // prefetch while later nodes sit idle.
    let assignedInPass = true
    while (ready.length > 0 && assignedInPass) {
      assignedInPass = false
      for (const node of eligible) {
        if (ready.length === 0) break
        const occ = this.occupancy(node.id)
        if (!hasRoom(occ)) continue
        const managed = nodeManager.get(node.id)
        if (!managed?.ssh) continue

        // Among the chunks this node may take, prefer one whose blender
        // version is already installed. Admission comes first: an exclusive
        // chunk needs an empty node, so on a busy node only shared work is
        // eligible however good its version affinity.
        const idx = this.pickChunk(ready, occ, node, eligible)
        if (idx < 0) continue
        const chunk = ready.splice(idx, 1)[0]
        // What scale-up counts as pending is what is left unassigned.
        const at = pending.indexOf(chunk)
        if (at >= 0) pending.splice(at, 1)
        assignedInPass = true
        if (this.reservation?.chunkId === chunk.id) this.reservation = null

        const run = new ChunkRun(
          chunk.id,
          chunk.job_id,
          node.id,
          chunk.share_node === 1,
          managed.ssh,
          chunk.share_node === 1
            ? this.lanePlanFor(node.id, chunk.engine)
            : this.exclusiveDispatchPlan(node.id, chunk, pending, eligible),
          chunk.engine
        )
        this.runs.set(chunk.id, run)
        this.nodeRunsMut(node.id).add(run)
        void run.dispatch().catch((e) => {
          const message = describeError(e)
          const letGo = (): void => {
            this.dropRun(run)
            const n = nodeManager.get(node.id)
            // State only, keeping the node's last error (see dispatch).
            if (n && !this.hasRuns(node.id) && n.state === 'rendering') n.update({ state: 'idle' })
          }
          // A stopped run's failure is not the chunk's, so it is never
          // requeued. forgetNode or cancelJob has already settled the chunk,
          // and forgetNode may have re-dispatched it before this run's prep —
          // minutes of Blender download or scene upload — failed on the closed
          // connection. Requeueing here reset the new owner's row to 'pending'
          // (burning a second retry), and the next tick dispatched the chunk
          // again while the new owner kept rendering it: the same frames, paid
          // for twice.
          //
          // The run is still let go of. An abandoned one already has been, so
          // for it this does nothing (dropRun leaves a successor's entry
          // alone). But finish() stops a run too, before onChunkFinished drops
          // it, and a throw in between (a failed DB write) left it registered
          // for good: live to isLive, work to the eager fleet, and busy to
          // scale-down, so its node never went idle and kept billing.
          if (run.isStopped() || this.runs.get(chunk.id) !== run) {
            if (this.runs.get(chunk.id) === run) {
              emit('alert', {
                level: 'error',
                message: `chunk ${chunk.id} failed as it finished: ${message}`
              })
            } else {
              emit('render:logLine', {
                nodeId: node.id,
                chunkId: chunk.id,
                line: `abandoned dispatch ended: ${message}`,
                ts: Date.now()
              })
            }
            letGo()
            return
          }
          this.requeueOrFail(chunk.id, chunk.job_id, this.dispatchFailure(e, node.id))
          letGo()
        })
      }
    }

    this.scalePolicy(pending, { sendable: sinkHeld ? 0 : pending.length })
  }

  /**
   * Index of the best pending chunk for this node, or -1 if it may take none.
   * Queue order (oldest job first) breaks ties, so an admissible chunk is only
   * passed over for one that saves a Blender install.
   *
   * A chunk goes back to a node it failed on for a machine's or the
   * network's reason only when no other node this tick could take it: the
   * failure may be the node's, and another node settles that.
   */
  private pickChunk(
    pending: PendingChunk[],
    occ: NodeOccupancy,
    node: NodeSnapshot,
    eligible: NodeSnapshot[]
  ): number {
    let fallback = -1
    // The node's lanes depend on the engine asking (exclusiveLanes): an EEVEE
    // chunk sees a node running pinned Cycles lanes as full.
    const occFor = new Map<EngineId, NodeOccupancy>()
    const occupancy = (engine: EngineId): NodeOccupancy => {
      let o = occFor.get(engine)
      if (!o) {
        o = { ...occ, exclusiveLanes: this.exclusiveLanes(node.id, engine) }
        occFor.set(engine, o)
      }
      return o
    }
    for (let i = 0; i < pending.length; i++) {
      const c = pending[i]
      if (!admits(occupancy(c.engine), { id: c.id, sharesNode: c.share_node === 1 })) continue
      const avoid = this.failedOn.get(c.id)?.nodes
      if (avoid?.has(node.id) && this.anotherTakes(c, avoid, eligible)) continue
      if (!c.blender_version || node.blenderVersions.includes(c.blender_version)) return i
      if (fallback < 0) fallback = i
    }
    return fallback
  }

  /**
   * Could a node the chunk has not failed on take it now: one with room that
   * admits it? Any other node at all was the old test, so at the tail a node
   * the chunk failed on sat idle and billing while the chunk waited for a
   * busy one, and one reserved for it stayed reserved and empty.
   */
  private anotherTakes(
    c: PendingChunk,
    avoid: ReadonlySet<string>,
    eligible: NodeSnapshot[]
  ): boolean {
    const cand = { id: c.id, sharesNode: c.share_node === 1 }
    return eligible.some((n) => !avoid.has(n.id) && admits(this.occupancy(n.id, c.engine), cand))
  }

  /** Is this node resting after a failed dispatch? */
  private resting(nodeId: string, now = Date.now()): boolean {
    const rest = this.rests.get(nodeId)
    return rest != null && rest.until > now
  }

  /**
   * The rest a node is on after failed dispatches, for the fleet view and
   * the liveness check (plan 1.7): until when, after how many failures in a
   * row, and the last one's reason. Null = it is sent work as usual.
   */
  nodeRest(nodeId: string): { until: number; failures: number; reason: string } | null {
    const rest = this.rests.get(nodeId)
    if (!rest || rest.until <= Date.now()) return null
    return { until: rest.until, failures: rest.failures, reason: rest.lastError }
  }

  /**
   * A spec reached the node, so dispatching to it works again: the error a
   * failed dispatch wrote on it goes (unless another has been written since),
   * and the fleet view shows what it is doing instead. Its failures in a row
   * are forgotten only once it renders a chunk (rendered()).
   */
  dispatchLanded(nodeId: string): void {
    const rest = this.rests.get(nodeId)
    if (rest?.stage === 'dispatch') this.clearRestError(nodeId, rest.lastError)
  }

  /**
   * What a dispatch that threw means for the retry policy. A failure on a
   * node that is no longer a usable one (unreachable, failed, gone) is the
   * node's whatever the error says: nothing about the job was tried.
   */
  private dispatchFailure(e: unknown, nodeId: string): ChunkFailure {
    if (e instanceof JobCannotRun) {
      return {
        c: own('job', 'job-cannot-run', e.message),
        stage: 'dispatch',
        nodeId,
        fatal: e.kind
      }
    }
    if (e instanceof AddonRegistryUnread) {
      return { c: own('localFs', 'addon-registry', e.message), stage: 'dispatch', nodeId }
    }
    // The node's: a step that hangs there is no more the job's than one
    // that fails. Not node-setup, which the breaker counts across nodes:
    // two slow mirrors are not a Blender version no mirror has.
    if (e instanceof NodePrepTimeout) {
      return { c: own('machine', 'node-prep-timeout', e.message), stage: 'dispatch', nodeId }
    }
    let c = classify(e, { via: 'ssh' })
    const node = nodeManager.get(nodeId)
    const usable = node != null && ['ready', 'idle', 'rendering'].includes(node.state) && !!node.ssh
    if (!usable && c.kind === 'job') {
      c = own('machine', 'node-not-usable', `the node left the fleet mid-dispatch: ${c.reason}`)
    }
    return { c, stage: 'dispatch', nodeId }
  }

  /**
   * Called by a run when its chunk reaches complete/failed: `failure` says
   * why a failed one failed; `rendered` that a complete one rendered (not
   * that it had nothing left to send).
   */
  onChunkFinished(
    run: ChunkRun,
    outcome: { failure?: ChunkFailure; rendered?: boolean } = {}
  ): void {
    this.dropRun(run)
    // A finished chunk can never produce another live frame, so the flag is
    // dead weight on the node from here on.
    this.dropPreviewSubscription(run.chunkId, run.nodeId)
    const chunk = getDb().prepare('SELECT * FROM chunks WHERE id = ?').get(run.chunkId) as ChunkRow
    if (chunk.state === 'failed') {
      this.requeueOrFail(
        run.chunkId,
        run.jobId,
        outcome.failure ?? {
          c: own('job', 'unclassified', 'the attempt failed and gave no reason'),
          stage: 'render',
          nodeId: run.nodeId
        }
      )
    } else if (chunk.state === 'complete') {
      this.failedOn.delete(run.chunkId)
      if (outcome.rendered) this.rendered(run)
    }
    refreshJobState(run.jobId)
    // After refreshJobState, so a job that just finished is built promptly.
    // A failed chunk schedules too: it may have ended the job as 'partial'.
    jobClips.schedule(run.jobId)
    const node = nodeManager.get(run.nodeId)
    // Only fall back to idle when the node has no other in-flight chunks.
    // State only, keeping the node's last error (see dispatch).
    if (node && node.state === 'rendering' && !this.hasRuns(run.nodeId)) {
      node.update({ state: 'idle' })
    }
    this.kick()
  }

  /**
   * A chunk rendered: its job renders, so whatever failed it before was not
   * the job's (the breaker counts afresh), and its node renders, so any rest
   * it was on is over and its failures in a row are forgotten.
   */
  private rendered(run: ChunkRun): void {
    this.breaker.reset(run.jobId)
    const rest = this.rests.get(run.nodeId)
    if (!rest) return
    this.rests.delete(run.nodeId)
    this.clearRestError(run.nodeId, rest.lastError)
  }

  /** Clear the error a rest wrote on a node, unless another has been written since. */
  private clearRestError(nodeId: string, written: string): void {
    const node = nodeManager.get(nodeId)
    if (node && node.snapshot.lastError === written) node.update({ last_error: null })
  }

  /**
   * Rest a node that failed an attempt for its own or its network's reason
   * (plan 1.17): nothing new is sent to it until the rest is over, and its
   * last error says why, so the fleet view shows what is wrong with it.
   *
   * Job 1d59516c: Vast stopped two of three nodes when the balance ran out.
   * The app still read them as idle, and each refused every dispatch in
   * milliseconds, so they took the next chunk, and the next, as fast as
   * the queue came back to them, while the one working node waited for
   * work. The rest doubles with each failure in a row and ends when the
   * node renders a chunk. Failures while it rests (runs dispatched before
   * it began) are one spell and extend nothing. Out of GPU memory is not
   * the node's to rest for: that is how many renders share a GPU (plan
   * 1.11). A node that stopped answering mid-render (stage 'node') rests
   * too; forgetNode's own rest, set first, covers the node going away.
   * Never throws.
   */
  private rest(f: ChunkFailure): void {
    const restable =
      !f.fatal &&
      ((f.stage === 'dispatch' && budgetFor(f.c) === 'infra' && f.c.kind !== 'localFs') ||
        (f.stage === 'render' && f.c.kind === 'machine' && f.c.rule !== 'agent-oom') ||
        (f.stage === 'node' && f.c.kind === 'machine'))
    if (!restable) return
    try {
      const now = Date.now()
      const prev = this.rests.get(f.nodeId)
      if (prev && prev.until > now) return
      const failures = (prev?.failures ?? 0) + 1
      const lastError = `${f.stage} failed: ${f.c.reason}`
      this.rests.set(f.nodeId, {
        until: now + nodeRestMs(failures),
        failures,
        lastError,
        stage: f.stage
      })
      nodeManager.get(f.nodeId)?.update({ last_error: lastError })
    } catch (e) {
      console.warn(`[scheduler] could not rest node ${f.nodeId}: ${describeError(e)}`)
    }
  }

  /**
   * Settle a failed attempt (plan 1.17): what it costs, and whether and when
   * the chunk runs again. For callers that must carry on whatever happens in
   * it. forgetNode runs inside destroyNode BEFORE the instance is destroyed,
   * and the dispatch catch and onChunkFinished have a run to let go of and a
   * node to idle after it. A throw from requeue (missingRanges refuses a
   * range or step it cannot walk) skipped all of that, and an instance kept
   * billing. So a chunk requeue cannot handle is failed, loudly, and the
   * caller goes on.
   *
   * Only the requeue itself can fail the chunk. Announcing it (the chunk
   * events, refreshJobState, the alerts) used to sit in the same try, so a
   * throw there, after the requeue had committed, marked a chunk failed that
   * was already back in the queue: a job gone 'partial' for a failed write
   * of its state.
   *
   * Returns what became of the chunk, or null when nothing was written (a
   * cancelled job's chunk).
   */
  private requeueOrFail(
    chunkId: string,
    jobId: string,
    f: ChunkFailure
  ): Resplit['outcome'] | null {
    this.rest(f)
    let settled: Settled
    try {
      settled = this.requeue(chunkId, f)
    } catch (e) {
      emit('alert', {
        level: 'error',
        message:
          `chunk ${chunkId} could not be requeued, so it is marked failed: ${describeError(e)} ` +
          `(its attempt had failed: ${f.c.reason})`
      })
      try {
        getDb().prepare("UPDATE chunks SET state = 'failed' WHERE id = ?").run(chunkId)
        emitChunkChanged(chunkId)
        refreshJobState(jobId)
      } catch (e2) {
        console.warn(`[scheduler] could not fail chunk ${chunkId}: ${describeError(e2)}`)
      }
      return 'failed'
    }
    this.announceRequeue(jobId, settled)
    return settled.r?.outcome ?? null
  }

  /**
   * Tell the user and the UI about a requeue that has committed: why the
   * attempt failed and what happens next, its chunks, the job's state, and a
   * job clip for a chunk it completed. Never throws: whatever fails here,
   * the requeue stands.
   */
  private announceRequeue(jobId: string, s: Settled): void {
    try {
      for (const alert of s.alerts) emit('alert', alert)
    } catch (e) {
      console.warn(`[scheduler] could not raise the requeue's alert: ${describeError(e)}`)
    }
    const r = s.r
    try {
      // These ids can include rows that did not exist a moment ago, so
      // anything caching a node's chunk list has to re-read.
      if (r) emitChunksChanged(r.touched)
      refreshJobState(jobId)
      if (r?.outcome === 'complete') jobClips.schedule(jobId)
    } catch (e) {
      console.warn(
        `[scheduler] requeued ${r?.touched.join(', ') ?? 'a chunk'} of job ${jobId}, ` +
          `but announcing it failed: ${describeError(e)}`
      )
    }
  }

  /**
   * Requeue a failed chunk: re-split around already-downloaded frames so only
   * missing work re-renders, charging the attempt to the budget its failure
   * belongs to (admission.ts budgetFor), and give up once that budget is
   * spent. A transient failure waits out a backoff (chunks.not_before)
   * first; a failure the agent says no node can get past fails the job at
   * once (failJob); the same failure on two nodes holds the job for the user
   * (the breaker).
   *
   * Writes rows only, and returns what it did and what to tell the user, for
   * announceRequeue. Leaves a cancelled job's chunks alone. Throws on a range
   * or step missingRanges refuses: call it through requeueOrFail.
   */
  private requeue(chunkId: string, f: ChunkFailure): Settled {
    const db = getDb()
    const chunk = db.prepare('SELECT * FROM chunks WHERE id = ?').get(chunkId) as ChunkRow
    const job = db
      .prepare('SELECT name, state, attention FROM jobs WHERE id = ?')
      .get(chunk.job_id) as Pick<JobRow, 'name' | 'state' | 'attention'>
    // A cancelled job's chunks stay as cancelJob left them. Requeueing one put
    // it back to 'pending' — work nobody wants, which then read as unfinished.
    if (job.state === 'cancelled') return { r: null, alerts: [] }
    db.prepare('UPDATE chunks SET error_kind = ? WHERE id = ?').run(f.c.kind, chunkId)
    noteChunkError(chunkId, f.c.reason)
    // The job has already failed (failJob): its chunks still in flight when
    // it did settle here, failed and quietly. The job said why once.
    if (job.state === 'failed') {
      db.prepare("UPDATE chunks SET state = 'failed' WHERE id = ? AND state != 'complete'").run(
        chunkId
      )
      return { r: { outcome: 'failed', touched: [chunkId] }, alerts: [] }
    }
    if (f.fatal) return this.failJob(chunk, job.name, f)

    const alerts: AlertEvent[] = []
    const history = this.failedOn.get(chunkId)
    const repeat = renderOnMachine(f.c, f.stage) && history?.renderRules.has(f.c.rule) === true
    const budget = chargeFor(f.c, f.stage, repeat)
    // A render the machine failed counts only when its chunk failed that way
    // before: one on each of two nodes is as likely their packing as the
    // scene (breakerKey).
    const key = breakerKey(f.c, f.stage, repeat)
    if (key && job.attention == null && this.breaker.record(chunk.job_id, key, f.nodeId)) {
      const hold = this.holdJob(chunk.job_id, job.name, key, f)
      if (hold) alerts.push(hold)
    }
    const infraRetries = chunk.infra_retries + (budget === 'infra' ? 1 : 0)
    const waitMs = chunkBackoffMs(f.c, infraRetries)
    const r = this.resplitAroundDownloaded(chunkId, {
      charge: budget,
      notBefore: waitMs > 0 ? Date.now() + waitMs : null
    })
    // A node that failed it for its own reasons is the last it goes back to;
    // the chunks it was split into inherit that. Only the machine's reasons:
    // a transient failure says nothing about the node, and waits out its
    // backoff instead.
    if (r.outcome !== 'pending') {
      this.failedOn.delete(chunkId)
    } else if (f.c.kind === 'machine' && f.stage !== 'download') {
      const h = history ?? { nodes: new Set<string>(), renderRules: new Set<string>() }
      h.nodes.add(f.nodeId)
      if (f.stage === 'render') h.renderRules.add(f.c.rule)
      for (const id of r.touched) this.failedOn.set(id, h)
    }
    const alert = this.failureAlert(chunk, f, budget, r, waitMs, repeat)
    if (alert) alerts.unshift(alert)
    return { r, alerts }
  }

  /**
   * What the user is told about a failed attempt: the reason, with its code
   * (describeError; job 1d59516c's alerts ended at "failed: "), and what
   * happens next. A chunk requeued after its node went away says nothing of
   * its own: forgetNode's alert covers them all. One that failed for good
   * does, since that alert counts only the chunks it requeued. One whose
   * every frame had already arrived is complete: nothing failed, and a
   * node destroyed at the end of its render warned that it had. A run that
   * gave its chunk back because the node stopped answering has no such
   * alert, and says so here.
   */
  private failureAlert(
    before: ChunkRow,
    f: ChunkFailure,
    budget: RetryBudget,
    r: Resplit,
    waitMs: number,
    repeat: boolean
  ): AlertEvent | null {
    if (f.stage === 'node' && f.c.rule === 'node-gone' && r.outcome !== 'failed') return null
    const what = `${f.stage === 'dispatch' ? 'dispatch' : 'chunk'} ${before.id} failed`
    if (r.outcome === 'complete') {
      return {
        level: 'warn',
        message: `${what}: ${f.c.reason} — every frame had already arrived, so it is complete`
      }
    }
    if (r.outcome === 'failed') {
      const spent =
        budget === 'render'
          ? `its ${MAX_RETRIES} render retries are spent`
          : `it failed ${MAX_INFRA_RETRIES} more times for the machines or the network`
      return { level: 'error', message: `${what} for good, ${spent}: ${f.c.reason}` }
    }
    let next: string
    if (budget === 'render') {
      next =
        `requeued, render retry ${before.retries + 1}/${MAX_RETRIES}` +
        (repeat ? ' (it failed this way before, so it is taken as the render)' : '')
    } else if (budget === 'infra') {
      next =
        `requeued without charging the render (attempt ${before.infra_retries + 1}/` +
        `${MAX_INFRA_RETRIES} for the machines and network` +
        (waitMs > 0 ? `, again in ${Math.round(waitMs / 1000)} s)` : ')')
    } else {
      next = 'requeued, nothing charged'
    }
    return { level: 'warn', message: `${what}: ${f.c.reason} — ${next}` }
  }

  /**
   * Fail a job no node can render as it stands (plan 1.16): the scene failed
   * its preflight or a guard, the engine is missing, an extension it needs is
   * gone. Retrying only pays for the same failure again, on every node: the
   * job fails at once, with the reason as its attention, and no chunk of it
   * is sent again. Chunks still in flight finish on their own; their frames
   * are kept, and a failure among them settles quietly (requeue).
   * refreshJobState keeps a failed job failed.
   */
  private failJob(chunk: ChunkRow, name: string, f: ChunkFailure): Settled {
    const db = getDb()
    const attention: JobAttention = { kind: f.fatal!, message: f.c.reason, since: Date.now() }
    const touched = db.transaction((): string[] => {
      db.prepare("UPDATE jobs SET state = 'failed', attention = ? WHERE id = ?").run(
        JSON.stringify(attention),
        chunk.job_id
      )
      const open = db
        .prepare(
          `SELECT id FROM chunks WHERE job_id = ? AND (state = 'pending' OR id = ?)
             AND state != 'complete'`
        )
        .all(chunk.job_id, chunk.id) as Array<{ id: string }>
      const fail = db.prepare("UPDATE chunks SET state = 'failed' WHERE id = ?")
      for (const c of open) fail.run(c.id)
      return open.map((c) => c.id)
    })()
    for (const id of touched) this.failedOn.delete(id)
    this.breaker.reset(chunk.job_id)
    return {
      r: { outcome: 'failed', touched },
      alerts: [
        {
          level: 'error',
          message:
            `job ${name} failed: no node can render it as it stands, so nothing more of it ` +
            `is sent: ${f.c.reason}`
        }
      ]
    }
  }

  /**
   * The breaker (plan 1.17): the same failure on two nodes is taken as the
   * job's, not the machines'. Its chunks are held (jobs.attention; see
   * pendingChunks), with one alert, until the user resumes it (resumeJob).
   * Chunks in flight finish, or fail and wait with the rest.
   */
  private holdJob(jobId: string, name: string, key: string, f: ChunkFailure): AlertEvent | null {
    const nodes = this.breaker.nodesFor(jobId, key)
    const where =
      key === 'localFs'
        ? 'twice, on this computer'
        : `on ${nodes.length} nodes (${nodes.map((id) => this.nodeName(id)).join(', ')})`
    const attention: JobAttention = {
      kind: 'repeatedFailure',
      message: `the same failure ${where}: ${f.c.reason}`,
      since: Date.now(),
      errorClass: f.c.kind
    }
    const r = getDb()
      .prepare('UPDATE jobs SET attention = ? WHERE id = ? AND attention IS NULL')
      .run(JSON.stringify(attention), jobId)
    if (r.changes === 0) return null
    // Names the one way out this build has. resumeJob has no IPC channel or
    // button yet ('job:resume', for the integration wave), and the text
    // should say "resume it" once it does.
    return {
      level: 'error',
      message:
        `job ${name} is held: ${attention.message}. Nothing more of it is sent, and nodes ` +
        'left idle are let go. This version cannot resume a held job yet: once the cause ' +
        'is fixed, cancel the job and submit it again.'
    }
  }

  /** A node as the user knows it: its GPU, and which one. */
  private nodeName(nodeId: string): string {
    const gpu = nodeManager.get(nodeId)?.snapshot.gpuName
    return gpu ? `${gpu} ${nodeId.slice(0, 8)}` : nodeId.slice(0, 8)
  }

  /**
   * Release a job the breaker held (jobs.attention) once the user has looked
   * at it: its failures are counted afresh and its chunks go out again. A
   * job that failed outright (failJob) stays failed: its scene has to be
   * fixed, and the job revived or submitted again. True if a hold was
   * released.
   */
  resumeJob(jobId: string): boolean {
    const r = getDb()
      .prepare(
        `UPDATE jobs SET attention = NULL
          WHERE id = ? AND state IN ('queued', 'running') AND attention IS NOT NULL`
      )
      .run(jobId)
    if (r.changes === 0) return false
    this.breaker.reset(jobId)
    emitJobChanged(jobId)
    this.kick()
    return true
  }

  /**
   * Put a chunk back in the queue, narrowed to the frames of its range not
   * yet downloaded: the chunk keeps its id for the first missing run of
   * frames, and each further run becomes a new `-rN` chunk. A chunk with no
   * frame missing is complete instead, whatever its retries: nothing is
   * left to render, so it must neither be sent again nor fail the job.
   *
   * `charge` is the budget the failed attempt costs (plan 1.17): 'render'
   * adds to retries and 'infra' to infra_retries, and a chunk with none of
   * that budget left is failed. 'none' charges nothing: restart recovery
   * (start()), where the chunk did not fail, the process that was driving it
   * went away. The new chunks inherit both counts, the backoff and the
   * error's class.
   *
   * Downloaded frames are read by job and range, as UNDOWNLOADED_OF_C says
   * why. Writes rows only, in one transaction; the caller announces the
   * result (announceRequeue). Throws on a range or step missingRanges refuses.
   */
  private resplitAroundDownloaded(
    chunkId: string,
    opts: { charge: RetryBudget; notBefore?: number | null }
  ): Resplit {
    const db = getDb()
    const chunk = db.prepare('SELECT * FROM chunks WHERE id = ?').get(chunkId) as ChunkRow
    const job = db.prepare('SELECT frame_step FROM jobs WHERE id = ?').get(chunk.job_id) as Pick<
      JobRow,
      'frame_step'
    >
    const downloaded = new Set(
      (
        db
          .prepare(
            `SELECT frame FROM frames
              WHERE job_id = ? AND frame BETWEEN ? AND ? AND state = 'downloaded'`
          )
          .all(chunk.job_id, chunk.frame_start, chunk.frame_end) as Array<{ frame: number }>
      ).map((r) => r.frame)
    )
    const ranges = missingRanges(
      { start: chunk.frame_start, end: chunk.frame_end },
      job.frame_step,
      downloaded
    )
    if (ranges.length === 0) {
      db.prepare("UPDATE chunks SET state = 'complete' WHERE id = ?").run(chunkId)
      return { outcome: 'complete', touched: [chunkId] }
    }
    const spent =
      (opts.charge === 'render' && chunk.retries >= MAX_RETRIES) ||
      (opts.charge === 'infra' && chunk.infra_retries >= MAX_INFRA_RETRIES)
    if (spent) {
      db.prepare("UPDATE chunks SET state = 'failed' WHERE id = ?").run(chunkId)
      return { outcome: 'failed', touched: [chunkId] }
    }
    const retries = chunk.retries + (opts.charge === 'render' ? 1 : 0)
    const infraRetries = chunk.infra_retries + (opts.charge === 'infra' ? 1 : 0)
    const notBefore = opts.notBefore ?? null
    const touched: string[] = [chunkId]
    db.transaction(() => {
      // Narrow the original chunk to the first missing range, add new chunks
      // for the rest, and re-point frame rows.
      const first = ranges[0]
      db.prepare(
        `UPDATE chunks SET state='pending', node_id=NULL, frames_done=?, retries=?, infra_retries=?,
                not_before=?, frame_start=?, frame_end=?, assigned_at=NULL WHERE id = ?`
      ).run(0, retries, infraRetries, notBefore, first.start, first.end, chunkId)
      for (const range of ranges.slice(1)) {
        const newId = `${chunk.job_id.slice(0, 8)}-${range.start}-${range.end}-r${retries}`
        db.prepare(
          `INSERT INTO chunks (id, job_id, frame_start, frame_end, state, frames_done, retries,
                              infra_retries, not_before, error_kind)
           VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)`
        ).run(
          newId,
          chunk.job_id,
          range.start,
          range.end,
          retries,
          infraRetries,
          notBefore,
          chunk.error_kind
        )
        db.prepare(
          `UPDATE frames SET chunk_id = ? WHERE job_id = ? AND frame BETWEEN ? AND ? AND state != 'downloaded'`
        ).run(newId, chunk.job_id, range.start, range.end)
        touched.push(newId)
      }
    })()
    return { outcome: 'pending', touched }
  }

  /**
   * Frames not yet downloaded in each of these chunks' current ranges, by
   * chunk id: what is left of the work, as planScaling counts it.
   */
  private framesLeftOf(chunkIds: string[]): Map<string, number> {
    const out = new Map<string, number>()
    if (chunkIds.length === 0) return out
    const rows = getDb()
      .prepare(
        `SELECT c.id, (SELECT COUNT(*) FROM ${UNDOWNLOADED_OF_C}) AS n
           FROM chunks c WHERE c.id IN (${chunkIds.map(() => '?').join(', ')})`
      )
      .all(...chunkIds) as Array<{ id: string; n: number }>
    for (const r of rows) out.set(r.id, r.n)
    return out
  }

  /**
   * Scale up when there's queued work; scale down long-idle nodes.
   *
   * `sendable` is how many of the pending chunks an idle node could be sent
   * without waiting on the user or this computer: none while the local disk
   * refuses frames. A chunk waiting out a backoff counts, since its wait is
   * short and bounded.
   */
  private scalePolicy(pending: PendingChunk[], opts: { sendable: number }): void {
    const settings = getSettings()
    const pendingCount = pending.length
    const nodes = nodeManager.list()
    const usable = nodes.filter(isDispatchable)
    // What the fleet can render with: not a node this scheduler sends nothing
    // (nodeUnfit), whose lanes counted as free let the queue look covered
    // while it waited for a node whose agent is down.
    const working = usable.filter((n) => this.nodeUnfit(n.id) == null)

    // Shared and exclusive work draw on different supplies, so they need
    // separate demand tests. Shared chunks consume free SLOTS; an exclusive
    // chunk consumes a whole EMPTY NODE however many slots it has. Counting
    // them together would let a fleet packed with shared work look like it
    // had room for exclusive chunks that can never be placed on it.
    const pendingShared = pending.filter((c) => c.share_node === 1).length
    const pendingExclusive = pendingCount - pendingShared
    const sharedCapacity = working
      // A node locked by an exclusive chunk, or being drained for one, will
      // not take shared work however many slots it nominally has.
      .filter((n) => !this.occupancy(n.id).hasExclusive && this.reservation?.nodeId !== n.id)
      .reduce(
        (a, n) => a + Math.max(0, this.slotTargetFor(n.id) - (this.byNode.get(n.id)?.size ?? 0)),
        0
      )
    // Lanes are counted for the engine the pending exclusive work renders
    // with: one per node for EEVEE and Octane (#229, #235), which a 4-GPU node
    // offered as four. Any Cycles among it sizes by Cycles' lanes, which errs
    // toward capacity the fleet may not have, so toward renting less.
    const exclusiveEngines = new Set(pending.filter((c) => c.share_node !== 1).map((c) => c.engine))
    const laneEngine =
      exclusiveEngines.size > 0 && !exclusiveEngines.has('cycles')
        ? [...exclusiveEngines][0]
        : undefined
    // Free GPU lanes, not empty nodes: a 4-GPU node running one exclusive
    // chunk still has room for three more.
    const exclusiveCapacity = working.reduce(
      (a, n) => a + freeExclusiveLanes(this.occupancy(n.id, laneEngine)),
      0
    )

    // Capacity already on its way: nodes rented but still booting. Ignoring
    // them made every tick of a boot re-justify another rental for the same
    // pending chunks.
    const slotsPerGpu = normaliseSlotsPerGpu(settings.slotsPerGpu)
    const booting = nodes.filter(isBooting).map((n) => {
      const lanes = planLanes(
        n.numGpus,
        slotsPerGpu,
        hardCap(null, settings.maxNodeSlots ?? 0),
        laneEngine
      )
      return { lanes: lanes.lanes, sharedSlots: Math.max(2, lanes.lanes) }
    })
    // What a node rented now is expected to bring. The GPU-count floor is the
    // only thing known before an offer is picked.
    const newNode = planLanes(
      Math.max(1, settings.offerFilters.minNumGpus ?? 1),
      slotsPerGpu,
      hardCap(null, settings.maxNodeSlots ?? 0),
      laneEngine
    )

    // The work left, in frames not yet downloaded: pending chunks, and the
    // chunks in flight. Counting chunks let a 1-frame leftover whose frame
    // had already landed keep the buy-ahead fleet renting (job da68b61b).
    const runs = [...this.runs.values()]
    const runFrames = this.framesLeftOf(runs.map((r) => r.chunkId))
    let remainingExclusiveFrames = 0
    let remainingSharedFrames = 0
    for (const c of pending) {
      if (c.share_node === 1) remainingSharedFrames += c.frames_left
      else remainingExclusiveFrames += c.frames_left
    }
    for (const r of runs) {
      const n = runFrames.get(r.chunkId) ?? 0
      if (r.shareNode) remainingSharedFrames += n
      else remainingExclusiveFrames += n
    }
    // The rate the fleet is measured rendering these jobs at: the runs on
    // usable nodes, from their progress polls.
    const usableIds = new Set(working.map((n) => n.id))
    const running = runs.filter((r) => usableIds.has(r.nodeId))
    const rates = running.map((r) => r.rate()).filter((v): v is number => v != null)

    const plan = planScaling({
      // Every node that may still bill takes room and money (nodeState).
      cap: capacityBudget(nodes, settings),
      // Startup recovery not yet confirmed — see start(). Scale-DOWN below is
      // deliberately still live, so a held fleet cannot also be a stuck one.
      holds: this.fleetHolds(),
      now: Date.now(),
      pendingShared,
      pendingExclusive,
      sharedCapacity,
      exclusiveCapacity,
      booting,
      newNodeLanes: newNode.lanes,
      newNodeSharedSlots: Math.max(2, newNode.lanes),
      usableNodes: working.length,
      usableLanes: working.reduce((a, n) => a + this.lanePlanFor(n.id, laneEngine).lanes, 0),
      usableSharedSlots: working.reduce((a, n) => a + this.slotTargetFor(n.id), 0),
      pendingFrames: pending.reduce((a, c) => a + c.frames_left, 0),
      remainingExclusiveFrames,
      remainingSharedFrames,
      fleetFramesPerHour: rates.length > 0 ? rates.reduce((a, v) => a + v, 0) * 3600 : null,
      ratedRuns: rates.length,
      runningRuns: running.length,
      // Buy-ahead (eagerFleet): rent while frames outnumber the fleet's lanes
      // and slots. Demand-driven scaling alone can never widen a fleet whose
      // nodes prefetch the entire queue (pending pins at 0), which strands a
      // long CPU-bound drain on however many nodes happened to boot first.
      eager: settings.eagerFleet === true
    })
    this.lastScalePlan = plan
    // Several rentals per tick (see scaling.ts), still one batch at a time.
    // By count for now: requestNodes still re-checks the caps itself, and
    // does not yet take the plan's budget (plan 1.5).
    if (plan.status === 'rent' && plan.nodes > 0 && !this.requestingNode) {
      this.requestingNode = true
      void nodeManager
        .requestNodes(plan.nodes)
        .then((ids) => {
          if (ids.length > 1) {
            emit('alert', { level: 'info', message: `scale-up: rented ${ids.length} nodes` })
          }
        })
        .catch((e) =>
          emit('alert', { level: 'warn', message: `scale-up failed: ${describeError(e)}` })
        )
        .finally(() => {
          this.requestingNode = false
        })
    }

    // Scale down: idle with nothing it could be sent for idleTimeout. Not
    // `pendingCount`: during a local-disk hold tick() sends nothing, and the
    // pending chunks kept every idle node alive, billing, for as long as the
    // disk stayed full. frameDownloader's SINK_HOLD_MS is the bound on that.
    // Nor for a node this scheduler sends nothing whatever is queued (its
    // agent is down: nodeUnfit), which the queue otherwise kept billing.
    for (const n of usable) {
      if (opts.sendable > 0 && this.nodeUnfit(n.id) == null) {
        this.idleSince.delete(n.id)
        continue
      }
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
  }

  private idleSince = new Map<string, number>()

  /**
   * Cancel a job: mark its rows, stop its runs, then kill its chunks on their
   * nodes.
   *
   * Everything up to the node cleanup is synchronous, and the rows are written
   * in one transaction. The old loop awaited a pkill per chunk and judged each
   * chunk by a snapshot read before the first of them. A run later in the list
   * could finish during those awaits and have its 'complete' overwritten with
   * 'failed'. A crash mid-loop left a cancelled job with live-looking chunks
   * for the next start() to "recover".
   */
  async cancelJob(jobId: string): Promise<void> {
    const db = getDb()
    const settled = db.transaction((): string[] => {
      db.prepare("UPDATE jobs SET state = 'cancelled' WHERE id = ?").run(jobId)
      const open = db
        .prepare("SELECT id FROM chunks WHERE job_id = ? AND state NOT IN ('complete', 'failed')")
        .all(jobId) as Array<{ id: string }>
      db.prepare(
        "UPDATE chunks SET state = 'failed' WHERE job_id = ? AND state NOT IN ('complete', 'failed')"
      ).run(jobId)
      return open.map((c) => c.id)
    })()
    const runs = [...this.runs.values()].filter((r) => r.jobId === jobId)
    for (const run of runs) {
      run.abort()
      this.dropRun(run)
    }
    for (const id of settled) this.failedOn.delete(id)
    this.breaker.reset(jobId)
    this.frameTimes.delete(jobId)
    emitChunksChanged(settled)
    emitJobCancelled(jobId)

    for (const run of runs) {
      const node = nodeManager.get(run.nodeId)
      if (node?.ssh) {
        // Remove queued spec + kill any in-flight blender for this chunk.
        // Under a deadline, as retractSpec: a wedged node held the rest of
        // the cancel, and every node after it, for good.
        await node.ssh
          .exec(
            `rm -f ${REMOTE_ROOT}/jobs/inbox/${run.chunkId}.json; pkill -f '${run.chunkId}' || true`,
            { timeoutMs: 30_000, label: 'cancel chunk' }
          )
          .catch(() => {})
      }
      if (node && node.state === 'rendering' && !this.hasRuns(run.nodeId)) {
        node.update({ state: 'idle' })
      }
    }
  }
}

function emitJobCancelled(jobId: string): void {
  refreshJobState(jobId)
}

export const scheduler = new Scheduler()
