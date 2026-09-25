/**
 * The last hour of each node's GPU use, renderer-local, for the Fleet
 * screen's row sparklines and its live charts (Feature G). The progressStore
 * pattern: `node:metricsSample` arrives about every 15 s per node, so it is
 * folded in here and never touches the Query cache, and each node is read on
 * its own, so one node's sample re-renders its own row and nothing else.
 *
 * A window opened mid-session has heard none of the hour, so the first row
 * to show a node seeds its ring from node:metricsHistory (main's memory,
 * bucketed to 30 s): see useNodeReadings in queries.ts. Samples that arrive
 * while the seed is on its way are kept; the seed only fills in before them.
 *
 * Main keeps hours; this keeps one. A range longer than RING_MS is a
 * node:metricsHistory query of its own, turned into the same readings by
 * readingsOfHistory so the charts draw either the same way.
 */

import { create } from 'zustand'
import type { MetricsSample, NodeMetricsHistory } from '../../../shared/models'
import { pctOf } from './usage'

/** How much of each node's use the store keeps. */
export const RING_MS = 60 * 60_000

/**
 * The most readings a node's ring holds whatever their times: a bound on
 * memory only, four times what an hour of 15 s polls needs. A clock that
 * jumped would otherwise let a ring grow without end.
 */
export const RING_MAX_READINGS = (4 * RING_MS) / 15_000

/** One GPU at one reading. */
export interface GpuReading {
  /** nvidia-smi index */
  index: number
  /** utilisation %; null = no reading for this card */
  util: number | null
  /** VRAM used, as % of the card's total; null = not known */
  vramPct: number | null
  /**
   * Runs assigned to this GPU: those pinned to it, and on a one-GPU node
   * every run, pinned or not (the scheduler pins nothing there, yet every
   * run is on GPU 0). From history it is a bucket's mean, so it can be
   * fractional.
   */
  runs: number
}

/** One node's use at one moment: a poll, or a bucket of polls from history. */
export interface MetricsReading {
  /** epoch ms: the poll, or the middle of the bucket */
  ts: number
  /**
   * Per GPU in index order. null = a gap: the node was not read (it was
   * unreachable, or the poll failed), which a chart draws as a break in its
   * line, never as an idle GPU.
   */
  gpus: GpuReading[] | null
  /** GPU power summed across the node's cards (W); null = not reported */
  powerW: number | null
}

/**
 * Stable empty result for a node with no readings yet. A selector returning
 * a fresh `[]` makes useSyncExternalStore see a new snapshot on every render
 * (logStore's NO_LINES).
 */
export const NO_READINGS: readonly MetricsReading[] = []

/**
 * A pushed sample as the store keeps it. On a one-GPU node the runs not
 * pinned to a GPU are GPU 0's, as main's history counts them (runsOn in
 * metricsHistory.ts). On a node with more GPUs an unpinned run could be on
 * any of them, so it is on none: a GPU is shaded as idle with work only for
 * work it is known to have.
 */
export function readingOf(s: MetricsSample): MetricsReading {
  if (!s.gpus || s.gpus.length === 0) return { ts: s.ts, gpus: null, powerW: null }
  let count = s.runs.length
  for (const g of s.gpus) count = Math.max(count, g.index + 1)
  const oneGpu = count === 1
  const gpus: GpuReading[] = []
  let power = 0
  let powered = false
  for (let i = 0; i < count; i++) {
    const g = s.gpus.find((x) => x.index === i)
    const runs = (s.runs[i] ?? 0) + (oneGpu ? s.unpinnedRuns : 0)
    gpus.push({
      index: i,
      util: g && Number.isFinite(g.util) ? g.util : null,
      vramPct: g ? pctOf(g.vramUsedGb, g.vramTotalGb) : null,
      runs
    })
    // Power 0 is a card that does not report it (GpuSample.powerW).
    if (g && g.powerW > 0) {
      power += g.powerW
      powered = true
    }
  }
  return { ts: s.ts, gpus, powerW: powered ? power : null }
}

/**
 * A history read as readings, one per bucket, stamped at the bucket's middle
 * so buckets and live polls line up on one time axis. A bucket with no
 * reading for any GPU is a gap. A bucket's figures are its means; its runs
 * already count a one-GPU node's unpinned runs on GPU 0 (main's runsOn).
 */
export function readingsOfHistory(h: NodeMetricsHistory): MetricsReading[] {
  const half = h.bucketMs / 2
  const byTs = new Map<number, MetricsReading>()
  const at = (ts: number): MetricsReading => {
    let r = byTs.get(ts)
    if (!r) {
      r = { ts: Math.min(ts + half, h.toMs), gpus: [], powerW: null }
      byTs.set(ts, r)
    }
    return r
  }
  const gpus = [...h.gpus].sort((a, b) => a.index - b.index)
  for (const g of gpus) {
    const runsAt = new Map(g.runs.map((p) => [p.ts, p.mean]))
    const vramAt = new Map(g.vramPct.map((p) => [p.ts, p.mean]))
    for (const p of g.util) {
      at(p.ts).gpus?.push({
        index: g.index,
        util: p.mean,
        vramPct: vramAt.get(p.ts) ?? null,
        runs: runsAt.get(p.ts) ?? 0
      })
    }
  }
  for (const p of h.powerW) {
    if (p.mean != null) at(p.ts).powerW = p.mean
  }
  return [...byTs.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, r]) => (r.gpus?.some((g) => g.util != null) ? r : { ...r, gpus: null }))
}

/**
 * `ring` with `r` in its place in time order (a reading at the same moment
 * replaces the one there), less what has aged out. A new array; the ring
 * passed in is left alone, so a selector holding it sees no change.
 */
export function appendReading(
  ring: readonly MetricsReading[],
  r: MetricsReading
): MetricsReading[] {
  let at = ring.length
  while (at > 0 && ring[at - 1].ts > r.ts) at--
  const replace = at > 0 && ring[at - 1].ts === r.ts
  const next = replace
    ? [...ring.slice(0, at - 1), r, ...ring.slice(at)]
    : [...ring.slice(0, at), r, ...ring.slice(at)]
  return evict(next)
}

/**
 * A seed under the readings already heard: only the part of it that ends
 * before the first of them, so a moment is never drawn twice. `bucketMs` is
 * the seed's bucket width: a bucket stamped at its middle ends half a bucket
 * later.
 */
export function mergeSeed(
  ring: readonly MetricsReading[],
  seed: readonly MetricsReading[],
  bucketMs: number
): MetricsReading[] {
  const first = ring.length > 0 ? ring[0].ts : Infinity
  const before = seed.filter((r) => r.ts + bucketMs / 2 <= first)
  return evict([...before, ...ring])
}

/**
 * Past RING_MS behind the newest reading, and past RING_MAX_READINGS, the
 * oldest go. Measured from the newest reading rather than the clock, so a
 * ring is the hour it heard, whatever the time now.
 */
function evict(ring: MetricsReading[]): MetricsReading[] {
  if (ring.length === 0) return ring
  const floor = ring[ring.length - 1].ts - RING_MS
  let drop = 0
  while (drop < ring.length && ring[drop].ts < floor) drop++
  drop = Math.max(drop, ring.length - RING_MAX_READINGS)
  return drop > 0 ? ring.slice(drop) : ring
}

interface MetricsState {
  byNode: Record<string, readonly MetricsReading[]>
  /** Nodes whose seed is on its way ('pending') or in ('done'). */
  seeds: Record<string, 'pending' | 'done'>
  /** Fold in one `node:metricsSample`. */
  record: (s: MetricsSample) => void
  /**
   * Claim a node's seed. True for the one caller that should fetch it; false
   * while it is on its way or once it is in.
   */
  beginSeed: (nodeId: string) => boolean
  /** The seed's readings, under whatever was heard meanwhile. */
  seed: (nodeId: string, readings: readonly MetricsReading[], bucketMs: number) => void
  /** The seed could not be read: the next row to show the node asks again. */
  seedFailed: (nodeId: string) => void
  /** Drop a node, once it is gone for good. */
  forget: (nodeId: string) => void
}

export const useMetricsStore = create<MetricsState>((set, get) => ({
  byNode: {},
  seeds: {},
  record: (s) =>
    set((st) => ({
      byNode: {
        ...st.byNode,
        [s.nodeId]: appendReading(st.byNode[s.nodeId] ?? NO_READINGS, readingOf(s))
      }
    })),
  beginSeed: (nodeId) => {
    if (get().seeds[nodeId]) return false
    set((st) => ({ seeds: { ...st.seeds, [nodeId]: 'pending' } }))
    return true
  },
  seed: (nodeId, readings, bucketMs) =>
    set((st) => {
      // Forgotten while the seed was on its way: a destroyed node stays gone.
      if (st.seeds[nodeId] !== 'pending') return st
      const merged = mergeSeed(st.byNode[nodeId] ?? NO_READINGS, readings, bucketMs)
      return {
        byNode: { ...st.byNode, [nodeId]: merged.length > 0 ? merged : NO_READINGS },
        seeds: { ...st.seeds, [nodeId]: 'done' }
      }
    }),
  seedFailed: (nodeId) =>
    set((st) => {
      if (st.seeds[nodeId] !== 'pending') return st
      const rest = { ...st.seeds }
      delete rest[nodeId]
      return { seeds: rest }
    }),
  forget: (nodeId) =>
    set((st) => {
      if (!(nodeId in st.byNode) && !(nodeId in st.seeds)) return st
      const byNode = { ...st.byNode }
      const seeds = { ...st.seeds }
      delete byNode[nodeId]
      delete seeds[nodeId]
      return { byNode, seeds }
    })
}))
