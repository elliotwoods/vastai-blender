// This preload runs sandboxed (webPreferences.sandbox in main/index.ts), so
// its require() knows only 'electron' and a few Node shims (events, timers,
// url). electron-vite bundles relative imports but leaves package imports as
// require() calls, so importing any npm package here, @electron-toolkit/preload
// included, breaks the window at boot. Type-only imports are fine: they vanish.
import { contextBridge, ipcRenderer } from 'electron'
import type {
  EventChannel,
  IpcEventMap,
  InvokeChannel,
  IpcInvokeMap,
  RendererApi
} from '../shared/ipc'

/**
 * Exactly two generic entry points, typed against the shared contract — no
 * per-channel boilerplate here. Renderer call sites get full typing through
 * `src/renderer/src/lib/ipc.ts`.
 */
const api: RendererApi = {
  invoke: <C extends InvokeChannel>(
    channel: C,
    ...args: IpcInvokeMap[C]['args']
  ): Promise<IpcInvokeMap[C]['result']> => ipcRenderer.invoke(channel, ...args),

  on: <C extends EventChannel>(
    channel: C,
    listener: (payload: IpcEventMap[C]) => void
  ): (() => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: IpcEventMap[C]): void =>
      listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  }
}

contextBridge.exposeInMainWorld('api', api)
