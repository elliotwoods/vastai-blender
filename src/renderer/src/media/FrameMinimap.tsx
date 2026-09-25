/**
 * The whole job at a glance, and the handle that picks which part of it the
 * filmstrip shows.
 *
 * A canvas, drawn the way FrameRuler is (device-pixel-ratio backing store,
 * redrawn on resize, drags coalesced to one update per animation frame): each
 * pixel column takes the worst chunk state under it, with the done part drawn
 * brighter. Over it sits the view window:
 * - drag an edge (6 px handles) to resize it, drag its body to pan;
 * - click outside it to centre it there (and keep dragging to pan);
 * - Ctrl/⌘ + wheel zooms about the cursor, a plain wheel pans;
 * - keyboard: ←/→ pan (Shift for a page), +/− zoom, Home/End, 0 for all.
 *
 * The columns come from segmentsFromChunks, the same segments the job's
 * summary ProgressBar draws, so the two agree frame for frame: a stretch no
 * chunk covers any more (a retry narrowed its chunk to the missing frames)
 * is done on both.
 */

import { useEffect, useMemo, useRef } from 'react'
import {
  segmentsFromChunks,
  type ProgressSegment,
  type SegmentTone
} from '../components/progressSegments'
import { CHUNK_TONE, TOKENS, type StatusTone } from '../lib/theme'
import type { FrameDomain } from './frame-domain'
import {
  clampView,
  dragEdge,
  minimapColumns,
  pan,
  recenter,
  viewSpan,
  wholeView,
  zoomAround,
  type LiveProgress,
  type StateSpan,
  type View
} from './zoom-window'
import type { ChunkSnapshot, ChunkState } from '../../../shared/models'

export type { LiveProgress }

/** Grab width of each view-window edge, px. */
const HANDLE = 6
const HEIGHT = 20

/** A segment's tone as the chunk state the columns are coloured by. */
const STATE_OF: Record<SegmentTone, ChunkState> = {
  done: 'complete',
  working: 'rendering',
  queued: 'pending',
  failed: 'failed',
  cancelled: 'cancelled'
}

/** The bar's segments as the minimap's spans; nothing before the job has chunks. */
function spansFromSegments(segments: readonly ProgressSegment[]): StateSpan[] {
  return segments.map((s) => ({
    from: s.start,
    to: s.start + s.frames - 1,
    state: STATE_OF[s.tone],
    done: s.done
  }))
}

type Drag = { kind: 'from' | 'to'; start: View } | { kind: 'pan'; start: View; grab: number }

function toneOf(state: string | undefined): StatusTone | null {
  if (state == null) return null
  if (state === 'cancelled') return 'dead'
  return (CHUNK_TONE as Partial<Record<string, StatusTone>>)[state] ?? 'queued'
}

export function FrameMinimap({
  domain,
  chunks,
  view,
  onView,
  liveProgress,
  height = HEIGHT
}: {
  domain: FrameDomain
  chunks?: ChunkSnapshot[]
  view: View
  onView: (view: View) => void
  liveProgress?: LiveProgress
  height?: number
}): React.JSX.Element {
  const count = domain.count
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const spans = useMemo(
    () =>
      chunks && chunks.length > 0
        ? spansFromSegments(
            segmentsFromChunks(chunks, liveProgress, {
              frameStart: domain.start,
              frameEnd: domain.end,
              frameStep: domain.step
            })
          )
        : [],
    [domain, chunks, liveProgress]
  )

  // Native listeners (wheel must be non-passive) and rAF callbacks read the
  // latest props through here rather than re-binding on every change. Synced
  // in an effect, never during render; the wheel also writes its own result
  // here so a burst of wheel events between renders accumulates.
  const latest = useRef({ view, onView, count })
  useEffect(() => {
    latest.current = { view, onView, count }
  }, [view, onView, count])

  const dragRef = useRef<{ drag: Drag | null; pendingX: number | null; raf: number }>({
    drag: null,
    pendingX: null,
    raf: 0
  })

  // -- drawing ---------------------------------------------------------------

  // Primitives, so a parent that rebuilds an equal view object each render
  // does not repaint the canvas each render.
  const vFrom = view.from
  const vTo = view.to

  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    let raf = 0

    const draw = (): void => {
      raf = 0
      const dpr = window.devicePixelRatio || 1
      const w = Math.max(1, wrap.clientWidth)
      const h = height
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)

      const css = getComputedStyle(document.documentElement)
      const v = (name: string, fallback: string): string =>
        css.getPropertyValue(name).trim() || fallback
      const surface = v('--surface-raised', '#16181c')
      const accent = v('--accent', '#a3e635')
      const accentSoft = v('--accent-soft-bg', 'rgba(163,230,53,0.12)')
      const tone = (t: StatusTone, part: 'fill' | 'border'): string =>
        v(`--status-${t}-${part}`, part === 'fill' ? '#23262b' : '#3a3e46')

      ctx.fillStyle = surface
      ctx.fillRect(0, 0, w, h)

      const cols = minimapColumns(count, spans, Math.floor(w))
      for (let c = 0; c < cols.length; c++) {
        const t = toneOf(cols[c].state)
        if (!t) continue
        // The dead tone's fill is near the surface colour; cancelled columns
        // use its border so they read as "stopped", not "empty".
        ctx.globalAlpha = 1
        ctx.fillStyle = tone(t, t === 'dead' ? 'border' : 'fill')
        ctx.fillRect(c, 0, 1, h)
        if (cols[c].doneFrac > 0 && t !== 'dead') {
          ctx.globalAlpha = cols[c].doneFrac
          ctx.fillStyle = tone(t === 'queued' ? 'done' : t, 'border')
          ctx.fillRect(c, 0, 1, h)
        }
      }
      ctx.globalAlpha = 1

      if (count <= 0) return
      const cur = clampView({ from: vFrom, to: vTo }, count)
      const x0 = (cur.from / count) * w
      const x1 = Math.max(x0 + 2, ((cur.to + 1) / count) * w)
      // Dim what is out of view, tint what is in it.
      ctx.fillStyle = 'rgba(0,0,0,0.45)'
      ctx.fillRect(0, 0, x0, h)
      ctx.fillRect(x1, 0, w - x1, h)
      ctx.fillStyle = accentSoft
      ctx.fillRect(x0, 0, x1 - x0, h)
      ctx.strokeStyle = accent
      ctx.lineWidth = 1
      ctx.strokeRect(Math.round(x0) + 0.5, 0.5, Math.max(1, Math.round(x1 - x0) - 1), h - 1)
      ctx.fillStyle = accent
      const hw = Math.min(HANDLE / 2, (x1 - x0) / 4)
      ctx.fillRect(x0, 0, hw, h)
      ctx.fillRect(x1 - hw, 0, hw, h)
    }

    const schedule = (): void => {
      if (!raf) raf = requestAnimationFrame(draw)
    }
    draw()
    const ro = new ResizeObserver(schedule)
    ro.observe(wrap)
    return () => {
      ro.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [count, spans, vFrom, vTo, height])

  // -- geometry --------------------------------------------------------------

  /** Fractional domain position under a client x. */
  const posAt = (clientX: number): number => {
    const rect = wrapRef.current!.getBoundingClientRect()
    const t = (clientX - rect.left) / Math.max(1, rect.width)
    return Math.max(0, Math.min(1, t)) * count
  }

  const hitTest = (clientX: number): 'from' | 'to' | 'body' | 'outside' => {
    const rect = wrapRef.current!.getBoundingClientRect()
    const cur = clampView(latest.current.view, count)
    const x = clientX - rect.left
    const x0 = (cur.from / count) * rect.width
    const x1 = ((cur.to + 1) / count) * rect.width
    // On a narrow window the handles would overlap the body entirely; give
    // the body at least its middle third.
    const grab = Math.min(HANDLE, (x1 - x0) / 3)
    if (Math.abs(x - x0) <= grab) return 'from'
    if (Math.abs(x - x1) <= grab) return 'to'
    if (x > x0 && x < x1) return 'body'
    return 'outside'
  }

  const apply = (clientX: number): void => {
    const d = dragRef.current.drag
    if (!d) return
    const p = posAt(clientX)
    const { onView: emit } = latest.current
    if (d.kind === 'pan') emit(pan(d.start, Math.round(p - d.grab) - d.start.from, count))
    else if (d.kind === 'from') emit(dragEdge(d.start, 'from', Math.round(p), count))
    else emit(dragEdge(d.start, 'to', Math.round(p) - 1, count))
  }

  // -- pointer ---------------------------------------------------------------

  const onPointerDown = (e: React.PointerEvent): void => {
    if (count <= 0 || e.button !== 0) return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    const hit = hitTest(e.clientX)
    let start = clampView(latest.current.view, count)
    if (hit === 'outside') {
      start = recenter(start, Math.floor(posAt(e.clientX)), count)
      latest.current.onView(start)
    }
    dragRef.current.drag =
      hit === 'from' || hit === 'to'
        ? { kind: hit, start }
        : { kind: 'pan', start, grab: posAt(e.clientX) - start.from }
    if (wrapRef.current)
      wrapRef.current.style.cursor = hit === 'from' || hit === 'to' ? 'ew-resize' : 'grabbing'
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    const d = dragRef.current
    if (!d.drag) {
      if (count > 0 && wrapRef.current) {
        const hit = hitTest(e.clientX)
        wrapRef.current.style.cursor =
          hit === 'from' || hit === 'to' ? 'ew-resize' : hit === 'body' ? 'grab' : 'pointer'
      }
      return
    }
    d.pendingX = e.clientX
    if (!d.raf) {
      d.raf = requestAnimationFrame(() => {
        d.raf = 0
        if (d.pendingX != null) apply(d.pendingX)
      })
    }
  }

  const endDrag = (e: React.PointerEvent): void => {
    const d = dragRef.current
    if (!d.drag) return
    if (d.raf) cancelAnimationFrame(d.raf)
    d.raf = 0
    apply(e.clientX)
    d.drag = null
    d.pendingX = null
    if (wrapRef.current) wrapRef.current.style.cursor = 'grab'
  }

  // -- wheel (non-passive, so it can keep the page from scrolling) -----------

  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const onWheel = (e: WheelEvent): void => {
      const { view: cur, onView: emit, count: n } = latest.current
      if (n <= 0) return
      e.preventDefault()
      const rect = wrap.getBoundingClientRect()
      if (e.ctrlKey || e.metaKey) {
        const anchor = ((e.clientX - rect.left) / Math.max(1, rect.width)) * n
        const next = zoomAround(cur, Math.floor(anchor), Math.exp(e.deltaY * 0.0025), n)
        latest.current.view = next
        emit(next)
      } else {
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
        if (d === 0) return
        const step = Math.max(1, Math.round((viewSpan(clampView(cur, n)) * Math.abs(d)) / 400))
        const next = pan(cur, Math.sign(d) * step, n)
        latest.current.view = next
        emit(next)
      }
    }
    wrap.addEventListener('wheel', onWheel, { passive: false })
    return () => wrap.removeEventListener('wheel', onWheel)
  }, [])

  // -- keyboard --------------------------------------------------------------

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (count <= 0) return
    const cur = clampView(view, count)
    const span = viewSpan(cur)
    const mid = Math.floor((cur.from + cur.to) / 2)
    let next: View | null = null
    switch (e.key) {
      case 'ArrowLeft':
        next = pan(cur, -(e.shiftKey ? span : Math.max(1, Math.round(span / 10))), count)
        break
      case 'ArrowRight':
        next = pan(cur, e.shiftKey ? span : Math.max(1, Math.round(span / 10)), count)
        break
      case 'Home':
        next = pan(cur, -count, count)
        break
      case 'End':
        next = pan(cur, count, count)
        break
      case '+':
      case '=':
        next = zoomAround(cur, mid, 0.5, count)
        break
      case '-':
      case '_':
        next = zoomAround(cur, mid, 2, count)
        break
      case '0':
        next = wholeView(count)
        break
    }
    if (next) {
      e.preventDefault()
      onView(next)
    }
  }

  const cur = clampView(view, count)
  return (
    <div
      ref={wrapRef}
      role="scrollbar"
      aria-orientation="horizontal"
      aria-label="Frames in view"
      aria-valuemin={domain.start}
      aria-valuemax={domain.end}
      aria-valuenow={count > 0 ? domain.start + cur.from * domain.step : domain.start}
      aria-valuetext={
        count > 0
          ? `frames ${domain.start + cur.from * domain.step} to ${domain.start + cur.to * domain.step}`
          : 'no frames'
      }
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      style={{
        position: 'relative',
        height,
        minWidth: 80,
        cursor: 'grab',
        touchAction: 'none',
        borderRadius: 2,
        outlineColor: TOKENS.accent
      }}
    >
      <canvas ref={canvasRef} style={{ display: 'block' }} />
    </div>
  )
}
