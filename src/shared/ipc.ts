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
  ChunkProgressEvent,
  FleetCost,
  JobDetail,
  JobSubmission,
  JobSummary,
  LogLineEvent,
  NodeSnapshot,
  Offer,
  OfferFilters,
  SecretKey,
  SettingsPublic
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
  'nodes:list': { args: []; result: NodeSnapshot[] }

  // jobs
  'jobs:list': { args: []; result: JobSummary[] }
  'job:get': { args: [string]; result: JobDetail | null }
  'job:create': { args: [JobSubmission]; result: { jobId: string } }
  'job:cancel': { args: [string]; result: void }
  'job:retryMissing': { args: [string]; result: void }

  // addons
  'addons:list': { args: []; result: AddonInfo[] }
  'addon:register': { args: [string]; result: AddonInfo }
  'addon:remove': { args: [string]; result: void }

  // assets
  'assets:index': { args: [string]; result: AssetIndex }

  // logs
  'logs:getTail': { args: [{ nodeId?: string; chunkId?: string; lines: number }]; result: string[] }

  // shell / dialogs
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
