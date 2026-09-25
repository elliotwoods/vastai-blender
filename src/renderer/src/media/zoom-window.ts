/**
 * The zoom window over a job's frame strip: which span of the frame domain is
 * in view, and how that span is laid out as thumbnail cells.
 *
 * Pure. Everything here is in FrameDomain INDEX space (0..count-1, see
 * frame-domain.ts), never frame numbers, so step and start offsets are the
 * caller's business once, at the edges.
 *
 * The strip never scrolls. When the view holds more frames than fit at the
 * minimum cell width, it shows every Nth frame instead, and says so: the
 * difference between "these are all the frames" and "this is a sample" must
 * be visible, or a gap between two sampled cells reads as a gap in the render.
 */

import { chunkRange, type FrameDomain } from './frame-domain'
import type { ChunkSnapshot, ChunkState } from '../../../shared/models'

/** Inclusive index range in view. */
export interface View {
  from: number
  to: number
}

/** The fewest frames a view may hold (fewer when the job itself is shorter). */
export const MIN_SPAN = 8
/** Cell width bounds, px. */
export const MIN_CELL = 56
export const MAX_CELL = 180
/** Gap between cells, px. */
export const CELL_GAP = 2

/**
 * A chunk state as the strip sees it. `'cancelled'` is spelled out because the
 * backend may add it to ChunkState; any other unknown string is tolerated too.
 */
export type StripState = ChunkState | 'cancelled'

export function viewSpan(view: View): number {
  return Math.max(0, view.to - view.from + 1)
}

function minSpan(count: number): number {
  return Math.max(1, Math.min(MIN_SPAN, count))
}

function toInt(n: number, fallback: number): number {
  return Number.isFinite(n) ? Math.round(n) : fallback
}

/** A view spanning `span` frames starting at `from`, shifted to fit the domain. */
function place(from: number, span: number, count: number): View {
  const s = Math.max(minSpan(count), Math.min(count, span))
  const f = Math.max(0, Math.min(count - s, from))
  return { from: f, to: f + s - 1 }
}

/**
 * Integer, ordered, inside [0, count-1], and at least MIN_SPAN wide. A view
 * that runs off an end is shifted back rather than truncated, so its span is
 * kept wherever it can be.
 */
export function clampView(view: View, count: number): View {
  if (count <= 0) return { from: 0, to: -1 }
  let from = toInt(view.from, 0)
  let to = toInt(view.to, count - 1)
  if (to < from) [from, to] = [to, from]
  return place(from, to - from + 1, count)
}

/** The whole job. */
export function wholeView(count: number): View {
  return clampView({ from: 0, to: count - 1 }, count)
}

/**
 * Move one edge to `idx`, leaving the other where it is. The edge stops
 * MIN_SPAN short of the other one rather than crossing it.
 */
export function dragEdge(view: View, edge: 'from' | 'to', idx: number, count: number): View {
  if (count <= 0) return { from: 0, to: -1 }
  const v = clampView(view, count)
  const m = minSpan(count)
  const i = toInt(idx, edge === 'from' ? v.from : v.to)
  if (edge === 'from') {
    const from = Math.max(0, Math.min(v.to - m + 1, i))
    return { from, to: Math.max(v.to, from + m - 1) }
  }
  const to = Math.min(count - 1, Math.max(v.from + m - 1, i))
  return { from: Math.min(v.from, to - m + 1), to }
}

/** Shift the view by `delta` frames, keeping its span; stops at the ends. */
export function pan(view: View, delta: number, count: number): View {
  if (count <= 0) return { from: 0, to: -1 }
  const v = clampView(view, count)
  return place(v.from + toInt(delta, 0), viewSpan(v), count)
}

/**
 * Scale the span by `factor` (<1 zooms in, >1 out), keeping `anchor` at the
 * same relative position in the view, as a map zooms about the cursor.
 */
export function zoomAround(view: View, anchor: number, factor: number, count: number): View {
  if (count <= 0) return { from: 0, to: -1 }
  const v = clampView(view, count)
  const span = viewSpan(v)
  const f = Number.isFinite(factor) && factor > 0 ? factor : 1
  let next = Math.round(span * f)
  // A factor near 1 on a small span would round back to the same span and
  // the wheel would appear stuck: always move at least one frame.
  if (next === span && f !== 1) next = f < 1 ? span - 1 : span + 1
  next = Math.max(minSpan(count), Math.min(count, next))
  const a = Math.max(v.from, Math.min(v.to, toInt(anchor, v.from)))
  const t = span > 1 ? (a - v.from) / (span - 1) : 0.5
  return place(Math.round(a - t * (next - 1)), next, count)
}

/** Centre the view on `center`, keeping its span. */
export function recenter(view: View, center: number, count: number): View {
  if (count <= 0) return { from: 0, to: -1 }
  const v = clampView(view, count)
  const span = viewSpan(v)
  return place(Math.round(toInt(center, v.from) - (span - 1) / 2), span, count)
}

export interface StripLayout {
  /** Cell width, px. */
  cellW: number
  /** Show every `stride`th frame; 1 = every frame. */
  stride: number
  /** True when frames are being skipped. */
  sampled: boolean
  /** Cells that fit (the most sampledIndices can return). */
  cells: number
}

/** How many MIN_CELL cells fit in `widthPx` (at least one). */
export function stripSlots(widthPx: number): number {
  const width = Math.max(0, Number.isFinite(widthPx) ? widthPx : 0)
  return Math.max(1, Math.floor((width + CELL_GAP) / (MIN_CELL + CELL_GAP)))
}

/**
 * The widest view that shows every frame at `widthPx`, centred where `view`
 * is: what "zoom to all frames" goes to.
 */
export function fitAllView(view: View, widthPx: number, count: number): View {
  if (count <= 0) return { from: 0, to: -1 }
  const v = clampView(view, count)
  const span = Math.min(viewSpan(v), stripSlots(widthPx))
  const mid = (v.from + v.to) / 2
  return place(Math.round(mid - (span - 1) / 2), span, count)
}

/**
 * Lay `viewCount` frames into `widthPx`. When every frame fits at MIN_CELL,
 * all are shown, as wide as the space allows up to MAX_CELL. Otherwise every
 * `stride`th frame is shown, the smallest stride that fits.
 */
export function layoutStrip(viewCount: number, widthPx: number): StripLayout {
  const count = Math.max(0, Math.floor(viewCount))
  const width = Math.max(0, Number.isFinite(widthPx) ? widthPx : 0)
  const slots = stripSlots(width)
  if (count === 0) return { cellW: MIN_CELL, stride: 1, sampled: false, cells: 0 }
  const stride = count <= slots ? 1 : Math.ceil(count / slots)
  const cells = Math.ceil(count / stride)
  const fit = Math.floor((width + CELL_GAP) / cells) - CELL_GAP
  const cellW = Math.max(MIN_CELL, Math.min(MAX_CELL, fit))
  return { cellW, stride, sampled: stride > 1, cells }
}

/**
 * The indices shown for a view at a stride: multiples of the stride, so a
 * pan by one frame does not reshuffle every cell's thumbnail. With stride 1,
 * every index in the view.
 */
export function sampledIndices(view: View, stride: number): number[] {
  const s = Math.max(1, Math.floor(stride) || 1)
  if (view.to < view.from) return []
  const out: number[] = []
  for (let i = Math.ceil(view.from / s) * s; i <= view.to; i += s) out.push(i)
  return out
}

/**
 * How bad a state is, for summarising many frames in one pixel or one sampled
 * cell: failed > cancelled > working > queued > complete. Unknown strings rank
 * with queued, so a new backend state shows as "not done" rather than "done".
 */
export function stateRank(state: string): number {
  switch (state) {
    case 'failed':
      return 4
    case 'cancelled':
      return 3
    case 'rendering':
    case 'encoding':
    case 'downloading':
      return 2
    case 'complete':
      return 0
    default:
      return 1
  }
}

/** The worst of several states (see stateRank), or undefined for none. */
export function worstState<S extends string>(states: Iterable<S | undefined>): S | undefined {
  let worst: S | undefined
  for (const s of states) {
    if (s == null) continue
    if (worst === undefined || stateRank(s) > stateRank(worst)) worst = s
  }
  return worst
}

// -- minimap columns ---------------------------------------------------------

export interface StateSpan {
  /** Inclusive index range. */
  from: number
  to: number
  state: string
  /** Frames of this span done; assumed to be its first ones (renders run in order). */
  done: number
}

export interface MinimapColumn {
  state: string | undefined
  /** 0..1 of the column's covered frames that are done. */
  doneFrac: number
}

/**
 * Summarise `count` frames into `columns` pixel columns: each column's worst
 * state, and how much of it is done. A column narrower than a frame (short
 * jobs, wide minimaps) takes the frame under it.
 */
export function minimapColumns(
  count: number,
  spans: StateSpan[],
  columns: number
): MinimapColumn[] {
  const cols = Math.max(0, Math.floor(columns))
  const out: MinimapColumn[] = []
  const covered = new Array<number>(cols).fill(0)
  const done = new Array<number>(cols).fill(0)
  for (let c = 0; c < cols; c++) out.push({ state: undefined, doneFrac: 0 })
  if (count <= 0 || cols === 0) return out

  const colFrom = (c: number): number => Math.floor((c * count) / cols)
  const colTo = (c: number): number =>
    Math.max(colFrom(c), Math.floor(((c + 1) * count) / cols) - 1)
  const overlap = (a0: number, a1: number, b0: number, b1: number): number =>
    Math.max(0, Math.min(a1, b1) - Math.max(a0, b0) + 1)

  for (const sp of spans) {
    const from = Math.max(0, sp.from)
    const to = Math.min(count - 1, sp.to)
    if (to < from) continue
    const doneTo = from + Math.max(0, Math.min(to - from + 1, Math.floor(sp.done))) - 1
    const c0 = Math.max(0, Math.floor((from * cols) / count))
    const c1 = Math.min(cols - 1, Math.ceil(((to + 1) * cols) / count) - 1)
    for (let c = c0; c <= c1; c++) {
      const cf = colFrom(c)
      const ct = colTo(c)
      const n = overlap(from, to, cf, ct)
      if (n === 0) continue
      covered[c] += n
      done[c] += overlap(from, doneTo, cf, ct)
      const col = out[c]
      if (col.state === undefined || stateRank(sp.state) > stateRank(col.state)) {
        col.state = sp.state
      }
    }
  }
  for (let c = 0; c < cols; c++) {
    out[c].doneFrac = covered[c] > 0 ? Math.min(1, done[c] / covered[c]) : 0
  }
  return out
}

/** Live rendered counts by chunk id (progressStore's `byChunk` fits). */
export type LiveProgress = Record<string, { framesDone: number } | undefined>

/**
 * A job's chunks as index spans with their done counts, live progress folded
 * in (the larger of the two wins: live counts RENDERED frames, the snapshot
 * DOWNLOADED ones). Chunks outside the domain are dropped.
 */
export function chunkSpans(
  domain: FrameDomain,
  chunks: readonly ChunkSnapshot[] | undefined,
  live?: LiveProgress
): StateSpan[] {
  const out: StateSpan[] = []
  for (const c of chunks ?? []) {
    const r = chunkRange(domain, c.frameStart, c.frameEnd)
    if (!r) continue
    const n = r.to - r.from + 1
    const done =
      c.state === 'complete' ? n : Math.max(c.framesDone ?? 0, live?.[c.id]?.framesDone ?? 0)
    out.push({ ...r, state: c.state, done: Math.min(n, done) })
  }
  return out
}

/** Frames the opening view holds on a long job. */
export const DEFAULT_SPAN = 200

/**
 * Where a strip opens: the whole job when it is short or nothing is done yet,
 * else DEFAULT_SPAN frames centred on the furthest frame done, which is where
 * a render in progress is producing new thumbnails.
 */
export function defaultView(count: number, spans: readonly StateSpan[]): View {
  if (count <= DEFAULT_SPAN) return wholeView(count)
  let newest = -1
  for (const s of spans) {
    if (s.done > 0) newest = Math.max(newest, Math.min(s.to, s.from + s.done - 1))
  }
  if (newest < 0) return wholeView(count)
  return recenter({ from: 0, to: DEFAULT_SPAN - 1 }, newest, count)
}
