/**
 * Whether a CSS media query matches, kept current as it changes: the job
 * detail's sidebar at `(min-width: 1280px)`, motion under
 * `(prefers-reduced-motion: reduce)`. useSyncExternalStore over matchMedia,
 * so every caller of one query agrees within a render. With no window (a
 * server render, a test) it is false.
 */

import { useCallback, useSyncExternalStore } from 'react'

function mediaList(query: string): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null
  return window.matchMedia(query)
}

/** Whether `query` matches now; false with no window. */
export function matchesMedia(query: string): boolean {
  return mediaList(query)?.matches ?? false
}

/** Call `onChange` whenever `query` starts or stops matching; returns the unsubscribe. */
export function subscribeMedia(query: string, onChange: () => void): () => void {
  const list = mediaList(query)
  if (!list) return () => {}
  list.addEventListener('change', onChange)
  return () => list.removeEventListener('change', onChange)
}

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((cb: () => void) => subscribeMedia(query, cb), [query])
  return useSyncExternalStore(
    subscribe,
    () => matchesMedia(query),
    () => false
  )
}
