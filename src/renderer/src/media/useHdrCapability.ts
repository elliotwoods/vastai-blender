/**
 * Live HDR display capability: `(dynamic-range: high)` with a change
 * subscription — tracks the window moving between displays and Windows HDR
 * being toggled. (Do NOT use `(video-dynamic-range: high)`: it reports false
 * on setups where HDR video provably works — see docs/hdr-notes.md.)
 */

import { useMemo, useSyncExternalStore } from 'react'

export function useHdrCapability(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia('(dynamic-range: high)')
      mq.addEventListener('change', cb)
      return () => mq.removeEventListener('change', cb)
    },
    () => window.matchMedia('(dynamic-range: high)').matches
  )
}

export type PresentationMode = 'hdr-passthrough' | 'graded-gl' | 'css-filter'

export interface ClipPresentation {
  mode: PresentationMode
  /** React key for the <video>. Tracks the COMPOSITING path, not the grader. */
  key: 'hdr' | 'sdr'
  /** CSS filter for the <video>. Defined in 'css-filter' mode and NOWHERE else. */
  filterStyle: string | undefined
  /** Mount the grading canvas overlay. */
  canvas: boolean
}

/**
 * THE presentation invariant, still enforced in one place — three clauses now
 * that a second grader exists:
 *
 * 1. EXACTLY ONE GRADER. `filterStyle` is defined only in 'css-filter'. In
 *    'graded-gl' the shader IS the grade and a CSS filter would double-apply
 *    it; in 'hdr-passthrough' any filter forces SDR compositing and clamps the
 *    HDR. Returning a union rather than two independent fields makes "filter
 *    set while the canvas is mounted" unrepresentable.
 *
 * 2. THE REMOUNT KEY TRACKS COMPOSITING, NOT GRADING. `key` derives solely
 *    from hdrMode, so it still has only two values across three modes:
 *      - to/from 'hdr-passthrough' the key CHANGES, because Chromium decides
 *        SDR-vs-HDR compositing when the video layer is created and removing a
 *        filter from a live element does not move it back (docs/hdr-notes.md);
 *      - between 'css-filter' and 'graded-gl' the key MUST NOT change. Both are
 *        SDR compositing, and remounting there would restart playback and drop
 *        the controller's frame position every time the grade panel is
 *        toggled — a visible regression for a change the compositor ignores.
 *
 * 3. THE <video> ALWAYS RENDERS. 'graded-gl' occludes it with an opaque canvas
 *    rather than hiding it — see GradeCanvas for why.
 *
 * What replaced the old "HDR ⇒ filter none" rule: the filter is now absent in
 * two of three modes, so "HDR is special" is no longer the rule. The rule is
 * "one grader per surface, and the compositing path owns the key".
 */
export function useClipPresentation({
  hdrMode,
  graded,
  filter
}: {
  hdrMode: boolean
  /** Caller wants the shader AND it is available (GL alive, not failed). */
  graded: boolean
  filter: string
}): ClipPresentation {
  return useMemo(() => {
    // HDR passthrough beats grading when both are requested — matching the
    // inspector's existing "HDR passthrough (disables grading)" affordance.
    if (hdrMode) {
      return { mode: 'hdr-passthrough', key: 'hdr', filterStyle: undefined, canvas: false }
    }
    if (graded) {
      return { mode: 'graded-gl', key: 'sdr', filterStyle: undefined, canvas: true }
    }
    return { mode: 'css-filter', key: 'sdr', filterStyle: filter, canvas: false }
  }, [hdrMode, graded, filter])
}
