/**
 * The maths behind the inline-SVG charts (TimeChart, Sparkline), kept out of
 * the components so the parts that decide what a reader sees — the y range,
 * where a line breaks, which reading the pointer snaps to — have unit tests.
 * Everything here is pure: pixels in, pixels out, no DOM.
 */

export type MarkKind = 'bars' | 'line' | 'step'

export interface ChartPoint {
  /** epoch ms */
  x: number
  /** null = not sampled; breaks the line rather than reading as zero */
  y: number | null
}

export interface XY {
  x: number
  y: number
}

/**
 * "Nice" axis maximum — round up to 1/2/5 × 10ⁿ so gridline labels land on
 * readable numbers instead of $0.0731.
 */
export function niceCeil(v: number): number {
  if (v <= 0) return 1
  const mag = 10 ** Math.floor(Math.log10(v))
  const norm = v / mag
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10
  return step * mag
}

/**
 * The y range to draw. Quantities (`'zero'`) start at zero and round up to a
 * nice maximum; levels (`'fit'`, a balance) span exactly the data, widened by
 * one unit either way only when the value never moved — a flat balance is a
 * valid, and common, story, and must not collapse to a zero-height band.
 *
 * `yMax` pins the top for bounded measures (GPU util is out of 100): without
 * it a GPU idling at 3% fills the plot and reads as busy. Data above it still
 * fits — the pin is a floor on the top, never a clip.
 */
export function yDomain(
  values: readonly number[],
  baseline: 'zero' | 'fit',
  yMax?: number
): { min: number; max: number } {
  // A loop, not Math.max(...values): six hours of 15 s samples across eight
  // GPUs is fine either way, but a spread that size is a stack-size bet.
  let lo = Infinity
  let hi = -Infinity
  for (const v of values) {
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  if (values.length === 0) lo = hi = 0
  if (baseline === 'fit') {
    return lo === hi ? { min: lo - 1, max: hi + 1 } : { min: lo, max: hi }
  }
  return { min: 0, max: yMax != null && hi <= yMax ? yMax : niceCeil(hi) }
}

/** `n + 1` evenly spaced values from `min` to `max` inclusive — gridlines. */
export function ticks(min: number, max: number, n: number): number[] {
  return Array.from({ length: n + 1 }, (_, i) => min + ((max - min) * i) / n)
}

/** Split on nulls so a gap in sampling becomes a gap in the line. */
export function segments(points: readonly ChartPoint[]): XY[][] {
  const out: XY[][] = []
  let run: XY[] = []
  for (const p of points) {
    if (p.y == null) {
      if (run.length) out.push(run)
      run = []
    } else {
      run.push({ x: p.x, y: p.y })
    }
  }
  if (run.length) out.push(run)
  return out
}

/**
 * SVG `points` for one unbroken run. A step series holds its value until the
 * next reading — draw the horizontal run before the vertical jump.
 */
export function polylinePoints(
  seg: readonly XY[],
  kind: MarkKind,
  sx: (ms: number) => number,
  sy: (v: number) => number
): string {
  return seg
    .flatMap((p, j) =>
      kind === 'step' && j > 0
        ? [`${sx(p.x)},${sy(seg[j - 1].y)}`, `${sx(p.x)},${sy(p.y)}`]
        : [`${sx(p.x)},${sy(p.y)}`]
    )
    .join(' ')
}

/**
 * Index of the point nearest `ms`, or -1 when there are none. Ties go to the
 * earlier point. Nearest wins over "the bucket the pixel falls in": with
 * sparse balance readings that bucket is often empty, and snapping beats
 * showing nothing.
 */
export function nearestIndex(xs: readonly number[], ms: number): number {
  let best = -1
  let bestD = Infinity
  for (let i = 0; i < xs.length; i++) {
    const d = Math.abs(xs[i] - ms)
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  return best
}

/**
 * Every x any series has a reading (or a gap) at, ascending and distinct —
 * the positions the crosshair snaps to on a multi-series chart. One series'
 * own gaps still count: hovering one shows "—" for it, not a neighbour.
 */
export function unionXs(series: ReadonlyArray<{ points: readonly ChartPoint[] }>): number[] {
  const set = new Set<number>()
  for (const s of series) for (const p of s.points) set.add(p.x)
  return [...set].sort((a, b) => a - b)
}

/**
 * One series' value at an x the crosshair snapped to. An exact reading wins
 * (its null included — a gap reads as a gap). Failing that, a step series
 * holds its last reading at or before x; lines and bars have nothing there.
 */
export function valueAt(points: readonly ChartPoint[], x: number, kind: MarkKind): number | null {
  let held: number | null = null
  for (const p of points) {
    if (p.x === x) return p.y
    if (p.x < x) held = p.y
  }
  return kind === 'step' ? held : null
}

/**
 * Bar geometry inside one bucket. A single series fills the bucket less a
 * 1px seam; several share it side by side, split by a 2px gap so neighbours
 * read apart by the gap rather than by a stroke.
 */
export function barSlot(
  bucketPx: number,
  count: number,
  index: number
): { dx: number; width: number } {
  if (count <= 1) return { dx: 0, width: bucketPx }
  const gap = 2
  const width = Math.max(1, (bucketPx - gap * (count - 1)) / count)
  return { dx: index * (width + gap), width }
}

/**
 * Overlapping or touching intervals merged, clipped to the window, sorted.
 * Shaded bands are drawn from this: eight GPUs idle over the same minute are
 * one wash, not eight washes stacked to an opaque block.
 */
export function mergeIntervals(
  intervals: ReadonlyArray<{ fromMs: number; toMs: number }>,
  fromMs: number,
  toMs: number
): Array<{ fromMs: number; toMs: number }> {
  const clipped = intervals
    .map((b) => ({ fromMs: Math.max(fromMs, b.fromMs), toMs: Math.min(toMs, b.toMs) }))
    .filter((b) => b.toMs > b.fromMs)
    .sort((a, b) => a.fromMs - b.fromMs)
  const out: Array<{ fromMs: number; toMs: number }> = []
  for (const b of clipped) {
    const last = out[out.length - 1]
    if (last && b.fromMs <= last.toMs) last.toMs = Math.max(last.toMs, b.toMs)
    else out.push({ ...b })
  }
  return out
}

/**
 * Left edge of a hover panel anchored at `anchorPx`: 10px right of the
 * crosshair, clamped against the chart's own width so a wide panel can't run
 * off the right edge.
 */
export function tooltipLeft(anchorPx: number, widthPx: number, panelPx: number): number {
  return Math.min(Math.max(anchorPx + 10, 0), Math.max(0, widthPx - panelPx - 8))
}

/** Mean, min and max of the readings present, or null when there are none. */
export function summarize(
  values: ReadonlyArray<number | null | undefined>
): { mean: number; min: number; max: number } | null {
  let n = 0
  let sum = 0
  let min = Infinity
  let max = -Infinity
  for (const v of values) {
    if (v == null || !Number.isFinite(v)) continue
    n++
    sum += v
    if (v < min) min = v
    if (v > max) max = v
  }
  return n ? { mean: sum / n, min, max } : null
}

/**
 * Where a key moves the crosshair among `count` snap positions: arrows step,
 * Home/End jump, Escape clears (null). `undefined` = not a chart key, so the
 * caller leaves it alone. With nothing hovered yet, arrows start from the
 * latest reading — the one a reader tabbing in most likely wants.
 */
export function stepHover(
  key: string,
  at: number | null,
  count: number
): number | null | undefined {
  if (count <= 0) return undefined
  const last = count - 1
  const from = at != null && at <= last ? at : last
  switch (key) {
    case 'ArrowLeft':
      return Math.max(0, from - 1)
    case 'ArrowRight':
      return Math.min(last, from + 1)
    case 'Home':
      return 0
    case 'End':
      return last
    case 'Escape':
      return null
    default:
      return undefined
  }
}
