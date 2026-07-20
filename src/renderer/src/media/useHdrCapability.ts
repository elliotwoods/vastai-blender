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

/**
 * THE HDR invariant, enforced in one place: HDR mode remounts the <video>
 * (key change) with NO CSS filter — any filter forces SDR compositing and
 * clamps HDR. Every video tile must consume this hook.
 */
export function useVideoPresentation(
  hdrMode: boolean,
  filter: string
): { key: string; filterStyle: string | undefined } {
  return useMemo(
    () => ({
      key: hdrMode ? 'hdr' : 'sdr',
      filterStyle: hdrMode ? undefined : filter
    }),
    [hdrMode, filter]
  )
}
