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
   * ranked by a CPU proxy (clock × √effective-cores per dollar) instead of
   * vast's DL benchmark, so premium datacenter GPUs stop winning offers for
   * renders whose frame cost is mostly CPU.
   */
  cpuBound?: boolean
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
  currentChunkId: string | null
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
  /** vast account credit balance, null until first fetched */
  balance: number | null
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

export type ClipKind = 'previewSdr' | 'previewHdr' | 'proxy'

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
   * Concurrent render slots per node (blender subprocesses running different
   * chunks at once). 1 = historical behaviour. "auto"-style heuristics live
   * node-side; this is passed through in every chunk's job spec and also
   * raises the scheduler's per-node in-flight chunk limit.
   */
  nodeSlots: number
}

export type SecretKey = 'vastApiKey' | 'otoyUsername' | 'otoyPassword'

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface ChunkProgressEvent {
  chunkId: string
  jobId: string
  currentFrame: number | null
  framesDone: number
  framesTotal: number
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
  kind: ClipKind | 'frame'
  path: string
}

export interface AlertEvent {
  level: 'info' | 'warn' | 'error'
  message: string
}
