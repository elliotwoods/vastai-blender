/**
 * Navigation — a discriminated-union route in a zustand store (no router lib;
 * five screens with occasional params don't justify one, and file:// URLs in
 * production Electron make URL routing awkward). A small history stack backs
 * `back()` (wired to Alt+Left / mouse button 4 in App).
 */

import { create } from 'zustand'

export type SettingsSection = 'api' | 'ssh' | 'addons' | 'octane' | 'offers' | 'general'

export type Route =
  | { screen: 'fleet' }
  | { screen: 'jobs' }
  | { screen: 'job'; jobId: string; tab?: 'chunks' | 'logs' }
  | { screen: 'gallery'; jobId?: string; chunkId?: string }
  | { screen: 'settings'; section?: SettingsSection }

interface NavState {
  route: Route
  history: Route[]
  navigate: (route: Route) => void
  back: () => void
}

/** Dev aid: `?screen=jobs` etc. in the dev-server URL picks the initial screen. */
function initialRoute(): Route {
  try {
    const s = new URLSearchParams(window.location.search).get('screen')
    if (s === 'jobs' || s === 'fleet' || s === 'gallery') return { screen: s }
    if (s === 'settings') return { screen: 'settings' }
  } catch {
    // fall through
  }
  return { screen: 'fleet' }
}

export const useNav = create<NavState>((set) => ({
  route: initialRoute(),
  history: [],
  navigate: (route) => set((s) => ({ route, history: [...s.history.slice(-49), s.route] })),
  back: () =>
    set((s) => {
      const prev = s.history[s.history.length - 1]
      if (!prev) return s
      return { route: prev, history: s.history.slice(0, -1) }
    })
}))
