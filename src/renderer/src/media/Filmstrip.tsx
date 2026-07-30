/**
 * Horizontal strip of frame thumbnails across a job's whole frame domain.
 *
 * Windowed the same way LogPanel is (fixed cell metric, absolute positions
 * inside a spacer, re-window on scroll) rather than with a virtualiser
 * dependency — a job can be thousands of frames, and the codebase already
 * established this idiom.
 *
 * Indexed by the frame domain, not by the assets that exist: a cell with no
 * thumbnail IS the gap, tinted with its owning chunk's status so it says *why*
 * it is empty rather than merely that it is.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { mono } from '../lib/controls'
import { useThumbWindow } from '../lib/queries'
import { SCALE, TOKENS } from '../lib/theme'
import { chunkRange, domainOf, frameAt, indexOf } from './frame-domain'
import { Thumb } from './Thumb'
import type { ChunkSnapshot, ChunkState } from '../../../shared/models'

const CELL_W = 76
const CELL_H = 44
const GAP = 2
const STRIDE = CELL_W + GAP
/** Cells rendered beyond the viewport on each side, to cover fast scrolls. */
const OVERSCAN = 6

export function Filmstrip({
  jobId,
  frameStart,
  frameEnd,
  frameStep,
  chunks,
  currentFrame,
  onSelect,
  onOpen,
  height = CELL_H + 12
}: {
  jobId: string
  frameStart: number
  frameEnd: number
  frameStep: number
  /** Used only to tint gaps with the owning chunk's state. */
  chunks?: ChunkSnapshot[]
  /** Frame number to highlight and keep in view. */
  currentFrame?: number
  onSelect?: (frame: number) => void
  onOpen?: (frame: number) => void
  height?: number
}): React.JSX.Element {
  const domain = useMemo(
    () => domainOf(frameStart, frameEnd, frameStep),
    [frameStart, frameEnd, frameStep]
  )
  const scrollRef = useRef<HTMLDivElement>(null)
  const [range, setRange] = useState({ from: 0, to: 40 })

  const rafRef = useRef(0)

  const rewindow = (): void => {
    const el = scrollRef.current
    if (!el) return
    const from = Math.max(0, Math.floor(el.scrollLeft / STRIDE) - OVERSCAN)
    const visible = Math.ceil(el.clientWidth / STRIDE) + OVERSCAN * 2
    const next = { from, to: Math.min(domain.count, from + visible) }
    // Bail when nothing moved: a ResizeObserver callback that always setStates
    // re-enters the observer and Chromium reports "ResizeObserver loop
    // completed with undelivered notifications" every frame.
    setRange((prev) => (prev.from === next.from && prev.to === next.to ? prev : next))
  }

  /** rAF-coalesced, so a burst of scroll/resize events costs one re-window. */
  const scheduleRewindow = (): void => {
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      rewindow()
    })
  }

  // Re-window when the element sizes itself, not just on scroll — the strip is
  // often laid out after its first render (drawer opening, panel resize).
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    rewindow()
    const ro = new ResizeObserver(scheduleRewindow)
    ro.observe(el)
    return () => {
      ro.disconnect()
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domain.count])

  // Keep the playhead cell in view while scrubbing.
  useEffect(() => {
    if (currentFrame == null) return
    const el = scrollRef.current
    if (!el) return
    const x = indexOf(domain, currentFrame) * STRIDE
    if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - CELL_W) {
      el.scrollTo({ left: Math.max(0, x - el.clientWidth / 2), behavior: 'smooth' })
    }
  }, [currentFrame, domain])

  const thumbs = useThumbWindow(jobId, frameAt(domain, range.from), frameAt(domain, range.to))

  // Frame → owning chunk state, for gap tinting. Built from the visible window
  // only; chunks outside the domain (a stale row after requeue narrowed it)
  // resolve to null rather than painting a band at index 0.
  const stateAt = useMemo(() => {
    const spans: Array<{ from: number; to: number; state: ChunkState }> = []
    for (const c of chunks ?? []) {
      const r = chunkRange(domain, c.frameStart, c.frameEnd)
      if (r) spans.push({ ...r, state: c.state })
    }
    return (i: number): ChunkState | undefined => spans.find((s) => i >= s.from && i <= s.to)?.state
  }, [chunks, domain])

  const cells: React.JSX.Element[] = []
  for (let i = range.from; i < range.to; i++) {
    const frame = frameAt(domain, i)
    const url = thumbs.get(frame) ?? null
    cells.push(
      <div key={i} style={{ position: 'absolute', left: i * STRIDE, top: 0 }}>
        <Thumb
          url={url}
          width={CELL_W}
          height={CELL_H}
          state={stateAt(i)}
          label={String(frame)}
          title={url ? `frame ${frame}` : `frame ${frame} — not rendered yet`}
          selected={currentFrame === frame}
          onClick={onSelect ? () => onSelect(frame) : undefined}
          onDoubleClick={onOpen ? () => onOpen(frame) : undefined}
        />
      </div>
    )
  }

  if (domain.count === 0) {
    return (
      <span style={{ ...mono, fontSize: SCALE.textXs, color: TOKENS.textFaint }}>
        No frames in this job.
      </span>
    )
  }

  return (
    <div
      ref={scrollRef}
      onScroll={scheduleRewindow}
      onWheel={(e) => {
        // A horizontal strip inside a vertically-scrolling page: map vertical
        // wheel to horizontal, or the strip is unreachable on a normal mouse.
        if (e.deltaY !== 0 && e.deltaX === 0 && scrollRef.current) {
          scrollRef.current.scrollLeft += e.deltaY
        }
      }}
      style={{
        position: 'relative',
        overflowX: 'auto',
        overflowY: 'hidden',
        height,
        flexShrink: 0
      }}
    >
      <div style={{ position: 'relative', width: domain.count * STRIDE, height: CELL_H }}>
        {cells}
      </div>
    </div>
  )
}
