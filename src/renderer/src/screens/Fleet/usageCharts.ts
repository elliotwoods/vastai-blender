/**
 * What the Fleet screen's GPU graphs draw (Feature G), worked out without a
 * DOM so the parts a reader relies on have tests: where a line breaks, what
 * counts as a GPU paid for and idle, and which window a live chart shows.
 * The components (FleetGpuStrip, NodeUsageCharts, the row sparkline) only
 * lay these out.
 */

import {
  GPU_BUSY_UTIL_PCT,
  type FleetGpuHistory,
  type FleetGpuPoint
} from '../../../../shared/models'
import type { MetricsReading } from '../../lib/metricsStore'
import { gpuColor } from '../../components/charts/palette'
import type { ChartPoint } from '../../components/charts/scale'
import type { SparkPoint } from '../../components/charts/Sparkline'
import type { TimeBand, TimeSeries } from '../../components/charts/TimeChart'

/** The row sparkline's window. */
export const SPARK_MS = 30 * 60_000

/** How often main polls a node. */
export const POLL_MS = 15_000

/**
 * Consecutive readings further apart than this are not joined by a line.
 * Polls land up to ~25 s apart (a probe can take its whole 10 s timeout);
 * 90 s is several missed polls, and a line across them would draw a
 * reading nobody took. Main records a gap for a poll that failed, but a
 * window that heard nothing (it was closed, or main stopped polling the
 * node) has no gap to show, only a hole.
 */
export const GAP_MIN_MS = 90_000

/** The gap limit for readings `bucketMs` apart (0 = live polls). */
export function maxGapMs(bucketMs = 0): number {
  return Math.max(GAP_MIN_MS, 2.5 * bucketMs)
}

/**
 * A live chart's window: `spanMs` back from now, or from the newest reading
 * when that is later. A sample stamped after the last tick of the clock the
 * screen reads would otherwise fall off the right edge until the next one.
 */
export function liveWindow(
  readings: readonly MetricsReading[],
  now: number,
  spanMs: number
): { fromMs: number; toMs: number } {
  const last = readings.length > 0 ? readings[readings.length - 1].ts : -Infinity
  const toMs = Math.max(now, last)
  return { fromMs: toMs - spanMs, toMs }
}

/** The readings inside [fromMs, toMs], oldest first (the ring is kept in order). */
function within(
  readings: readonly MetricsReading[],
  fromMs: number,
  toMs: number
): MetricsReading[] {
  return readings.filter((r) => r.ts >= fromMs && r.ts <= toMs)
}

/**
 * `points`, with a null reading between two that are more than `maxGap`
 * apart, so the line breaks there rather than bridging a hole.
 */
export function breakAtHoles<T extends { x: number }>(
  points: readonly T[],
  maxGap: number,
  hole: (x: number) => T
): T[] {
  const out: T[] = []
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const prev = points[i - 1]
    if (prev && p.x - prev.x > maxGap) out.push(hole((prev.x + p.x) / 2))
    out.push(p)
  }
  return out
}

/**
 * The row sparkline: across the node's GPUs, the mean utilisation as the
 * line and the least and most busy card as the band, so one busy card among
 * idle ones shows as a wide band under a low line.
 */
export function sparkPoints(
  readings: readonly MetricsReading[],
  fromMs: number,
  toMs: number,
  maxGap = GAP_MIN_MS
): SparkPoint[] {
  const points = within(readings, fromMs, toMs).map((r): SparkPoint => {
    const utils = (r.gpus ?? []).map((g) => g.util).filter((u): u is number => u != null)
    if (utils.length === 0) return { x: r.ts, mean: null }
    return {
      x: r.ts,
      mean: utils.reduce((a, b) => a + b, 0) / utils.length,
      min: Math.min(...utils),
      max: Math.max(...utils)
    }
  })
  return breakAtHoles(points, maxGap, (x) => ({ x, mean: null }))
}

/**
 * A GPU paid for and doing nothing: at or under GPU_BUSY_UTIL_PCT while a
 * run is assigned to it. The phantom runs of job 81fe2875 held 7 of 24 GPUs
 * this way, and nothing on screen said so.
 */
export function paidIdle(g: { util: number | null; runs: number }): boolean {
  return g.runs > 0 && g.util != null && g.util <= GPU_BUSY_UTIL_PCT
}

export const IDLE_BAND_LABEL = 'idle with work assigned'

export interface NodeUsageCharts {
  /** GPU indices with a reading in the window, ascending */
  gpus: number[]
  /** utilisation %, one series per GPU */
  util: TimeSeries[]
  /** VRAM used as % of each card, one series per GPU */
  vram: TimeSeries[]
  /** GPU power summed across the node (W) */
  power: ChartPoint[]
  /** spans where a GPU sat idle with a run assigned (paidIdle) */
  idle: TimeBand[]
}

/**
 * One node's charts over [fromMs, toMs]. Each GPU keeps its index's colour
 * (gpuColor), so "GPU 3" is the same hue in every chart and after a legend
 * filter. A gap reading breaks every GPU's line at once.
 */
export function nodeUsageCharts(
  readings: readonly MetricsReading[],
  fromMs: number,
  toMs: number,
  maxGap = GAP_MIN_MS
): NodeUsageCharts {
  const rs = within(readings, fromMs, toMs)
  const indices = new Set<number>()
  for (const r of rs) for (const g of r.gpus ?? []) indices.add(g.index)
  const gpus = [...indices].sort((a, b) => a - b)

  const seriesOf = (
    pick: (g: { util: number | null; vramPct: number | null }) => number | null
  ): TimeSeries[] =>
    gpus.map((index): TimeSeries => ({
      id: `gpu${index}`,
      label: `GPU ${index}`,
      color: gpuColor(index),
      points: breakAtHoles(
        rs.map((r) => {
          const g = r.gpus?.find((x) => x.index === index)
          return { x: r.ts, y: g ? pick(g) : null }
        }),
        maxGap,
        (x) => ({ x, y: null })
      )
    }))

  const power = breakAtHoles(
    rs.map((r) => ({ x: r.ts, y: r.powerW })),
    maxGap,
    (x) => ({ x, y: null })
  )

  return {
    gpus,
    util: seriesOf((g) => g.util),
    vram: seriesOf((g) => g.vramPct),
    power: power.some((p) => p.y != null) ? power : [],
    idle: idleBands(rs, gpus, toMs, maxGap)
  }
}

/**
 * Each GPU's paid-idle spans. A reading's span runs to the next reading (a
 * poll stands until the next one), or one poll's length past the last; a
 * run of idle readings is one band, not one per poll.
 */
function idleBands(
  rs: readonly MetricsReading[],
  gpus: readonly number[],
  toMs: number,
  maxGap: number
): TimeBand[] {
  const bands: TimeBand[] = []
  for (const index of gpus) {
    let open: TimeBand | null = null
    for (let i = 0; i < rs.length; i++) {
      const r = rs[i]
      const next = rs[i + 1]
      const g = r.gpus?.find((x) => x.index === index)
      if (!g || !paidIdle(g)) {
        open = null
        continue
      }
      const end = Math.min(
        toMs,
        next && next.ts - r.ts <= maxGap ? next.ts : r.ts + Math.min(POLL_MS, maxGap)
      )
      if (open && open.toMs >= r.ts) {
        open.toMs = Math.max(open.toMs, end)
      } else {
        open = { fromMs: r.ts, toMs: end, label: `GPU ${index} ${IDLE_BAND_LABEL}` }
        bands.push(open)
      }
    }
  }
  return bands
}

// -- the fleet strip -------------------------------------------------------------

export interface FleetStripSeries {
  rented: ChartPoint[]
  busy: ChartPoint[]
  /** the bucket behind each x, for the hover readout's mean util and idle $/hr */
  byX: Map<number, FleetGpuPoint>
  /** the most GPUs rented in the window */
  peakRented: number
}

/**
 * The fleet's GPUs rented and busy over a fleet:gpuHistory read, each bucket
 * stamped at its middle like the node charts. A bucket no node was polled in
 * is null, a break in both lines.
 */
export function fleetStripSeries(h: FleetGpuHistory): FleetStripSeries {
  const half = h.bucketMs / 2
  const byX = new Map<number, FleetGpuPoint>()
  const rented: ChartPoint[] = []
  const busy: ChartPoint[] = []
  let peakRented = 0
  for (const p of h.points) {
    const x = Math.min(p.ts + half, h.toMs)
    byX.set(x, p)
    rented.push({ x, y: p.gpusRented })
    busy.push({ x, y: p.gpusBusy })
    if (p.gpusRented != null) peakRented = Math.max(peakRented, p.gpusRented)
  }
  return { rented, busy, byX, peakRented }
}

/**
 * The strip's "per GPU" view: one 0–100% utilisation line per GPU across the
 * fleet, from a fleet:gpuHistory read made with perGpu. Buckets are stamped
 * at their middle, as in fleetStripSeries, and a bucket with no reading is a
 * break in that GPU's line.
 *
 * Colour follows the GPU's place in main's list (by node, then index), not
 * its nvidia-smi index: every node has a GPU 0, and on one chart they must
 * not share a hue. Past the palette's eight, gpuColor gives the rest its
 * grey; the legend and readout name each one.
 */
export function fleetGpuLines(h: FleetGpuHistory): TimeSeries[] {
  const half = h.bucketMs / 2
  return (h.gpus ?? []).map((g, i): TimeSeries => ({
    id: `${g.nodeId}#${g.gpuIndex}`,
    label: g.label,
    color: gpuColor(i),
    points: g.util.map((p) => ({ x: Math.min(p.ts + half, h.toMs), y: p.mean }))
  }))
}

/** The newest bucket that saw the fleet, for the strip's figures; null when none did. */
export function latestFleetPoint(h: FleetGpuHistory | undefined): FleetGpuPoint | null {
  if (!h) return null
  for (let i = h.points.length - 1; i >= 0; i--) {
    if (h.points[i].gpusRented != null) return h.points[i]
  }
  return null
}

/**
 * Top of a GPU-count axis: a multiple of 4, so the chart's four gridlines
 * land on whole GPUs (0, 6, 12, 18, 24) rather than 12.5 of them.
 */
export function gpuAxisMax(peak: number): number {
  return Math.max(4, Math.ceil(peak / 4) * 4)
}

/** A GPU count, whole when it is (a bucket's mean can be 7.5). */
export function fmtGpus(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1)
}

/** Clock time for a chart's x axis and readout. Past 6 h the day is ambiguous, so it says which. */
export function clockFormatter(spanMs: number): (ms: number) => string {
  if (spanMs > 6 * 60 * 60_000) {
    return (ms) =>
      new Date(ms).toLocaleString([], {
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit'
      })
  }
  return (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
