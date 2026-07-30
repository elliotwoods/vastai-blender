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
}

/** One chunk the scheduler currently has in flight on a node. */
export interface NodeWorkRef {
  chunkId: string
  jobId: string
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
  /** Blender versions installed on the node, e.g. ["4.5.3"] */
  blenderVersions: string[]
  lastError: string | null
  /** live usage sample; null until the first metrics poll */
  metrics: NodeMetrics | null
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

export type ChunkState =
  'pending' | 'assigned' | 'rendering' | 'encoding' | 'downloading' | 'complete' | 'failed'

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
  costSoFar: number
  /** epoch ms */
  submittedAt: number
  outputDir: string
  /** Blender release resolved from the .blend header, e.g. "4.5.3" */
  blenderVersion: string | null
  /** may co-run with other chunks on one node — see JobSubmission.shareNode */
  shareNode: boolean
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
}

export interface JobDetail extends JobSummary {
  chunks: ChunkSnapshot[]
  addonIds: string[]
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

export interface ClipAsset {
  kind: ClipKind
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
  /** $/hr across the whole fleet; null = uncapped */
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
}

export type SecretKey = 'vastApiKey' | 'otoyUsername' | 'otoyPassword'

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
