/**
 * What the full-window preview overlay is currently showing.
 *
 * A store rather than a `Route` (lib/nav.ts) on purpose: the overlay has to
 * open identically from Fleet, Jobs, JobDetail and Gallery and then return you
 * to an *intact* screen — scroll position, expanded node rows, the gallery
 * wall's playback state. A route would unmount the screen behind it, and
 * Alt+Left would step through preview targets instead of navigating.
 */

import { create } from 'zustand'

export interface PreviewTarget {
  jobId: string
  /** Chunk to open at; the overlay can step to siblings with [ and ]. */
  chunkId: string
  /** Frame to seek to on open, in job frame numbers. */
  frame?: number
}

interface PreviewState {
  target: PreviewTarget | null
  /** Element that opened it, so focus can go back where it came from. */
  opener: HTMLElement | null
  open: (target: PreviewTarget) => void
  /** Change what is shown without re-running the open transition. */
  retarget: (target: PreviewTarget) => void
  close: () => void
}

/**
 * Dev aid, mirroring `?screen=` / `?expand=1`: `?preview=<chunkId>&jobId=<id>`
 * opens the overlay on load, so a VR_SHOT run can capture it. Without this the
 * overlay is only reachable by a click and cannot be screenshotted in a
 * scripted run. `&frame=<n>` (a job frame number) opens at that frame.
 */
function initialTarget(): PreviewTarget | null {
  try {
    const params = new URLSearchParams(window.location.search)
    const chunkId = params.get('preview')
    const jobId = params.get('jobId')
    if (!chunkId || !jobId) return null
    const raw = params.get('frame')
    const frame = raw != null && raw !== '' ? Number(raw) : null
    return { jobId, chunkId, ...(frame != null && Number.isFinite(frame) ? { frame } : {}) }
  } catch {
    // fall through
  }
  return null
}

export const usePreview = create<PreviewState>((set) => ({
  target: initialTarget(),
  opener: null,
  open: (target) =>
    set({
      target,
      opener: document.activeElement instanceof HTMLElement ? document.activeElement : null
    }),
  retarget: (target) => set({ target }),
  close: () => set({ target: null, opener: null })
}))

/** True while the overlay owns the screen — App uses it to gate global keys. */
export function isPreviewOpen(): boolean {
  return usePreview.getState().target != null
}
