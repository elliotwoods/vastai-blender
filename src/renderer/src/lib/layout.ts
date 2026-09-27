/**
 * Narrow-window layout. Two tools: a window breakpoint for chrome that
 * changes shape (the toolbar, the settings menu), and `fitColumns` for the
 * tables, which measure their own panel and drop their least useful columns
 * rather than squeezing every cell until the names vanish.
 */

import { useCallback, useRef, useState } from 'react'
import { useMediaQuery } from './useMediaQuery'

/** Below this the window is a phone-width strip beside other work. */
export const NARROW_QUERY = '(max-width: 640px)'

/** Whether the window is narrow (NARROW_QUERY); false with no window. */
export function useNarrow(): boolean {
  return useMediaQuery(NARROW_QUERY)
}

export interface FitColumn<K extends string = string> {
  key: K
  /** Width the column takes, gap included. */
  width: number
  /** Lower goes first. Omitted: always shown. */
  drop?: number
}

/**
 * The columns that fit in `available` px, dropping the lowest `drop` first
 * until what is left fits (or only the undroppable ones remain). An
 * unmeasured width (0: before the first layout, or under jsdom) shows every
 * column, so a table never starts out stripped.
 */
export function fitColumns<K extends string>(
  available: number,
  columns: readonly FitColumn<K>[]
): Set<K> {
  const shown = new Set(columns.map((c) => c.key))
  if (available <= 0) return shown
  let total = columns.reduce((sum, c) => sum + c.width, 0)
  const droppable = columns
    .filter((c) => c.drop != null)
    .sort((a, b) => (a.drop as number) - (b.drop as number))
  for (const c of droppable) {
    if (total <= available) break
    shown.delete(c.key)
    total -= c.width
  }
  return shown
}

/**
 * A callback ref and the width (clientWidth, px) of whatever it is attached
 * to, kept current by a ResizeObserver; 0 while nothing is attached. A
 * callback rather than an object ref so an element that mounts late (a
 * table that waits for its data) is measured when it arrives.
 */
export function useMeasuredWidth<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [width, setWidth] = useState(0)
  const observer = useRef<ResizeObserver | null>(null)
  const ref = useCallback((el: T | null) => {
    observer.current?.disconnect()
    observer.current = null
    if (!el) {
      setWidth(0)
      return
    }
    setWidth(el.clientWidth)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    observer.current = ro
  }, [])
  return [ref, width]
}
