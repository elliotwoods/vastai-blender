/**
 * Navigation — a discriminated-union route in a zustand store (no router lib;
 * five screens with occasional params don't justify one, and file:// URLs in
 * production Electron make URL routing awkward). A small history stack backs
 * `back()` (wired to Alt+Left / mouse button 4 in App).
 */

import { create } from 'zustand'
import type { HistoryMetric, HistoryRange } from '../../../shared/models'

export type SettingsSection = 'api' | 'ssh' | 'addons' | 'octane' | 'offers' | 'general'

export type Route =
  | { screen: 'fleet' }
  | { screen: 'jobs' }
  | { screen: 'job'; jobId: string; tab?: 'chunks' | 'logs' }
  | { screen: 'gallery'; jobId?: string; chunkId?: string }
  | { screen: 'history'; metric?: HistoryMetric; range?: HistoryRange }
  | { screen: 'settings'; section?: SettingsSection }
  /** Dev-only measuring instrument, reachable via ?screen=gradelab. */
  | { screen: 'gradelab' }

interface NavState {
  route: Route
  history: Route[]
  navigate: (route: Route) => void
  back: () => void
}

/**
 * Dev aid: `?screen=jobs` etc. in the dev-server URL picks the initial screen;
 * `?screen=settings&section=general` also picks the settings section,
 * `?screen=history&metric=power&range=7d` the history series and window, and
 * `?screen=job&jobId=<id>` a specific job (with VR_MOCK, `job-1`).
 */
function initialRoute(): Route {
  try {
    const params = new URLSearchParams(window.location.search)
    const s = params.get('screen')
    if (s === 'jobs' || s === 'fleet' || s === 'gradelab') return { screen: s }
    if (s === 'gallery') {
      return {
        screen: 'gallery',
        jobId: params.get('jobId') ?? undefined,
        chunkId: params.get('chunkId') ?? undefined
      }
    }
    if (s === 'job') {
      const jobId = params.get('jobId')
      // A job route without an id has nothing to render — fall through to the
      // default rather than mounting a screen that will only ever show
      // "loading".
      if (jobId) return { screen: 'job', jobId }
    }
    if (s === 'settings') {
      const section = params.get('section')
      return { screen: 'settings', section: (section as SettingsSection | null) ?? undefined }
    }
    if (s === 'history') {
      return {
        screen: 'history',
        metric: (params.get('metric') as HistoryMetric | null) ?? undefined,
        range: (params.get('range') as HistoryRange | null) ?? undefined
      }
    }
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
