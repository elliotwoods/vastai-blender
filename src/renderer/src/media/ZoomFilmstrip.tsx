/**
 * A job's frames as a zoomable film strip: a minimap of the whole job, with a
 * window you drag and resize, over a row of thumbnails for what is in that
 * window.
 *
 * The row never scrolls. When the window holds more frames than fit at the
 * minimum cell width, the row shows every Nth frame instead, and says so in a
 * chip that is always there: "all frames · 1–240" when nothing is skipped,
 * "every 12th frame · 1–5000" (warn colour) when something is, with a button
 * that zooms in until nothing is. Sampled cells are drawn as a small stack of
 * cards, so a skipped frame is never mistaken for a missing one.
 *
 * Props mirror Filmstrip's, so it can replace it where that is used.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { btn, mono } from '../lib/controls'
import { useThumbWindow } from '../lib/queries'
import { SCALE, TOKENS } from '../lib/theme'
import { domainOf, frameAt, indexOf } from './frame-domain'
import { FrameMinimap } from './FrameMinimap'
import { Thumb, type ThumbState } from './Thumb'
import {
  CELL_GAP,
  chunkSpans,
  clampView,
  defaultView,
  fitAllView,
  layoutStrip,
  ordinal,
  recenter,
  sampledIndices,
  worstState,
  type LiveProgress,
  type View
} from './zoom-window'
import type { ChunkSnapshot } from '../../../shared/models'

const CELL_H = 56
/** Width assumed before the row has been measured (and in server renders). */
const DEFAULT_WIDTH = 960
/** Room above and right of the row for the stacked-card edge. */
const ROW_PAD = 4

export function ZoomFilmstrip({
  jobId,
  frameStart,
  frameEnd,
  frameStep,
  chunks,
  currentFrame,
  onSelect,
  onOpen,
  height = CELL_H,
  liveProgress,
  initialView,
  initialWidth = DEFAULT_WIDTH
}: {
  jobId: string
  frameStart: number
  frameEnd: number
  frameStep: number
  /** Colours the minimap and tints gaps with the owning chunk's state. */
  chunks?: ChunkSnapshot[]
  /** Frame number to highlight and keep in view. */
  currentFrame?: number
  onSelect?: (frame: number) => void
  onOpen?: (frame: number) => void
  /** Thumbnail row height, px (the minimap and chip sit above it). */
  height?: number
  /** Live rendered counts by chunk id (progressStore's `byChunk`). */
  liveProgress?: LiveProgress
  /** Opening view in domain indices; default: see defaultView. */
  initialView?: View
  /** Row width assumed until it is measured. */
  initialWidth?: number
}): React.JSX.Element {
  const domain = useMemo(
    () => domainOf(frameStart, frameEnd, frameStep),
    [frameStart, frameEnd, frameStep]
  )
  const count = domain.count
  const spans = useMemo(
    () => chunkSpans(domain, chunks, liveProgress),
    [domain, chunks, liveProgress]
  )

  // null until the user moves the window: until then the view follows the
  // default (the newest frames done), so a strip opened before the chunks
  // loaded, or while frames are landing, still opens somewhere useful.
  const [picked, setPicked] = useState<View | null>(initialView ?? null)
  const view = clampView(picked ?? defaultView(count, spans), count)
  const setView = (v: View): void => setPicked(clampView(v, count))

  // -- width -----------------------------------------------------------------

  const rowRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(initialWidth)
  useEffect(() => {
    const el = rowRef.current
    if (!el) return
    let raf = 0
    const measure = (): void => {
      raf = 0
      const w = el.clientWidth - ROW_PAD
      // Bail when unchanged: see Filmstrip on ResizeObserver loops.
      if (w > 0) setWidth((prev) => (prev === w ? prev : w))
    }
    measure()
    const ro = new ResizeObserver(() => {
      if (!raf) raf = requestAnimationFrame(measure)
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])

  // Keep the playhead in view: when it leaves the window, move the window.
  // The view is read through a ref (synced first) so that panning away from
  // the playhead does not snap straight back to it.
  const viewRef = useRef(view)
  useEffect(() => {
    viewRef.current = view
  })
  useEffect(() => {
    if (currentFrame == null || count === 0) return
    const i = indexOf(domain, currentFrame)
    const v = viewRef.current
    if (i < v.from || i > v.to) setPicked(recenter(v, i, count))
  }, [currentFrame, domain, count])

  // -- layout ----------------------------------------------------------------

  const span = view.to - view.from + 1
  const layout = layoutStrip(span, width)
  const indices = sampledIndices(view, layout.stride)
  const frameStride = layout.stride * domain.step
  const firstFrame = frameAt(domain, view.from)
  const lastFrame = frameAt(domain, view.to)

  const thumbs = useThumbWindow(jobId, firstFrame, lastFrame)

  /** Worst state among the frames a cell stands for, [i, i + stride). */
  const stateOf = (i: number): ThumbState | undefined => {
    const end = Math.min(view.to, i + layout.stride - 1)
    return worstState(
      spans.filter((s) => s.from <= end && s.to >= i).map((s) => s.state as ThumbState)
    )
  }

  if (count === 0) {
    return (
      <span style={{ ...mono, fontSize: SCALE.textXs, color: TOKENS.textFaint }}>
        No frames in this job.
      </span>
    )
  }

  // -- keyboard: ←/→ step the selection through the cells, Enter opens -------

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (indices.length === 0) return
    const frames = indices.map((i) => frameAt(domain, i))
    let at = -1
    for (let k = 0; k < frames.length && currentFrame != null; k++) {
      if (frames[k] <= currentFrame) at = k
    }
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      if (!onSelect) return
      e.preventDefault()
      const next =
        e.key === 'ArrowRight'
          ? Math.min(frames.length - 1, at + 1)
          : Math.max(0, at < 0 ? 0 : at - 1)
      onSelect(frames[next])
    } else if (e.key === 'Enter' && onOpen && currentFrame != null) {
      e.preventDefault()
      onOpen(currentFrame)
    }
  }

  const cells = indices.map((i) => {
    const frame = frameAt(domain, i)
    const lastOfCell = frameAt(domain, Math.min(view.to, i + layout.stride - 1))
    const url = thumbs.get(frame) ?? null
    const state = stateOf(i)
    const selected =
      currentFrame != null &&
      (layout.sampled
        ? currentFrame >= frame && currentFrame <= lastOfCell
        : currentFrame === frame)
    const what = layout.sampled
      ? `frames ${frame}–${lastOfCell}, showing ${frame}`
      : `frame ${frame}`
    return (
      <div
        key={i}
        data-cell={frame}
        style={{
          flexShrink: 0,
          borderRadius: SCALE.radiusSm,
          // A sampled cell stands for several frames: draw it as the top card
          // of a small stack.
          boxShadow: layout.sampled
            ? `2px -2px 0 -1px ${TOKENS.surfaceRaised}, 2px -2px 0 0 ${TOKENS.borderStrong}, 4px -4px 0 -1px ${TOKENS.surfaceRaised}, 4px -4px 0 0 ${TOKENS.border}`
            : undefined
        }}
      >
        <Thumb
          url={url}
          width={layout.cellW}
          height={height}
          state={state}
          label={String(frame)}
          title={
            url
              ? what
              : state === 'cancelled'
                ? `${what} — cancelled`
                : `${what} — not rendered yet`
          }
          selected={selected}
          onClick={onSelect ? () => onSelect(frame) : undefined}
          onDoubleClick={onOpen ? () => onOpen(frame) : undefined}
        />
      </div>
    )
  })

  const chipText = `${layout.sampled ? `every ${ordinal(frameStride)} frame` : 'all frames'} · ${firstFrame}–${lastFrame}`
  const chipTone = layout.sampled
    ? { background: TOKENS.warnSoftBg, border: TOKENS.warnSoftBorder, color: TOKENS.warnSoftText }
    : { background: TOKENS.surfaceRaised, border: TOKENS.border, color: TOKENS.textSecondary }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SCALE.space2, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: SCALE.space2, minWidth: 0 }}>
        <span
          data-testid="zoom-chip"
          data-sampled={layout.sampled ? 'true' : 'false'}
          role="status"
          style={{
            ...mono,
            flexShrink: 0,
            fontSize: SCALE.text2xs,
            padding: '1px 6px',
            borderRadius: SCALE.radiusPill,
            border: `1px solid ${chipTone.border}`,
            background: chipTone.background,
            color: chipTone.color,
            whiteSpace: 'nowrap'
          }}
        >
          {chipText}
        </span>
        {layout.sampled ? (
          <button
            type="button"
            style={{ ...btn({ size: 'sm', variant: 'ghost' }), flexShrink: 0 }}
            onClick={() => setView(fitAllView(view, width, count))}
          >
            zoom to all frames
          </button>
        ) : null}
        <div style={{ flex: 1, minWidth: 80 }}>
          <FrameMinimap
            domain={domain}
            chunks={chunks}
            view={view}
            onView={setView}
            liveProgress={liveProgress}
          />
        </div>
      </div>
      <div
        ref={rowRef}
        role="group"
        aria-label={
          layout.sampled
            ? `Every ${ordinal(frameStride)} frame from ${firstFrame} to ${lastFrame}`
            : `Frames ${firstFrame} to ${lastFrame}`
        }
        tabIndex={0}
        onKeyDown={onKeyDown}
        style={{
          display: 'flex',
          gap: CELL_GAP,
          overflow: 'hidden',
          // Room for the stacked-card edge above the cells.
          padding: `${ROW_PAD}px ${ROW_PAD}px 0 0`,
          height: height + ROW_PAD,
          flexShrink: 0,
          outlineColor: TOKENS.accent
        }}
      >
        {cells}
      </div>
    </div>
  )
}
