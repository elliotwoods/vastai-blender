/**
 * Thin typed wrapper over the preload bridge. All renderer code calls
 * `ipc.invoke(...)` / `ipc.on(...)` through here (never window.api directly)
 * so tests can stub one module.
 */

import type { RendererApi } from '../../../shared/ipc'

export const ipc: RendererApi = window.api
