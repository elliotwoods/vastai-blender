/**
 * The typed IPC contract — the single source of truth for every channel that
 * crosses main ↔ renderer. Both sides import from here; adding a channel means
 * adding it to one of these maps (a missing handler or a type mismatch is then
 * a compile error on whichever side is out of date).
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
