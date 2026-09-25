/**
 * Domain types shared between main and renderer. This file (with ipc.ts) is
 * the single source of truth for everything that crosses the IPC boundary.
 */

export type EngineId = 'eevee' | 'cycles' | 'octane'

export type ProxyCodec = 'hevc' | 'av1'

// ---------------------------------------------------------------------------
// Vast.ai offers
// ---------------------------------------------------------------------------

export interface OfferFilters {
  /** Allowlist of GPU names (vast `gpu_name`, e.g. "RTX 4090"); empty = any. */
  gpuNames: string[]
  /** Max price in $/hr (dph_total); null = no cap. */
  maxDphTotal: number | null
  minGpuRamGb: number
  minInetDownMbps: number
  /** vast `reliability2`, 0..1 */
  minReliability: number
  minDiskGb: number
  /**
   * CPU-bound workload mode (optional; default off = GPU-benchmark ranking,
   * unchanged behaviour). When true, offers with no measured throughput are
   * ranked by a CPU proxy (clock × effective-cores per dollar) instead of
   * vast's DL benchmark, so premium datacenter GPUs stop winning offers for
   * renders whose frame cost is mostly CPU.
   */
  cpuBound?: boolean
  /**
   * Minimum effective CPU cores per offer (optional; null/absent = no floor).
   * CPU-bound fleets drown on cheap 8-16-thread boxes — total throughput is
   * ~cores × clock, so a floor forces the fleet onto machines with real CPUs.
   */
  minCpuCores?: number | null
  /**
   * Minimum GPUs per offer (optional; null/absent = any). Multi-GPU nodes run
   * one render per GPU (see SettingsPublic.slotsPerGpu), so a 4-GPU box is
   * four render lanes on one rental: fewer machines to boot and babysit for
   * the same throughput. Offer ranking is per GPU, so this is a preference
   * the user expresses, not something ranking forces.
   */
  minNumGpus?: number | null
}

export interface Offer {
  id: number
  machineId: number
  gpuName: string
  numGpus: number
  gpuRamGb: number
  dphTotal: number
  /** vast `dlperf_per_dphtotal` — perf per dollar, used for ranking. */
  dlperfPerDph: number | null
  inetDownMbps: number
  inetUpMbps: number
  reliability: number
  cudaMaxGood: number | null
  geolocation: string | null
  diskSpaceGb: number
  cpuName: string | null
  cpuCoresEffective: number | null
  cpuGhz: number | null
}

// ---------------------------------------------------------------------------
// Nodes / fleet
// ---------------------------------------------------------------------------

export type NodeState =
  | 'requested'
  | 'provisioning'
  | 'ready'
  | 'rendering'
  | 'encoding'
  | 'idle'
  | 'unreachable'
  | 'draining'
  | 'failed'
  | 'destroying'
  | 'destroyed'

export interface NodeMetrics {
  /** avg GPU utilisation % across GPUs */
  gpuUtil: number
  vramUsedGb: number
  vramTotalGb: number
  /** max GPU temperature °C */
  gpuTemp: number
  /** GPU package power draw, summed across GPUs (W); 0 = not reported */
  powerW: number
  /** summed GPU power limit (W); 0 = not reported */
  powerLimitW: number
  /** busy CPU % from /proc/stat deltas (not load average) */
  cpuUtil: number
  /** 1-min load average — queue depth, kept alongside cpuUtil */
  cpuLoad1: number
  cpuCores: number
  /** system RAM; 0 total = not sampled */
  ramUsedGb: number
  ramTotalGb: number
  /** epoch ms of the sample */
  updatedAt: number
  /** per-GPU breakdown; absent on samples from before it was recorded */
  gpus?: GpuSample[]
}

/** One GPU's share of a node's usage sample (nvidia-smi index order). */
export interface GpuSample {
  index: number
  util: number
  vramUsedGb: number
  vramTotalGb: number
  temp: number
  /** 0 = not reported */
  powerW: number
}

/**
 * Octane on a node (plan 1.18), as the `nodes.octane_state` column keeps it:
 *   none           not set up: no Octane job has run here
 *   serverRunning  OctaneServer is up, its licence not yet confirmed
 *   licensed       the server holds a licence, so Octane chunks may dispatch
 *   needsLogin     the server is up and waiting for a sign-in, which the user
 *                  makes by hand over VNC (node:openVncTunnel)
 * The column stores these exact strings, camelCase like every other stored
 * enum (ClipKind in `assets.kind`).
 */
export type OctaneState = 'none' | 'serverRunning' | 'licensed' | 'needsLogin'

/** One chunk the scheduler currently has in flight on a node. */
export interface NodeWorkRef {
  chunkId: string
  jobId: string
  /**
   * The GPU this chunk's Blender is pinned to (nvidia-smi index), or null when
   * it is not pinned — a single-GPU node, per-GPU slots off, or not started yet.
   */
  gpu?: number | null
  /** the job's name, for the Fleet screen's rows (scheduler.activeWorkForNode fills it) */
  jobName?: string
  /** media:// URL of the job's latest frame preview; null = none yet */
  thumbUrl?: string | null
}

export interface NodeSnapshot {
  id: string
  instanceId: number | null
  state: NodeState
  gpuName: string | null
  numGpus: number
  dphTotal: number | null
  sshHost: string | null
  sshPort: number | null
  /** epoch ms when the instance started billing */
  startedAt: number | null
  /** accumulated $ cost for this node's lifetime */
  accumulatedCost: number
  /**
   * GPU energy used since the app started watching this node (Wh), integrated
   * from power samples. In-memory only — resets when the app restarts.
   */
  energyWh: number
  /** Estimated CO2e for `energyWh` at this node's grid (grams). */
  co2g: number
  /**
   * Raw vast.ai location for the machine ("Poland, PL" / "US"), or null for
   * nodes rented before it was recorded — those fall back to the world-average
   * grid intensity.
   */
  geolocation: string | null
  /**
   * Chunks in flight on this node right now, newest last. Carries jobId so the
   * UI can name the work without parsing the chunk id — that parse was the old
   * `currentChunkId` display string's undoing: it was several ids joined with
   * ", " on a multi-slot node, and retry chunks carry a `-rN` suffix, so both
   * cases resolved to no job at all.
   */
  currentWork: NodeWorkRef[]
  /** chunks in flight on this node right now */
  slotsInUse: number
  /** the auto-judged concurrent-render target for this node (see slotController) */
  slotTarget: number
  /** null = probe not yet run */
  eeveeCapable: boolean | null
  octaneReady: boolean
  octaneNeedsManualLogin: boolean
  /**
   * Octane on this node (plan 1.18). Replaces octaneReady and
   * octaneNeedsManualLogin, which it makes redundant: 'licensed' and
   * 'needsLogin'. Absent = 'none'.
   */
  octaneState?: OctaneState
  /** Blender versions installed on the node, e.g. ["4.5.3"] */
  blenderVersions: string[]
  lastError: string | null
  /** live usage sample; null until the first metrics poll */
  metrics: NodeMetrics | null
  /**
   * Epoch ms when a destroy of this node's instance was confirmed: Vast
   * answered the DELETE with 404, or showInstance no longer finds the
   * instance. Plan 1.2's ensureInstanceGone is the only writer. While it is
   * null the instance may still be billing, whatever `state` says. A
   * 'destroyed' row without it has not been confirmed: a DELETE can answer
   * 200 and leave the instance running (#140).
   *
   * Optional only so that snapshots built before the column existed still
   * typecheck. nodeState.ts reads a missing value as null, which means "not
   * confirmed".
   */
  destroyedAt?: number | null
  /**
   * Epoch ms since a create for this row has been out with no known result.
   * It is set when `PUT /asks` is sent. It is cleared when Vast answers with
   * the instance id (`instanceId`) or refuses, or when plan 1.4's label
   * lookup finds the instance or confirms it does not exist. While it is set,
   * an instance may be billing under this node's label and nobody knows its
   * id: the reply was lost, a 5xx or timeout came after Vast had acted, or
   * the app crashed mid-create.
   */
  createUnknownSince?: number | null
  /**
   * The instance's label on Vast, so the user can find it in the Vast.ai
   * console (plan 1.3: `vastai-blender <install8>:<node8>`, or
   * `vastai-blender <node8>` for rentals made before install ids).
   */
  label?: string | null
  /**
   * Epoch ms of the last command that reached the node: a metrics poll, an
   * exec or a transfer. null = none yet this session. Plan 1.7's liveness
   * supervisor keeps it, and it shows how long an 'unreachable' node has
   * been silent.
   */
  lastContactAt?: number | null
}

/**
 * A local VNC endpoint tunnelled to a node's desktop, for signing in to
 * Octane by hand (plan 1.18). The result of node:openVncTunnel.
 */
export interface VncTunnelInfo {
  /** Port on 127.0.0.1. Point a VNC viewer at `vnc://127.0.0.1:<localPort>`. */
  localPort: number
  /**
   * The VNC password generated for the node. It is '' when this session did
   * not start the node's VNC server, because main keeps the password in
   * memory only and a restart loses it.
   */
  password: string
}

/**
 * Who an unclaimed instance belongs to, going by its label:
 *   thisProfile      the label names a node of this profile, but no live node
 *                    holds the instance. It is an orphan, which the reconcile
 *                    destroys by itself; it stays listed until that works.
 *   otherVastRender  a Vast Render label this profile did not write: another
 *                    install, or another profile of this one, rented it. It
 *                    is left running unless the user destroys it, because it
 *                    may be that app's live render.
 *   unlabelled       no Vast Render label: rented by hand or by another tool.
 *                    It is never destroyed automatically.
 */
export type UnclaimedOwner = 'thisProfile' | 'otherVastRender' | 'unlabelled'

/**
 * An instance on the Vast account that no node of this profile holds, found
 * by the reconcile (plan 1.3). It bills like any other instance, so Fleet
 * lists it with its rate until it is gone. fleet:unclaimed lists them and
 * fleet:destroyUnclaimed destroys one.
 */
export interface UnclaimedInstance {
  instanceId: number
  /** its Vast label, verbatim; null = none */
  label: string | null
  owner: UnclaimedOwner
  gpuName: string | null
  numGpus: number
  /** $/hr Vast reports for it; null = not reported */
  dphTotal: number | null
  /** Vast's `actual_status` ('running', 'loading', 'exited', …); null = not reported */
  status: string | null
  /** epoch ms Vast started it; null = not reported */
  startedAt: number | null
  /** epoch ms the reconcile first found it unclaimed */
  firstSeenAt: number
  /** why the last destroy of it failed; null = none tried, or none failed */
  destroyError: string | null
}

/**
 * A reason the fleet has stopped renting, each released on its own. Every
 * hold stops scale-up, and none of them stops scale-down, so a held fleet is
 * never also a stuck one. fleet:holds reads them and fleet:releaseHold
 * releases one.
 */
export interface FleetHolds {
  /**
   * The Vast account cannot pay (plan 1.20), or Vast refused the account with
   * 401, 402 or 403 (plan 1.17). This happens when the balance runs under
   * about 10 minutes of runway, or on any `insufficient_credit` answer. No
   * machine is blacklisted for it. The hold releases itself when the balance
   * recovers.
   */
  account?: {
    reason: string
    /** balance when the hold was set; null = not known */
    balance: number | null
    since: number
  }
  /**
   * Chunks a previous session left unfinished. The fleet does not scale up
   * for them until the user says so. This is the recovery hold that
   * scheduler:recoveryHold also reports (persisted by plan 1.9).
   */
  recovery?: number
  /**
   * This computer cannot take the frames: the disk is full, or the output
   * folder refuses writes (plans 1.10 and 1.21). Dispatch pauses as well as
   * renting, because a frame rendered now could not be kept.
   */
  localSink?: { reason: string; since: number }
  /**
   * Scale-up is backing off after rentals kept failing (plan 1.17). `retryAt`
   * is when it tries again; null = when the user releases it.
   */
  scale?: { reason: string; since: number; retryAt: number | null }
  /**
   * A sign-in to Octane by hand that nobody made (plan 1.18). Only Octane
   * rentals wait on it: no node is rented for Octane work until a node is
   * signed in, the user opens a VNC login, or releases this.
   */
  octaneSignIn?: { reason: string; since: number; nodeId: string }
}

export type FleetHoldKind = keyof FleetHolds

/**
 * What the fleet may still rent, under maxActiveNodes and the spend cap, and
 * what work a scale-up batch still has to cover (plan 1.5, #227 #237). Each
 * rental in a batch spends it down: one node, its offer's $/hr, and the
 * lanes and shared slots that offer brings. The batch stops when any part
 * runs out. nodeState.capacityBudget() fills in the cap parts from the nodes
 * and settings.
 */
export interface CapacityBudget {
  /**
   * Nodes counted against maxActiveNodes: booting, working, and any that may
   * still be billing (nodeState.countsTowardCaps).
   */
  nodes: number
  maxNodes: number
  /** how many more nodes maxActiveNodes allows; 0 when at or over it */
  nodeRoom: number
  /** $/hr of the counted nodes */
  perHour: number
  /**
   * The cap in force ($/hr). null only when noSpendCap is on. A cap that is
   * missing or not a number, without that flag, is 0: nothing is rented.
   */
  spendCap: number | null
  /** $/hr one more rental may add and stay within the cap; null = no cap; 0 when at or over it */
  headroomPerHour: number | null
  /**
   * Exclusive GPU lanes the batch still has to cover. null means the batch
   * is not limited by demand: a manual request, or eagerFleet.
   */
  exclusiveLanes?: number | null
  /** Shared slots the batch still has to cover; null = not limited by demand. */
  sharedSlots?: number | null
}

/** How far a manual node request (fleet:requestNode) may go. */
export interface RequestNodeOptions {
  /**
   * The user confirmed a rental that takes the fleet past the spend cap.
   * Without it a manual request stops at the cap, as scale-up does (plan
   * 1.5).
   */
  overSpendCap?: boolean
  /**
   * No rental above this $/hr, whatever the cap leaves: the bound an
   * over-cap confirmation names ("past the cap, at most $X/hr"). Without it
   * an overSpendCap request is bounded by the offer filter alone.
   */
  maxPerHour?: number | null
}

/** Why scale-up is renting or not, as the scheduler last decided (scheduler:scaleStatus). */
export interface ScaleStatusInfo {
  status: 'rent' | 'held' | 'covered' | 'tail' | 'max-nodes' | 'spend-cap'
  /** one line, for the Fleet screen */
  reason: string
}

/** What node:reprovision did (plan 1.15). */
export interface ReprovisionResult {
  /**
   * Chunks that were in flight on the node when its agent was restarted.
   * They go back to the queue without using up a retry.
   */
  requeued: number
}

/** Everything the UI needs to open (or hand the user) a shell on a node. */
export interface SshCommandInfo {
  host: string
  port: number
  user: string
  keyPath: string
  /** Ready-to-paste `ssh -i … -p … root@host`. */
  command: string
}

export interface FleetCost {
  perHour: number
  sessionTotal: number
  /** GPU energy across every node this session (Wh) */
  sessionWh: number
  /**
   * Estimated CO2e for `sessionWh` (grams), each node weighted by its own
   * country's grid. See main/carbon/intensity.ts for what this does and does
   * not account for.
   */
  sessionCo2g: number
  /** vast account credit balance, null until first fetched */
  balance: number | null
}

// ---------------------------------------------------------------------------
// GPU usage over time (Feature G)
// ---------------------------------------------------------------------------

/**
 * GPU utilisation (%) a GPU must be above to count as working. Feature G's
 * Fleet charts shade a GPU at or below it that has a run assigned: paid for
 * and idle, like the phantom runs of job 81fe2875 (7 of 24 GPUs).
 * fleet:gpuHistory counts a GPU above it, or one with a run pinned to it, as
 * busy.
 */
export const GPU_BUSY_UTIL_PCT = 10

/**
 * One node's usage at one metrics poll (about every 15 s). The node:metricsSample
 * push carries it, and main's history ring keeps it.
 */
export interface MetricsSample {
  nodeId: string
  /** epoch ms of the poll */
  ts: number
  /**
   * Per GPU, in nvidia-smi index order. null = no reading this time, because
   * the node was unreachable or the poll failed. It is a gap, so a chart
   * breaks its line there instead of drawing zero.
   */
  gpus: GpuSample[] | null
  /**
   * Runs pinned to each GPU at this poll, by GPU index (`runs[i]` for GPU
   * i), from the scheduler. Known even when `gpus` is null.
   */
  runs: number[]
  /** Runs in flight not pinned to one GPU: a single-GPU node, per-GPU slots off, or not started. */
  unpinnedRuns: number
  /** busy CPU % (NodeMetrics.cpuUtil); null = no reading */
  cpuUtil: number | null
  /** system RAM (GB); null = no reading */
  ramUsedGb: number | null
  ramTotalGb: number | null
}

/**
 * One bucket of a history series: the samples that fall in
 * [ts, ts + bucketMs). When every value is null there were none: a gap, where
 * the chart breaks its line (the History chart's `y: null` convention).
 */
export interface MetricsPoint {
  /** epoch ms of the bucket's left edge */
  ts: number
  mean: number | null
  min: number | null
  max: number | null
}

/** One GPU's history on one node. Every series shares NodeMetricsHistory's buckets. */
export interface GpuSeries {
  /** nvidia-smi index */
  index: number
  /** utilisation % */
  util: MetricsPoint[]
  /** VRAM used, as % of the card's total */
  vramPct: MetricsPoint[]
  /** package power (W); all null for a card that never reported it */
  powerW: MetricsPoint[]
  /**
   * Runs pinned to this GPU. A bucket where this is above 0 and `util` is at
   * or below GPU_BUSY_UTIL_PCT was paid for and idle.
   */
  runs: MetricsPoint[]
}

/** A range of one node's usage, bucketed (the result of node:metricsHistory). */
export interface NodeMetricsHistory {
  nodeId: string
  fromMs: number
  toMs: number
  /** width of one bucket (ms) */
  bucketMs: number
  gpus: GpuSeries[]
  /** runs in flight not pinned to one GPU */
  unpinnedRuns: MetricsPoint[]
  /** busy CPU % */
  cpuUtil: MetricsPoint[]
  /** GPU power summed across the node's cards (W) */
  powerW: MetricsPoint[]
}

/** The window a history read covers, and how many buckets it may return at most. */
export interface MetricsHistoryQuery {
  fromMs: number
  toMs: number
  maxPoints: number
}

export interface NodeMetricsHistoryQuery extends MetricsHistoryQuery {
  nodeId: string
}

/**
 * One bucket of the whole fleet's GPU use. Each figure is a mean over the
 * bucket's polls; null = no node was polled in it.
 */
export interface FleetGpuPoint {
  /** epoch ms of the bucket's left edge */
  ts: number
  /** GPUs on nodes that hold an instance */
  gpusRented: number | null
  /** GPUs above GPU_BUSY_UTIL_PCT, or with a run pinned to them */
  gpusBusy: number | null
  /** mean utilisation across rented GPUs (%) */
  meanUtil: number | null
  /** $/hr paid for GPUs that were not busy: each node's idle GPU share times its $/hr, summed */
  idlePerHour: number | null
}

/** The result of fleet:gpuHistory. */
export interface FleetGpuHistory {
  fromMs: number
  toMs: number
  /** width of one bucket (ms) */
  bucketMs: number
  points: FleetGpuPoint[]
}

// ---------------------------------------------------------------------------
// History / usage
// ---------------------------------------------------------------------------

/** Window the History screen summarises. */
export type HistoryRange = '1d' | '7d' | '30d' | 'all'

/** Which series the History screen is showing. */
export type HistoryMetric = 'spend' | 'balance' | 'power' | 'fleet'

/**
 * One time bucket of the usage series. `cost`/`wh` are totals *over* the
 * bucket; `avgPowerW`/`gpuUtil`/`nodeCount` are averages *at* it — bar marks
 * for the former, line marks for the latter.
 */
export interface HistoryBucket {
  /** epoch ms of the bucket's left edge */
  tsStart: number
  cost: number
  wh: number
  /** estimated CO2e for this bucket's energy (grams) */
  co2g: number
  /** mean GPU draw across samples in the bucket (W); null = never reported */
  avgPowerW: number | null
  /** mean GPU utilisation % across samples; null = never sampled */
  gpuUtil: number | null
  /**
   * Mean nodes billing CONCURRENTLY during the bucket, so it can be fractional.
   * Counted per minute and then averaged — not distinct node ids over the whole
   * bucket, which counted machines recycled through it and so reported many
   * times the fleet that ever ran at once.
   */
  nodeCount: number
}

/** A balance reading. Sparse — render as a step line, never interpolated. */
export interface BalancePoint {
  ts: number
  balance: number
}

export interface HistoryTotals {
  cost: number
  wh: number
  /** estimated CO2e over the range (grams) */
  co2g: number
  /**
   * Countries whose grids this range's energy was costed against, cleanest
   * first, so the UI can say what the estimate rests on. `country: null` is the
   * world-average fallback for nodes with no recorded location.
   */
  co2Sources: Array<{ country: string | null; wh: number; gPerKwh: number }>
  /** summed node uptime over the range (hours) */
  nodeHours: number
  avgPowerW: number | null
  peakPowerW: number | null
  /** most nodes that ever billed in the same minute over the range */
  peakNodes: number
  /** balance at the start / end of the range; null when never recorded */
  balanceStart: number | null
  balanceEnd: number | null
}

/** One row of "which jobs cost the most". */
export interface JobCostRow {
  jobId: string
  /** null when the job row has since been deleted */
  name: string | null
  engine: EngineId | null
  state: JobState | null
  cost: number
  wh: number
  /** estimated CO2e for this job's energy (grams) */
  co2g: number
  /** node-hours spent on this job over the range */
  gpuHours: number
  framesDone: number
  /** null when no frames have landed yet */
  costPerFrame: number | null
}

export interface HistorySummary {
  range: HistoryRange
  /** width of one bucket (ms) */
  bucketMs: number
  /** left edge of the window (epoch ms) */
  fromMs: number
  /** epoch ms of the oldest record we hold at all; null = nothing recorded */
  earliestMs: number | null
  buckets: HistoryBucket[]
  balancePoints: BalancePoint[]
  totals: HistoryTotals
  topJobs: JobCostRow[]
  /** spend not attributable to a job: idle, provisioning, and backfilled rows */
  unattributedCost: number
  unattributedWh: number
  unattributedCo2g: number
}

// ---------------------------------------------------------------------------
// Jobs / chunks
// ---------------------------------------------------------------------------

export type JobState = 'queued' | 'running' | 'complete' | 'partial' | 'failed' | 'cancelled'

/**
 * What a job's timing estimate is from (shared/jobTiming.ts): the frames
 * landing, the live runs' measured rates, the scene's measured seconds per
 * frame, or nothing yet.
 */
export type JobTimingBasis = 'downloads' | 'live' | 'scenePerf' | 'none'

/**
 * A chunk's lifecycle. 'failed' is a chunk that ran out of retries, or one a
 * failed job settled; 'cancelled' is one the user's cancel stopped before it
 * finished. Both are final until "re-render missing" reopens them
 * (jobs/revive.ts). Frames carry no such state: a cancelled frame is one not
 * yet downloaded whose chunk is cancelled.
 */
export type ChunkState =
  | 'pending'
  | 'assigned'
  | 'rendering'
  | 'encoding'
  | 'downloading'
  | 'complete'
  | 'failed'
  | 'cancelled'

export interface JobSubmission {
  blendPath: string
  engine: EngineId
  frameStart: number
  frameEnd: number
  frameStep: number
  /** ids from the addon registry to install/enable for this job */
  addonIds: string[]
  /** frames per chunk; null = auto (scheduler decides) */
  chunkSize: number | null
  name?: string
  /**
   * May this job's chunks share a node with other chunks? Optional; absent =
   * false = exclusive, which is the historical behaviour (one chunk per node
   * at a time, from any job — including this job's own other chunks).
   *
   * Tick it for renders that leave the node under-used — e.g. a long
   * single-threaded CPU pre-compute before each frame reaches the GPU. How
   * many such chunks actually run side-by-side is decided per node by the
   * slot controller, not by this flag.
   */
  shareNode?: boolean
}

/**
 * What kind of failure an error is, which decides what it costs (plan 1.17's
 * classify):
 *   transient  the network or Vast's API blinked: retry soon, charge nothing
 *   machine    the node is at fault (it died, lost a GPU, ran out of disk):
 *              charge the infrastructure budget and try another node
 *   account    Vast refused the account (401, 402, 403, no credit): hold
 *              renting (FleetHolds.account) and never blacklist a machine
 *   job        the scene or its settings fail the same way on any node:
 *              charge the render budget; on two nodes, the job needs attention
 *   localFs    this computer could not keep the output (disk full, no
 *              permission): hold (FleetHolds.localSink) and re-render nothing
 */
export type ErrorClass = 'transient' | 'machine' | 'account' | 'job' | 'localFs'

/**
 * Why a job stopped where only the user can move it on:
 *   scene            the preflight found the scene cannot render as submitted:
 *                    missing files or libraries, an unbaked simulation split
 *                    over several chunks, a movie output format (plan 1.16)
 *   repeatedFailure  the same class of error on two or more nodes, so the fault
 *                    is the job's, not a machine's (plan 1.17's breaker)
 *   engine           the engine cannot run: no OctaneBlender on the node's
 *                    image, or no Cycles GPU device enabled (plans 1.16, 1.18)
 *   extension        an extension the job needs is not in the registry (A12)
 */
export type JobAttentionKind = 'scene' | 'repeatedFailure' | 'engine' | 'extension'

export interface JobAttention {
  kind: JobAttentionKind
  /** what went wrong, worded to show the user */
  message: string
  /** epoch ms it was raised */
  since: number
  /** the class of the errors behind it (for 'repeatedFailure') */
  errorClass?: ErrorClass
}

export interface JobSummary {
  id: string
  name: string
  blendPath: string
  engine: EngineId
  frameStart: number
  frameEnd: number
  frameStep: number
  state: JobState
  framesDone: number
  framesTotal: number
  /** frames not downloaded whose chunk was cancelled (ChunkState 'cancelled') */
  framesCancelled: number
  costSoFar: number
  /** epoch ms */
  submittedAt: number
  outputDir: string
  /** Blender release resolved from the .blend header, e.g. "4.5.3" */
  blenderVersion: string | null
  /** may co-run with other chunks on one node — see JobSubmission.shareNode */
  shareNode: boolean
  /**
   * Something only the user can resolve has stopped this job (plans 1.16,
   * 1.17). null or absent = nothing.
   */
  attention?: JobAttention | null
  /**
   * sha256 of the scene as submitted. Plan 1.12 has createJob copy the .blend
   * into the job's folder and render that copy. null = submitted before
   * snapshots existed, so it renders whatever `blendPath` holds now.
   */
  blendSha256?: string | null
  /** epoch ms the first chunk was dispatched; null = not yet (or never recorded) */
  startedAt: number | null
  /** epoch ms the job reached a final state; null while it is queued or running */
  finishedAt: number | null
  /**
   * Timing as of `timingAt` (shared/jobTiming.ts estimateJobTiming). Project
   * it to now with projectTiming rather than reading it raw: a live job's
   * elapsed runs on and its remaining counts down between updates.
   *  - elapsedMs: startedAt to finishedAt, or to timingAt; null = never started
   *  - remainingMs: 0 once complete; null = no estimate (nothing rendering
   *    yet, or a job that will not finish: failed, partial, cancelled)
   *  - etaAt: epoch ms it should be done; finishedAt once complete
   *  - framesPerHour: the rate behind the estimate; a finished job's average
   */
  elapsedMs: number | null
  remainingMs: number | null
  etaAt: number | null
  framesPerHour: number | null
  /** what the estimate is from (see jobTiming.ts) */
  timingBasis: JobTimingBasis
  /** epoch ms (main's clock) the timing fields were worked out */
  timingAt: number
  /** media:// URL of the preview of the job's latest frame that has one; null = none yet */
  thumbUrl: string | null
  /**
   * Where the job stands in the render queue (jobs/queue.ts): lower goes
   * first; every member of a group has the same one. Only meaningful while
   * the job is queued or running; a finished job keeps its last. null = a
   * job from before the queue whose position was never set.
   */
  queuePos: number | null
  /** the group whose members share one priority and render in step; null = on its own */
  groupId: string | null
  /** epoch ms the user removed it from the Jobs list (job:remove); null = listed */
  hiddenAt: number | null
}

/**
 * One place in the render queue: a job on its own, or a group whose members
 * share it (queue:list, job:move). Only queued and running jobs are in it.
 */
export interface QueueEntry {
  /** 1-based, in dispatch order */
  position: number
  groupId: string | null
  /** the job, or the group's members in the order they were submitted */
  jobIds: string[]
}

export interface ChunkSnapshot {
  id: string
  jobId: string
  frameStart: number
  frameEnd: number
  state: ChunkState
  nodeId: string | null
  framesDone: number
  retries: number
  /**
   * Why its last attempt failed, including the error's code, so the reason is
   * never empty (plans 1.17, 1.20). null = no failure recorded.
   */
  lastError?: string | null
  /** what kind of failure `lastError` was (plan 1.17) */
  errorClass?: ErrorClass | null
  /**
   * Failed attempts charged to the machines rather than to the render: a
   * node that died, a lost connection, a transfer that stalled (plan 1.17).
   * They are kept apart from `retries`, the render's own budget, so an
   * unreliable host cannot use up a chunk's chances.
   */
  infraRetries?: number
  /** epoch ms before which the chunk is not dispatched again (retry backoff); null = any time */
  notBefore?: number | null
}

export interface JobDetail extends JobSummary {
  chunks: ChunkSnapshot[]
  addonIds: string[]
  /**
   * The file at `blendPath` no longer matches `blendSha256`: edited, moved or
   * deleted since submit. The job still renders its snapshot; the UI says the
   * scene changed (plan 1.12). null = not known, because there is no snapshot
   * or it was not checked. Only on JobDetail, because checking it means
   * reading the file.
   */
  sceneChanged?: boolean | null
  /**
   * Where this scene's render time went, one row per GPU model it rendered
   * on (scene_perf). Empty until a chunk rendered through the agent's render
   * driver; absent from older builds.
   */
  renderTimes?: SceneRenderTimes[]
}

/**
 * Where one scene's render time goes on one GPU model, measured by the
 * agent's render driver (remote/blender/render_driver.py). Per-frame phases
 * are means over every frame timed; null = none timed yet.
 */
export interface SceneRenderTimes {
  gpuName: string
  /** mean seconds from Blender's launch to the scene loaded and its scripts run, per chunk */
  loadS: number | null
  /** chunks behind loadS */
  loads: number
  /** frames behind the per-frame means */
  frames: number
  /** render depsgraph: animation, modifiers, geometry nodes */
  evalS: number | null
  /** Cycles' scene sync, BVH build and upload: the GPU mostly idle */
  syncS: number | null
  /** path tracing: the GPU busy */
  sampleS: number | null
  /** compositing and writing the file */
  saveS: number | null
  /** the most GPU memory one render of it used, MB; null = not measured */
  peakVramMb: number | null
  updatedAt: number
}

/** What job:retryMissing queued again (plan 1.15). */
export interface RetryMissingResult {
  /** frames not yet downloaded that are queued again */
  frames: number
  /** chunks those frames were split into */
  chunks: number
}

/**
 * A chunk seen from a node's point of view: the chunk row joined to its job's
 * identity and its newest preview. This is the shape the Fleet node panel
 * needs, and the join is why it is an invoke rather than a field on
 * NodeSnapshot — NodeSnapshot is rebuilt on every 15s metrics poll for every
 * node, and a four-table join has no business running there.
 */
export interface NodeChunkView {
  chunkId: string
  jobId: string
  jobName: string
  engine: EngineId
  frameStart: number
  frameEnd: number
  frameStep: number
  state: ChunkState
  /** frames downloaded for this chunk's range */
  framesDone: number
  framesTotal: number
  retries: number
  /**
   * The scheduler has a live ChunkRun for this chunk. NOT derivable from
   * `state`: a chunk stays 'rendering' in SQLite after its run dies, which is
   * exactly the stale-slot case this panel exists to expose.
   */
  live: boolean
  /** epoch ms the chunk was dispatched; null for rows that predate the column */
  assignedAt: number | null
  /** GPU the live run is pinned to (nvidia-smi index); null = unpinned / unknown */
  gpu: number | null
  /** newest downloaded frame thumbnail for this chunk; null until one lands */
  thumbUrl: string | null
}

// ---------------------------------------------------------------------------
// Addons (user-provided Blender extension zips)
// ---------------------------------------------------------------------------

export interface AddonInfo {
  /** extension id parsed from the zip's blender_manifest.toml */
  id: string
  name: string
  version: string
  /** local copy under userData/addons/ */
  zipPath: string
  zipHash: string
  /**
   * install  → `blender --command extension install-file` + enable + save_userpref
   * bootstrap → sys.path bootstrap -P script calling register() (fallback for
   *             zips that don't conform to the extension layout)
   */
  mechanism: 'install' | 'bootstrap'
}

// ---------------------------------------------------------------------------
// Assets (downloaded render outputs)
// ---------------------------------------------------------------------------

/**
 * `live` is the rolling clip assembled while a chunk is still rendering. It is
 * superseded by the definitive renditions when the chunk finishes, and is
 * deliberately excluded from the Gallery wall's allow-list — it is a progress
 * view, not a deliverable.
 */
export type ClipKind = 'previewSdr' | 'previewHdr' | 'proxy' | 'live'

/** An inclusive run of job frame numbers (honouring the job's frame step). */
export interface FrameSegment {
  start: number
  end: number
}

export interface ClipAsset {
  kind: ClipKind
  /**
   * 'chunk': one chunk's clip. 'job': the chunk clips of a job stitched end to
   * end (lossless remux, see main/transfer/jobClip.ts), so a job reads as one
   * clip however finely it was chunked.
   */
  scope: 'chunk' | 'job'
  /**
   * Job scope only: the job frames the clip holds, in clip order. Chunks not
   * yet complete are gaps, so clip index ≠ job frame − start in general.
   */
  segments?: FrameSegment[]
  /** '' for a job-scoped clip */
  chunkId: string
  label: string
  absPath: string
  /** media:// URL for <video> playback */
  mediaUrl: string
  fps: number
  frames: number
  width: number
  height: number
  codec: ProxyCodec
  hdr: boolean
}

/** A frame's browser-displayable preview image. */
export interface ThumbAsset {
  frame: number
  chunkId: string
  absPath: string
  mediaUrl: string
}

export interface FrameAsset {
  frame: number
  chunkId: string
  absPath: string
  sizeBytes: number
}

export interface AssetIndex {
  jobId: string
  clips: ClipAsset[]
  frames: FrameAsset[]
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Settings visible to the renderer. Secrets never cross IPC — only flags. */
export interface SettingsPublic {
  hasVastApiKey: boolean
  hasOtoyCredentials: boolean
  projectRoot: string
  maxActiveNodes: number
  /**
   * $/hr across the whole fleet. null means uncapped only together with
   * `noSpendCap`. sanitizeSettingsPatch never saves one without the other,
   * and nodeState.capacityBudget reads a null without the flag (a file from
   * before it) as $0/hr: nothing is rented.
   */
  spendCapPerHour: number | null
  idleTimeoutMinutes: number
  proxyCodec: ProxyCodec
  /** null = auto (match the .blend's version) */
  blenderVersionOverride: string | null
  offerFilters: OfferFilters
  sshKeyPath: string
  concurrentTransfersPerNode: number
  /**
   * Stream a small JPEG per rendered frame off the node, so the UI has
   * something to show while a chunk is still rendering (the frames themselves
   * are usually EXR, which no browser decodes). Costs one extra ffmpeg
   * invocation per frame on the node.
   */
  thumbnails: boolean
  /**
   * Rolling preview clip, assembled on the node one frame at a time while a
   * chunk renders.
   *
   * 'onDemand' (default) encodes only while someone is watching that chunk —
   * an always-on live encoder on a many-slot node competes with the render it
   * is previewing. 'always' is fine at low slot counts and gives a preview
   * that is ready the moment you open it.
   */
  livePreview: 'off' | 'onDemand' | 'always'
  /** Width of the live clip in pixels; height follows the render's aspect. */
  livePreviewWidth: number
  /**
   * Upper bound on concurrent render slots per node (blender subprocesses
   * rendering different chunks at once). 0 = auto: the slot controller is
   * bounded only by the node's own hardware ceiling. Any value > 0 is a
   * manual cap on top of that ceiling.
   *
   * Only jobs with `shareNode` ever occupy more than one slot; an exclusive
   * chunk holds its node alone regardless of this number.
   */
  maxNodeSlots: number
  /**
   * Render slots per GPU on a node (optional; absent = 1).
   *
   * 1 (default): a node with N GPUs runs N chunks at once, each Blender pinned
   * to one GPU with CUDA_VISIBLE_DEVICES — including jobs that do NOT share
   * nodes, for which the GPU rather than the whole node becomes the unit of
   * exclusivity. A single Blender spread over every GPU scales badly whenever
   * a frame carries serial CPU work (scene sync, BVH build, geometry nodes),
   * because every GPU idles while that one process does it.
   *
   * 2: two chunks per GPU, so one process's CPU sync overlaps the other's GPU
   * sampling. Worth it when sync is a large fraction of the frame; costs VRAM
   * and RAM for the second copy of the scene. Applies to single-GPU nodes too.
   *
   * 0: off — one Blender process uses every GPU on the node (the behaviour
   * before per-GPU slots).
   */
  slotsPerGpu?: number
  /**
   * Buy-ahead fleet mode (optional; default off = historical demand-driven
   * scaling). When true, scale-up keeps renting to maxActiveNodes while ANY
   * chunk is unfinished, instead of only when pending exceeds free capacity —
   * demand-driven scaling can never widen a fleet whose nodes prefetch the
   * whole queue, which strands a long CPU-bound drain on too few machines.
   */
  eagerFleet?: boolean
  /**
   * Multiplier from measured GPU draw to a whole-facility estimate, used only
   * for CO2 figures. `nvidia-smi` reports the GPU package alone — no host CPU
   * or RAM, no PSU losses, no cooling — so a datacentre's real draw is roughly
   * 1.5-2x the card. Set to 1 to cost the GPU alone.
   *
   * Displayed Wh figures are never scaled by this; only the CO2 estimate is.
   */
  co2OverheadFactor: number
  /**
   * A random id for this profile, made once (plan 1.3). Rental labels carry
   * its first 8 characters (`vastai-blender <install8>:<node8>`), so the
   * reconcile can tell this profile's instances from those of another install
   * or profile on the same Vast account. Main makes it and it never changes:
   * a settings patch cannot set it, the same as the has* flags. Absent until
   * main has made one.
   */
  installId?: string
  /**
   * The user turned the spend cap off on purpose. This is the only way
   * spendCapPerHour becomes null. Clearing the cap field to retype it saved
   * null on every keystroke, and every reader took that as "no cap"
   * (#99 #112). sanitizeSettingsPatch keeps the two in step.
   */
  noSpendCap?: boolean
  /**
   * Docker image to rent each engine's nodes with (plan 1.18). An engine
   * with no entry uses the built-in image. Octane needs an image with
   * OctaneBlender in it. The image name goes to Vast's create call, never to
   * a shell, and sanitizeSettingsPatch accepts only a well-formed image
   * reference.
   */
  dockerImageByEngine?: Partial<Record<EngineId, string>>
  /** Octane (plan 1.18). Absent = every option off. */
  octane?: OctaneSettings
}

export interface OctaneSettings {
  /**
   * Sign in to OTOY from a script instead of by hand over VNC. Off by
   * default. Any credential used on a rented node is disclosed to the host's
   * owner, who has root there, so turning this on needs a warning. With it
   * on, the credentials must reach the node on exec stdin (`IFS= read -r`),
   * never in argv, env or a file (plan 1.18).
   */
  scriptedSignIn: boolean
  /**
   * Rent Octane nodes only from datacenter (secure cloud) hosts, which are
   * vetted businesses rather than individuals.
   */
  secureCloudOnly: boolean
}

/**
 * A change to the settings, as the renderer or a VR_JOB_SPEC campaign sends
 * it: any subset of the fields, including part of a nested object. Main runs
 * it through sanitizeSettingsPatch before anything is saved.
 */
export type SettingsPatch = Partial<
  Omit<SettingsPublic, 'offerFilters' | 'octane' | 'dockerImageByEngine'>
> & {
  offerFilters?: Partial<OfferFilters>
  octane?: Partial<OctaneSettings>
  /** null or '' for an engine = back to the built-in image */
  dockerImageByEngine?: Partial<Record<EngineId, string | null>>
}

/** A patch field that was not saved as sent. */
export interface SettingsFieldError {
  /** dotted path of the setting: 'spendCapPerHour', 'offerFilters.minReliability', 'octane.scriptedSignIn' */
  field: string
  /** worded to show next to the field */
  message: string
  /**
   * 'rejected': the setting kept its current value. 'clamped': the nearest
   * value within its limits was saved instead.
   */
  outcome: 'rejected' | 'clamped'
}

/** The result of settings:update. */
export interface SettingsPatchResult {
  /** the settings as saved: every field of the patch that passed, applied */
  settings: SettingsPublic
  /** each field that was not saved as sent; empty = all of it was */
  errors: SettingsFieldError[]
}

export type SecretKey = 'vastApiKey' | 'otoyUsername' | 'otoyPassword'

/**
 * The Vast.ai permission groups the app's key needs, as named in Vast's
 * scoped-key JSON (docs.vast.ai/api-reference/permissions).
 */
export type VastPermission = 'user_read' | 'instance_read' | 'misc' | 'instance_write'

/**
 * One permission group as vast:testKey found it: `ok` true when a read-only
 * call that needs it went through, false when it failed, null when it cannot
 * be tested without renting or destroying something (instance_write).
 */
export interface VastPermissionCheck {
  perm: VastPermission
  ok: boolean | null
  detail: string
}

export interface VastKeyTest {
  /** Every testable permission passed. */
  ok: boolean
  /** One line: the account and its credit, or why the key failed. */
  message: string
  checks: VastPermissionCheck[]
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * High-rate: one per in-flight chunk per agent poll (~5s). Consumers must fold
 * this into local state, never use it to invalidate a query — at 8 slots × 4
 * nodes that is a refetch storm. `chunk:changed` is the invalidation signal.
 */
export interface ChunkProgressEvent {
  chunkId: string
  jobId: string
  nodeId: string
  currentFrame: number | null
  framesDone: number
  framesTotal: number
  /** the agent's state for the chunk */
  status?: 'rendering' | 'encoding' | 'done' | 'failed'
  /**
   * Blender's latest output line (not the agent's VR_* markers), as written;
   * absent before Blender has said anything.
   */
  lastLine?: string | null
  /** `lastLine` read as Blender's status line; null when it is not one */
  renderStatus?: RenderStatus | null
  /** epoch ms of the last real progress on the node (a frame started or saved) */
  lastProgressAt?: number | null
  /** mean seconds per frame over this chunk's frames the render driver timed; null = none yet */
  avgFrameS?: number | null
}

/**
 * Blender's status line, read (scheduler/blenderStatus.ts). Every field is
 * null when the line does not carry it.
 */
export interface RenderStatus {
  frame: number | null
  /** Blender's own memory, MB, and its peak */
  memMb: number | null
  peakMemMb: number | null
  /** time on this frame so far, and Blender's estimate of what is left of it, s */
  elapsedS: number | null
  remainingS: number | null
  /** Cycles: the render device's memory, MB, and its peak */
  deviceMemMb: number | null
  devicePeakMemMb: number | null
  /** samples done of the frame, of `samples` */
  sample: number | null
  samples: number | null
  /** what it is doing, in Blender's words: "Sample 32/256", "Synchronizing object · Cube" */
  phase: string | null
}

/** Low-rate: a chunk's lifecycle state moved. Safe to invalidate on. */
export interface ChunkChangedEvent {
  chunkId: string
  jobId: string
  /** null once the chunk is unassigned (restart recovery, requeue) */
  nodeId: string | null
  state: ChunkState
}

export interface LogLineEvent {
  nodeId: string
  chunkId: string | null
  line: string
  /** epoch ms */
  ts: number
}

export interface AssetAddedEvent {
  jobId: string
  chunkId: string
  kind: ClipKind | 'frame' | 'thumb'
  /** frame number for 'frame'/'thumb'; absent for clips */
  frame?: number | null
  path: string
  /** media:// URL — present for anything the renderer can display directly */
  mediaUrl?: string
}

export interface AlertEvent {
  level: 'info' | 'warn' | 'error'
  message: string
}
