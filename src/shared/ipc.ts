/**
 * The typed IPC contract — the single source of truth for every channel that
 * crosses main ↔ renderer. Both sides import from here; adding a channel means
 * adding it to one of these maps. A type mismatch is then a compile error on
 * whichever side is out of date, and so is a push channel the renderer does
 * not handle (useIpcEvents is exhaustive over IpcEventMap). An invoke channel
 * with no ipcMain handler is not caught: it fails at runtime.
 *
 * Phase 1 declared its channels here ahead of the code behind them, so every
 * track codes against one contract. Every invoke channel now has a handler
 * in main (ipc.ts). The push channels Phase 1 adds wait in
 * IpcEventMapPending, for the reason given there; main sends them already.
 */

import type {
  AddonInfo,
  AlertEvent,
  AssetAddedEvent,
  AssetIndex,
  ChunkChangedEvent,
  ChunkProgressEvent,
  FleetCost,
  FleetGpuHistory,
  FleetHoldKind,
  FleetHolds,
  HistoryRange,
  HistorySummary,
  JobDetail,
  JobSubmission,
  JobSummary,
  LogLineEvent,
  MetricsHistoryQuery,
  MetricsSample,
  NodeChunkView,
  NodeMetricsHistory,
  NodeMetricsHistoryQuery,
  NodeSnapshot,
  ReprovisionResult,
  RequestNodeOptions,
  RetryMissingResult,
  ScaleStatusInfo,
  ThumbAsset,
  Offer,
  OfferFilters,
  SecretKey,
  SettingsPatch,
  SettingsPatchResult,
  SettingsPublic,
  SshCommandInfo,
  UnclaimedInstance,
  VastKeyTest,
  VncTunnelInfo
} from './models'

/** Request/response channels (`ipcRenderer.invoke` ↔ `ipcMain.handle`). */
export interface IpcInvokeMap {
  // settings
  'settings:get': { args: []; result: SettingsPublic }
  'settings:set': { args: [Partial<SettingsPublic>]; result: SettingsPublic }
  /**
   * Phase 1 (plan 1.14). Save the fields of a patch that pass
   * sanitizeSettingsPatch, and say which did not and why, so a field can
   * show its own error when it commits. settings:set stays for its current
   * callers, and plan 1.14 puts it through the same sanitizer.
   */
  'settings:update': { args: [SettingsPatch]; result: SettingsPatchResult }
  'settings:setSecret': { args: [SecretKey, string]; result: void }

  // vast.ai
  'vast:testKey': { args: []; result: VastKeyTest }
  'vast:searchOffers': { args: [Partial<OfferFilters> | undefined]; result: Offer[] }

  // fleet / nodes
  'fleet:setMaxNodes': { args: [number]; result: void }
  /**
   * Rent one node now. It stops at the spend cap as scale-up does, unless
   * `overSpendCap` says the user confirmed going past it, and then rents
   * nothing dearer than `maxPerHour` when the confirmation named one (plan
   * 1.5). It rejects with the reason when nothing could be rented.
   */
  'fleet:requestNode': { args: [RequestNodeOptions?]; result: void }
  /**
   * The fleet totals fleet:cost pushes, as they stand now, for a window that
   * opens between pushes (the cost timer pushes once a minute).
   */
  'fleet:cost': { args: []; result: FleetCost }
  'fleet:clearFailed': { args: []; result: number }
  /**
   * Phase 1 (plan 1.3). Instances on the Vast account that no node of this
   * profile holds, as the latest reconcile found them.
   */
  'fleet:unclaimed': { args: []; result: UnclaimedInstance[] }
  /**
   * Phase 1 (plan 1.3). Destroy one unclaimed instance, by its instance id,
   * and confirm it is gone. Main refuses an id its unclaimed list does not
   * show. That includes the instance of any node of this profile, which
   * node:destroy retires along with its row. `ok: false` = not confirmed
   * gone, with the reason.
   */
  'fleet:destroyUnclaimed': { args: [number]; result: { ok: boolean; message: string } }
  /** Phase 1. Every reason the fleet has stopped renting (plans 1.9, 1.10, 1.17, 1.20). */
  'fleet:holds': { args: []; result: FleetHolds }
  /**
   * Phase 1. Release one hold, for example "I topped up, try now" for
   * 'account'. It returns the holds that are left. A hold whose cause is
   * still there, such as a disk that is still full, comes back on the next
   * check.
   */
  'fleet:releaseHold': { args: [FleetHoldKind]; result: FleetHolds }
  /**
   * Phase 1 (Feature G). The whole fleet's GPU use over a window: GPUs
   * rented and busy, mean utilisation, and the $/hr paid for idle GPUs.
   */
  'fleet:gpuHistory': { args: [MetricsHistoryQuery]; result: FleetGpuHistory }
  'node:destroy': { args: [string]; result: void }
  /**
   * Restart the node's agent and requeue what was in flight on it (plan
   * 1.15). Render retries are unchanged; each requeued chunk is charged one
   * infrastructure retry, as any chunk a node goes away under. It rejects
   * with the reason when the node was not reprovisioned: the app is quitting
   * (the node is left as it is), another agent restart was under way on it
   * (the node is back in service), or it ran past its deadline (the node is
   * destroyed).
   */
  'node:reprovision': { args: [string]; result: ReprovisionResult }
  /**
   * A local port tunnelled to the node's VNC desktop, plus its password, for
   * signing in to Octane by hand (plan 1.18). Invoke it only from the user's
   * own "Open VNC login" click: opening a tunnel is taken as the user at
   * the desktop, and ends a missed sign-in's hold on Octane rentals.
   */
  'node:openVncTunnel': { args: [string]; result: VncTunnelInfo }
  /**
   * Phase 1 (Feature G). One node's usage over a window, per GPU, bucketed
   * to at most `maxPoints`. Main reads recent samples from memory and older
   * ones from the database.
   */
  'node:metricsHistory': { args: [NodeMetricsHistoryQuery]; result: NodeMetricsHistory }
  /** Command line for an interactive shell on the node (null = no ssh endpoint yet). */
  'node:sshCommand': { args: [string]; result: SshCommandInfo | null }
  /** Spawn a terminal running that command; `ok: false` → caller copies instead. */
  'node:openSshTerminal': { args: [string]; result: { ok: boolean; message: string } }
  'nodes:list': { args: []; result: NodeSnapshot[] }
  /** Chunks on a node joined to their jobs — live work first, then most recent. */
  'node:chunks': { args: [{ nodeId: string; limit?: number }]; result: NodeChunkView[] }
  /** Frame thumbnails in a range, for the filmstrip's visible window. */
  'frames:thumbs': {
    args: [{ jobId: string; from: number; to: number }]
    result: ThumbAsset[]
  }
  /** Ask the node to build (or stop building) a chunk's rolling live clip. */
  'preview:subscribe': { args: [{ chunkId: string; on: boolean }]; result: void }

  // jobs
  'jobs:list': { args: []; result: JobSummary[] }
  'job:get': { args: [string]; result: JobDetail | null }
  'job:create': { args: [JobSubmission]; result: { jobId: string } }
  'job:cancel': { args: [string]; result: void }
  /** Toggle node sharing; affects chunks not yet assigned. */
  'job:setShareNode': { args: [string, boolean]; result: void }
  /**
   * Queue again every frame of the job that has not been downloaded,
   * including frames from failed chunks (plan 1.15, "Re-render missing").
   * Right after a cancel of the same job it first waits for the cancel to
   * have stopped the job's renders on the nodes. Rejects with the reason
   * for a job that cannot be revived.
   */
  'job:retryMissing': { args: [string]; result: RetryMissingResult }
  /**
   * Release a job the retry breaker held (JobSummary.attention of kind
   * 'repeatedFailure', plan 1.17): its failures are counted afresh and its
   * chunks go out again. false = the job was not held. A job that failed
   * outright (attention scene, engine or extension) stays failed.
   */
  'job:resume': { args: [string]; result: boolean }

  // scheduler
  /**
   * Chunks recovered from a previous session whose fleet scale-up is paused
   * pending confirmation, or null when nothing is held.
   */
  'scheduler:recoveryHold': { args: []; result: { chunks: number } | null }
  /** Release that hold and let the fleet scale up for the recovered work. */
  'scheduler:resumeRecovery': { args: []; result: void }
  /**
   * Why scale-up is renting or not, as the scheduler decided at its last
   * tick (every 15 s), or null before the first. A hold's reason is here as
   * well as in fleet:holds.
   */
  'scheduler:scaleStatus': { args: []; result: ScaleStatusInfo | null }

  // history
  'history:summary': { args: [HistoryRange]; result: HistorySummary }

  // addons
  'addons:list': { args: []; result: AddonInfo[] }
  'addon:register': { args: [string]; result: AddonInfo }
  'addon:remove': { args: [string]; result: void }

  // assets
  'assets:index': { args: [string]; result: AssetIndex }

  // logs
  'logs:getTail': { args: [{ nodeId?: string; chunkId?: string; lines: number }]; result: string[] }

  // alerts
  /**
   * Main's buffer of recent alerts, least recently seen first. A window reads
   * it when it mounts, because an alert emitted before it was listening (the
   * boot-time orphan sweep, or while a macOS window was closed) reached no one.
   */
  'alerts:recent': { args: []; result: AlertRecord[] }
  /**
   * The user dismissed these alerts (by alertKey) in a window. Main keeps the
   * dismissal, so a window reopened or reloaded does not replay them all again.
   */
  'alerts:dismiss': { args: [string[]]; result: void }

  // shell / dialogs
  'clipboard:write': { args: [string]; result: void }
  'shell:openExternal': { args: [string]; result: void }
  'shell:openPath': { args: [string]; result: void }
  'shell:showItemInFolder': { args: [string]; result: void }
  'dialog:pickBlendFiles': { args: []; result: string[] }
  'dialog:pickZipFile': { args: []; result: string | null }
  'dialog:pickFolder': { args: []; result: string | null }
}

/** Push channels (main → renderer via `webContents.send`). */
export interface IpcEventMap {
  'node:changed': NodeSnapshot
  'job:changed': JobSummary
  'chunk:progress': ChunkProgressEvent
  /** Lifecycle only — the invalidation signal chunk:progress must not be. */
  'chunk:changed': ChunkChangedEvent
  'render:logLine': LogLineEvent
  'asset:added': AssetAddedEvent
  'fleet:cost': FleetCost
  alert: AlertEvent
}

/**
 * Phase 1 push channels, with their payloads final, waiting for their
 * subscribers.
 *
 * They are not in IpcEventMap yet because useIpcEvents' handler map (the
 * renderer's queries.ts) is exhaustive over it. That is on purpose: the
 * `alert` channel went unheard for the app's whole life before it was
 * exhaustive. A channel added there with no handler therefore fails
 * typecheck:web. An entry moves into IpcEventMap in the same commit that
 * gives it a handler (or an explicit null) in queries.ts.
 *
 * Main sends these already, straight to the windows rather than through the
 * bus (ipc.ts's sendPush, typed over IpcEventMap & IpcEventMapPending, so a
 * move needs no change there), and a renderer may subscribe to them under
 * the same intersection.
 */
export interface IpcEventMapPending {
  /**
   * One node's usage at one metrics poll (Feature G), about every 15 s per
   * node. This is high rate, so fold it into the metrics store and never use
   * it to invalidate a query, like chunk:progress.
   */
  'node:metricsSample': MetricsSample
  /** Every hold, whenever one is set or released; `{}` = renting freely. */
  'fleet:holds': FleetHolds
  /**
   * The unclaimed instances, whenever a reconcile changes the list (every
   * 5 min, on wake, and after an API key is saved: plan 1.3).
   */
  'fleet:unclaimed': UnclaimedInstance[]
}

// -- alerts ------------------------------------------------------------------
// The rules below are shared because main's replay buffer (events.ts) and the
// renderer's store (alertStore.ts) must agree on them. If they disagreed, a
// replayed alert and a pushed one would not merge, and a window opened late
// would list the same failure twice.

/**
 * One entry in main's buffer of recent alerts. Identical alerts (alertKey)
 * collapse into one entry: `ts` is when it first fired, `lastSeen` when it
 * last did, `count` how many times.
 */
export interface AlertRecord extends AlertEvent {
  id: number
  key: string
  ts: number
  lastSeen: number
  count: number
  /** When the user last dismissed it in a window (alerts:dismiss); null if never. */
  dismissedAt: number | null
}

/**
 * A dismissed alert that fires again comes back, but not within this long of
 * its dismissal. So a failure repeating every 15 s is put in front of the user
 * once per quiet period, not every 15 s.
 *
 * Not for a billing risk (isBillingRisk): any repeat after its dismissal
 * brings it straight back. None of them repeats on a timer. Each is a new
 * destroy that failed on an instance still billing, such as Fleet's "clear
 * failed" retried during a Vast outage right after the user dismissed the
 * first failure. Kept quiet, that retry's failure would reach no one, and a
 * Fleet row that did not clear would be the only sign. A billing risk that
 * did repeat on a timer would need a throttle of its own, not this one.
 */
export const RESURFACE_MS = 5 * 60_000

/**
 * Whether a window should keep this record out of sight: dismissed, and not
 * fired again since. For anything but a billing risk, a repeat within
 * RESURFACE_MS of the dismissal does not count either. A window that was open
 * all along brings an alert back by the same rule when its push arrives
 * (alertStore's receive), so one replaying the buffer reaches the same answer.
 */
export function isStillDismissed(r: AlertRecord): boolean {
  if (r.dismissedAt === null) return false
  if (isBillingRisk(r)) return r.lastSeen <= r.dismissedAt
  return r.lastSeen - r.dismissedAt < RESURFACE_MS
}

/**
 * What makes two alerts "the same": level and exact message, nothing looser.
 * "Destroy failed for instance 123" and "... 456" are two instances billing,
 * and folding them into one line would hide one of them.
 */
export function alertKey(a: AlertEvent): string {
  return `${a.level}:${a.message}`
}

/**
 * Messages saying an instance may be billing with nothing in the app managing
 * it: a destroy that failed, an orphan, an instance left for the Vast.ai
 * console. Matched on the text because AlertEvent carries no structured kind
 * yet; every such message main emits today says one of these things.
 *
 * "orphan" matches as a whole word only. The orphan sweep announces
 * "destroying orphaned instance N" before it tries, and that is not yet a
 * risk: if the destroy fails it says so in an alert of its own ("orphan
 * destroy failed ... check the Vast.ai console!"), which matches. Were the
 * announcement a match too, every sweep would leave a sticky row with a
 * console link beside it, crying wolf next to the one that is real.
 */
const BILLING_RISK = /destroy failed|could not destroy|vast\.ai console|\borphans?\b|unclaimed/i

export function isBillingRisk(a: AlertEvent): boolean {
  return BILLING_RISK.test(a.message)
}

/**
 * Stays on screen until the user dismisses it: every error, and a billing
 * risk of any level (the "not rented by this profile, left running" warning
 * among them). The rest are transient toasts. Main's buffer and the store
 * both evict sticky alerts after the rest, and billing risks last of all.
 */
export function isStickyAlert(a: AlertEvent): boolean {
  return a.level === 'error' || isBillingRisk(a)
}

export type InvokeChannel = keyof IpcInvokeMap
export type EventChannel = keyof IpcEventMap

/** The surface preload exposes as `window.api`. */
export interface RendererApi {
  invoke<C extends InvokeChannel>(
    channel: C,
    ...args: IpcInvokeMap[C]['args']
  ): Promise<IpcInvokeMap[C]['result']>
  on<C extends EventChannel>(channel: C, listener: (payload: IpcEventMap[C]) => void): () => void
}
