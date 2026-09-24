/**
 * The typed IPC contract — the single source of truth for every channel that
 * crosses main ↔ renderer. Both sides import from here; adding a channel means
 * adding it to one of these maps. A type mismatch is then a compile error on
 * whichever side is out of date, and so is a push channel the renderer does
 * not handle (useIpcEvents is exhaustive over IpcEventMap). An invoke channel
 * with no ipcMain handler is not caught: it fails at runtime.
 */

import type {
  AddonInfo,
  AlertEvent,
  AssetAddedEvent,
  AssetIndex,
  ChunkChangedEvent,
  ChunkProgressEvent,
  FleetCost,
  HistoryRange,
  HistorySummary,
  JobDetail,
  JobSubmission,
  JobSummary,
  LogLineEvent,
  NodeChunkView,
  NodeSnapshot,
  ThumbAsset,
  Offer,
  OfferFilters,
  SecretKey,
  SettingsPublic,
  SshCommandInfo
} from './models'

/** Request/response channels (`ipcRenderer.invoke` ↔ `ipcMain.handle`). */
export interface IpcInvokeMap {
  // settings
  'settings:get': { args: []; result: SettingsPublic }
  'settings:set': { args: [Partial<SettingsPublic>]; result: SettingsPublic }
  'settings:setSecret': { args: [SecretKey, string]; result: void }

  // vast.ai
  'vast:testKey': { args: []; result: { ok: boolean; message: string } }
  'vast:searchOffers': { args: [Partial<OfferFilters> | undefined]; result: Offer[] }

  // fleet / nodes
  'fleet:setMaxNodes': { args: [number]; result: void }
  'fleet:requestNode': { args: []; result: void }
  'fleet:clearFailed': { args: []; result: number }
  'node:destroy': { args: [string]; result: void }
  'node:reprovision': { args: [string]; result: void }
  'node:openVncTunnel': { args: [string]; result: { localPort: number; password: string } }
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
  'job:retryMissing': { args: [string]; result: void }

  // scheduler
  /**
   * Chunks recovered from a previous session whose fleet scale-up is paused
   * pending confirmation, or null when nothing is held.
   */
  'scheduler:recoveryHold': { args: []; result: { chunks: number } | null }
  /** Release that hold and let the fleet scale up for the recovered work. */
  'scheduler:resumeRecovery': { args: []; result: void }

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
 */
export const RESURFACE_MS = 5 * 60_000

/**
 * Whether a window should keep this record out of sight: dismissed, and not
 * fired again at least RESURFACE_MS after that. A window that was open all
 * along brings an alert back by the same rule when its push arrives
 * (alertStore's receive), so one replaying the buffer reaches the same answer.
 */
export function isStillDismissed(r: AlertRecord): boolean {
  return r.dismissedAt !== null && r.lastSeen - r.dismissedAt < RESURFACE_MS
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
