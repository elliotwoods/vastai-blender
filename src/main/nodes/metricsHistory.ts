/**
 * GPU usage over time (Feature G): what the Fleet screen's graphs draw.
 *
 * pollMetrics sampled every node's GPUs every 15 s and kept only the latest,
 * so every way paid GPUs sat idle was invisible after the fact: the phantom
 * runs of job 81fe2875 held lanes on 7 of 24 GPUs that did nothing, the lane
 * guard collapsed a node to one lane (#222), EEVEE lanes piled onto one card
 * (#229). Each sample now also goes here, with the runs the scheduler had on
 * each GPU at that moment, which is what separates a GPU idle with work
 * assigned (paid for and wasted) from one idle with nothing to do.
 *
 * - record() keeps about RING_MS of samples per node in memory, and writes
 *   each one to `node_metrics` (one row per GPU, in one transaction) for
 *   longer ranges and for after a restart. prune(), from the cost timer,
 *   keeps that table to RETENTION_MS.
 * - A poll that got no reading (the node unreachable, the probe failed, or
 *   a node that holds an instance and is not probed, booting or failed) is
 *   recorded as a gap, `gpus: null`, with null rows in the table: a graph
 *   breaks its line there rather than drawing an idle GPU, and the fleet
 *   graph still counts those GPUs as rented.
 * - nodeHistory() and fleetGpuHistory() read memory for the part of a range
 *   it covers and the table for the rest, bucketed to at most `maxPoints`
 *   with min, mean and max per bucket (bucketize).
 *
 * On a one-GPU node the scheduler pins nothing (NodeWorkRef.gpu is null), yet
 * every run there is on GPU 0. History counts them on GPU 0 (runsOn), or a
 * one-GPU node could never show as paid and idle. MetricsSample, as pushed,
 * keeps them in `unpinnedRuns`, as its contract says.
 *
 * Nothing here may stand in a probe's way: a table write that fails (a full
 * disk) is skipped, the memory ring keeps the sample, and a listener that
 * throws is its own problem.
 */

import { getDb } from '../db/db'
import {
  GPU_BUSY_UTIL_PCT,
  type FleetGpuHistory,
  type FleetGpuPoint,
  type GpuSample,
  type GpuSeries,
  type MetricsHistoryQuery,
  type MetricsPoint,
  type MetricsSample,
  type NodeMetrics,
  type NodeMetricsHistory,
  type NodeMetricsHistoryQuery,
  type NodeWorkRef
} from '../../shared/models'

const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** How far back each node's samples stay in memory. */
export const RING_MS = 6 * HOUR

/** How long `node_metrics` keeps a sample (prune). */
export const RETENTION_MS = 7 * DAY

/**
 * The narrowest bucket a history read returns. Polls are 15 s apart, and a
 * probe lands anywhere up to its 10 s timeout into its round, so two samples
 * of one node can be up to ~25 s apart. A bucket narrower than that would
 * come back empty now and then, which reads as a gap: a line broken for no
 * reason.
 */
export const MIN_BUCKET_MS = 30 * SECOND

/** The most buckets one history read returns, whatever it asks for. */
export const MAX_POINTS = 2_000

/**
 * Bucket widths a read may get, so that the same range asked again lands on
 * the same buckets (they are aligned to epoch multiples of the width) and a
 * chart does not shimmer as it refreshes. Past a day, whole days.
 */
const BUCKET_STEPS = [
  30 * SECOND,
  MINUTE,
  2 * MINUTE,
  5 * MINUTE,
  10 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  HOUR,
  2 * HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY
]

/**
 * The most samples a node's ring holds, whatever their times: a bound on
 * memory only, four times what RING_MS of 15 s polls needs, never reached by
 * the poll itself.
 */
const RING_MAX_SAMPLES = (4 * RING_MS) / (15 * SECOND)

// -- runs ----------------------------------------------------------------------

/** The scheduler's runs on a node at one poll: pinned per GPU index, and the rest. */
export interface GpuRuns {
  /** `runs[i]`: runs pinned to GPU i */
  runs: number[]
  /** runs not pinned to one GPU */
  unpinned: number
}

/**
 * Count a node's in-flight work (scheduler.activeWorkForNode, through
 * nodeManager's activeWorkProvider) per GPU. `runs` covers every one of the
 * node's `numGpus` GPUs, and any index a run is pinned to beyond them.
 */
export function runsPerGpu(work: readonly NodeWorkRef[], numGpus: number): GpuRuns {
  const runs: number[] = new Array<number>(Math.max(0, Math.floor(numGpus) || 0)).fill(0)
  let unpinned = 0
  for (const w of work) {
    const g = w.gpu
    // An index nobody would pin to is a bug upstream, not 255 empty GPUs.
    if (g == null || !Number.isInteger(g) || g < 0 || g > 255) {
      unpinned++
      continue
    }
    while (runs.length <= g) runs.push(0)
    runs[g]++
  }
  return { runs, unpinned }
}

/** How many GPUs a sample covers: record() makes `runs` as long as that. */
function gpuCount(s: MetricsSample): number {
  return s.runs.length
}

/**
 * Runs on GPU `i` at this sample. On a one-GPU node every run is on GPU 0,
 * pinned or not (see the header).
 */
export function runsOn(s: MetricsSample, i: number): number {
  return (s.runs[i] ?? 0) + (gpuCount(s) === 1 && i === 0 ? s.unpinnedRuns : 0)
}

function gpuAt(s: MetricsSample, i: number): GpuSample | null {
  return s.gpus?.find((g) => g.index === i) ?? null
}

// -- memory, the table, listeners ------------------------------------------------

const rings = new Map<string, MetricsSample[]>()

/**
 * When this process recorded its first sample (epoch ms), null before. From
 * then on (less what has aged out of the rings) memory holds every sample,
 * and a read takes that part of its range from memory alone.
 */
let memoryFrom: number | null = null

const listeners = new Set<(sample: MetricsSample) => void>()

/**
 * Hear every sample as record() takes it: what `node:metricsSample` pushes
 * to the renderer, once that channel is out of IpcEventMapPending (the
 * integration wave forwards it). Returns the unsubscribe function.
 */
export function onSample(listener: (sample: MetricsSample) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Table writes that failed this session, and why the last one did. */
let writeFailures = 0
let lastWriteError: string | null = null

/** For diagnostics: how many samples did not reach `node_metrics`, and the last reason. */
export function tableWriteFailures(): { count: number; last: string | null } {
  return { count: writeFailures, last: lastWriteError }
}

/**
 * Take one node's poll. `metrics` is the probe's sample, or null for a poll
 * with no reading: a gap. `runs` is runsPerGpu of the scheduler's work on the
 * node at the poll. `numGpus` (the node row's) sizes a gap: without a reading
 * there is nothing else to say how many GPUs are rented and unmeasured.
 *
 * Returns the sample as kept and as listeners heard it.
 */
export function record(
  nodeId: string,
  metrics: NodeMetrics | null,
  runs: GpuRuns,
  opts: { numGpus?: number; ts?: number } = {}
): MetricsSample {
  const ts = opts.ts ?? metrics?.updatedAt ?? Date.now()
  // A sample from before per-GPU readings were kept has no GPUs to chart.
  const gpus = metrics?.gpus && metrics.gpus.length > 0 ? metrics.gpus.map((g) => ({ ...g })) : null
  let count = Math.max(1, Math.floor(opts.numGpus ?? 1) || 1, runs.runs.length)
  for (const g of gpus ?? []) count = Math.max(count, g.index + 1)
  const perGpu = Array.from({ length: count }, (_, i) => runs.runs[i] ?? 0)
  const reading = metrics != null
  const sample: MetricsSample = {
    nodeId,
    ts,
    gpus,
    runs: perGpu,
    unpinnedRuns: runs.unpinned,
    cpuUtil: reading && Number.isFinite(metrics.cpuUtil) ? metrics.cpuUtil : null,
    ramUsedGb: reading && metrics.ramTotalGb > 0 ? metrics.ramUsedGb : null,
    ramTotalGb: reading && metrics.ramTotalGb > 0 ? metrics.ramTotalGb : null
  }
  keep(sample)
  writeRows(sample)
  for (const l of [...listeners]) {
    try {
      l(sample)
    } catch {
      // A listener's failure is its own.
    }
  }
  return sample
}

/** Into the node's ring, in time order, dropping what has aged out. */
function keep(sample: MetricsSample): void {
  memoryFrom = memoryFrom == null ? sample.ts : Math.min(memoryFrom, sample.ts)
  let ring = rings.get(sample.nodeId)
  if (!ring) {
    ring = []
    rings.set(sample.nodeId, ring)
  }
  let at = ring.length
  while (at > 0 && ring[at - 1].ts > sample.ts) at--
  ring.splice(at, 0, sample)
  evict(ring, Date.now())
}

function evict(ring: MetricsSample[], now: number): void {
  const floor = now - RING_MS
  let drop = 0
  while (drop < ring.length && ring[drop].ts < floor) drop++
  drop = Math.max(drop, ring.length - RING_MAX_SAMPLES)
  if (drop > 0) ring.splice(0, drop)
}

/**
 * One row per GPU, one transaction per poll. A gap writes null readings,
 * which the schema defines as a gap. Power 0 is a card that does not report
 * it (GpuSample.powerW), kept as null so it is no line rather than a flat 0 W.
 */
function writeRows(s: MetricsSample): void {
  try {
    const db = getDb()
    const insert = db.prepare(
      `INSERT INTO node_metrics (ts, node_id, gpu_index, util, vram_used_gb, vram_total_gb, power_w, runs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    db.transaction(() => {
      for (let i = 0; i < gpuCount(s); i++) {
        const g = s.gpus ? gpuAt(s, i) : null
        insert.run(
          s.ts,
          s.nodeId,
          i,
          g ? g.util : null,
          g ? g.vramUsedGb : null,
          g ? g.vramTotalGb : null,
          g && g.powerW > 0 ? g.powerW : null,
          runsOn(s, i)
        )
      }
    })()
  } catch (e) {
    writeFailures++
    lastWriteError = e instanceof Error ? e.message : String(e)
  }
}

/**
 * Age the rings and the table: rings past RING_MS (a destroyed node's ring
 * goes once it is empty), rows past RETENTION_MS. From the cost timer.
 */
export function prune(now = Date.now()): void {
  for (const [nodeId, ring] of rings) {
    evict(ring, now)
    if (ring.length === 0) rings.delete(nodeId)
  }
  try {
    getDb()
      .prepare('DELETE FROM node_metrics WHERE ts < ?')
      .run(now - RETENTION_MS)
  } catch {
    // Tried again at the next tick.
  }
}

/** The samples memory holds for a node, oldest first (a copy). */
export function recent(nodeId: string): MetricsSample[] {
  return [...(rings.get(nodeId) ?? [])]
}

/**
 * Where a read switches from the table to memory: from here on memory holds
 * every sample this process recorded, and older than here only the table
 * does. Nothing recorded yet: everything is the table's.
 */
function memoryCutoff(now: number): number {
  if (memoryFrom == null) return Infinity
  return Math.max(memoryFrom, now - RING_MS)
}

// -- buckets ---------------------------------------------------------------------

/** The buckets a read covers: `count` of `bucketMs`, from `start` (an epoch multiple of it). */
export interface BucketGrid {
  start: number
  bucketMs: number
  count: number
}

/**
 * The bucket grid for [fromMs, toMs): the narrowest width of BUCKET_STEPS (at
 * least `minBucketMs`) that fits the range in `maxPoints`, aligned to epoch
 * multiples of itself, as the History screen's buckets are.
 *
 * The width is chosen as if the range never lined up with a bucket edge,
 * which costs one bucket when it does: otherwise a window sliding with the
 * clock would get twice the width at the odd instant it did line up.
 */
export function bucketGrid(
  fromMs: number,
  toMs: number,
  maxPoints: number,
  minBucketMs = 0
): BucketGrid {
  const points = Math.max(1, Math.min(MAX_POINTS, Math.floor(maxPoints) || 1))
  const span = Math.max(1, toMs - fromMs)
  // One bucket, then, and the range itself is it: an aligned one could take two.
  if (points === 1) return { start: fromMs, bucketMs: Math.max(span, minBucketMs), count: 1 }
  const fits = (w: number): boolean => w >= minBucketMs && Math.ceil(span / w) + 1 <= points
  let bucketMs = 0
  // Below the steps (a unit test's short range): whole seconds.
  for (
    let w = Math.max(SECOND, Math.ceil(span / points / SECOND) * SECOND);
    w < BUCKET_STEPS[0];
    w += SECOND
  ) {
    if (fits(w)) {
      bucketMs = w
      break
    }
  }
  if (!bucketMs) bucketMs = BUCKET_STEPS.find(fits) ?? 0
  if (!bucketMs) {
    bucketMs = Math.max(DAY, Math.ceil(minBucketMs / DAY) * DAY)
    while (!fits(bucketMs)) bucketMs += DAY
  }
  const start = Math.floor(fromMs / bucketMs) * bucketMs
  return { start, bucketMs, count: Math.max(1, Math.ceil(toMs / bucketMs) - start / bucketMs) }
}

/** Running min/mean/max of one bucket. */
interface Acc {
  n: number
  sum: number
  min: number
  max: number
}

function emptyAccs(count: number): Array<Acc | null> {
  return new Array<Acc | null>(count).fill(null)
}

function add(accs: Array<Acc | null>, b: number, v: number | null): void {
  if (v == null || !Number.isFinite(v) || b < 0 || b >= accs.length) return
  const a = accs[b]
  if (!a) accs[b] = { n: 1, sum: v, min: v, max: v }
  else {
    a.n++
    a.sum += v
    if (v < a.min) a.min = v
    if (v > a.max) a.max = v
  }
}

/** A bucket the table aggregated: count, sum, min and max of its non-null values. */
function merge(
  accs: Array<Acc | null>,
  b: number,
  n: number,
  sum: number,
  min: number,
  max: number
): void {
  if (!(n > 0) || b < 0 || b >= accs.length) return
  const a = accs[b]
  if (!a) accs[b] = { n, sum, min, max }
  else {
    a.n += n
    a.sum += sum
    if (min < a.min) a.min = min
    if (max > a.max) a.max = max
  }
}

function toPoints(grid: BucketGrid, accs: Array<Acc | null>): MetricsPoint[] {
  return accs.map((a, b) => ({
    ts: grid.start + b * grid.bucketMs,
    mean: a ? a.sum / a.n : null,
    min: a ? a.min : null,
    max: a ? a.max : null
  }))
}

function bucketOf(grid: BucketGrid, ts: number): number {
  return Math.floor((ts - grid.start) / grid.bucketMs)
}

/**
 * Bucket one series over [fromMs, toMs) into at most `maxPoints` buckets of
 * min, mean and max. A null value is a gap: it adds nothing, so a bucket with
 * only gaps, or with no samples at all, is all null, where a chart breaks its
 * line. Samples outside the range are ignored. Pure.
 */
export function bucketize(
  samples: ReadonlyArray<{ ts: number; value: number | null }>,
  fromMs: number,
  toMs: number,
  maxPoints: number,
  minBucketMs = 0
): { bucketMs: number; points: MetricsPoint[] } {
  const grid = bucketGrid(fromMs, toMs, maxPoints, minBucketMs)
  const accs = emptyAccs(grid.count)
  for (const s of samples) {
    if (s.ts < fromMs || s.ts >= toMs) continue
    add(accs, bucketOf(grid, s.ts), s.value)
  }
  return { bucketMs: grid.bucketMs, points: toPoints(grid, accs) }
}

/** A query's window made safe: finite, in order, with a sane point count. */
function rangeOf(q: MetricsHistoryQuery): { fromMs: number; toMs: number; maxPoints: number } {
  const toMs = Number.isFinite(q.toMs) ? q.toMs : Date.now()
  let fromMs = Number.isFinite(q.fromMs) ? q.fromMs : toMs - HOUR
  if (!(fromMs < toMs)) fromMs = toMs - MIN_BUCKET_MS
  const maxPoints = Math.max(1, Math.min(MAX_POINTS, Math.floor(q.maxPoints) || 1))
  return { fromMs, toMs, maxPoints }
}

// -- one node --------------------------------------------------------------------

interface GpuAccs {
  util: Array<Acc | null>
  vramPct: Array<Acc | null>
  powerW: Array<Acc | null>
  runs: Array<Acc | null>
}

function vramPct(used: number | null, total: number | null): number | null {
  return used != null && total != null && total > 0 ? (100 * used) / total : null
}

/**
 * One node's usage over a range (node:metricsHistory): per GPU its
 * utilisation, VRAM %, power and runs, plus the node's unpinned runs, CPU %
 * and summed GPU power, all on the same buckets. CPU and unpinned runs are
 * kept in memory only (`node_metrics` has no column for them), so they are
 * null for the part of a range older than memory.
 */
export function nodeHistory(q: NodeMetricsHistoryQuery, now = Date.now()): NodeMetricsHistory {
  const { fromMs, toMs, maxPoints } = rangeOf(q)
  const grid = bucketGrid(fromMs, toMs, maxPoints, MIN_BUCKET_MS)
  const gpus = new Map<number, GpuAccs>()
  const gpu = (i: number): GpuAccs => {
    let g = gpus.get(i)
    if (!g) {
      g = {
        util: emptyAccs(grid.count),
        vramPct: emptyAccs(grid.count),
        powerW: emptyAccs(grid.count),
        runs: emptyAccs(grid.count)
      }
      gpus.set(i, g)
    }
    return g
  }
  const unpinned = emptyAccs(grid.count)
  const cpu = emptyAccs(grid.count)
  const power = emptyAccs(grid.count)
  const cutoff = memoryCutoff(now)

  if (fromMs < cutoff) {
    const until = Math.min(toMs, cutoff)
    try {
      readNodeTable(q.nodeId, grid, fromMs, until, gpu, power)
    } catch {
      // No table to read: memory's part stands on its own.
    }
  }
  for (const s of rings.get(q.nodeId) ?? []) {
    if (s.ts < Math.max(fromMs, cutoff) || s.ts >= toMs) continue
    const b = bucketOf(grid, s.ts)
    let watts: number | null = null
    for (let i = 0; i < gpuCount(s); i++) {
      const g = gpu(i)
      const r = s.gpus ? gpuAt(s, i) : null
      add(g.util, b, r ? r.util : null)
      add(g.vramPct, b, r ? vramPct(r.vramUsedGb, r.vramTotalGb) : null)
      add(g.powerW, b, r && r.powerW > 0 ? r.powerW : null)
      add(g.runs, b, runsOn(s, i))
      if (r && r.powerW > 0) watts = (watts ?? 0) + r.powerW
    }
    // Counted on GPU 0 on a one-GPU node (runsOn), so not again here.
    add(unpinned, b, gpuCount(s) === 1 ? 0 : s.unpinnedRuns)
    add(cpu, b, s.cpuUtil)
    add(power, b, watts)
  }

  const series: GpuSeries[] = [...gpus.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, g]) => ({
      index,
      util: toPoints(grid, g.util),
      vramPct: toPoints(grid, g.vramPct),
      powerW: toPoints(grid, g.powerW),
      runs: toPoints(grid, g.runs)
    }))
  return {
    nodeId: q.nodeId,
    fromMs,
    toMs,
    bucketMs: grid.bucketMs,
    gpus: series,
    unpinnedRuns: toPoints(grid, unpinned),
    cpuUtil: toPoints(grid, cpu),
    powerW: toPoints(grid, power)
  }
}

interface AggRow {
  b: number
  n: number
  s: number | null
  lo: number | null
  hi: number | null
}

/** The table's part of one node's range, aggregated per bucket in SQL. */
function readNodeTable(
  nodeId: string,
  grid: BucketGrid,
  fromMs: number,
  toMs: number,
  gpu: (i: number) => GpuAccs,
  power: Array<Acc | null>
): void {
  if (!(fromMs < toMs)) return
  const db = getDb()
  const bucket = 'CAST((ts - ?) / ? AS INTEGER)'
  const agg = (col: string): string =>
    `COUNT(${col}) AS ${col}_n, SUM(${col}) AS ${col}_s, MIN(${col}) AS ${col}_lo, MAX(${col}) AS ${col}_hi`
  const rows = db
    .prepare(
      `SELECT gpu_index AS g, ${bucket} AS b, ${agg('util')}, ${agg('vp')}, ${agg('power_w')}, ${agg('runs')}
       FROM (SELECT ts, gpu_index, util, power_w, runs,
                    CASE WHEN vram_total_gb > 0 THEN 100.0 * vram_used_gb / vram_total_gb END AS vp
             FROM node_metrics WHERE node_id = ? AND ts >= ? AND ts < ?)
       GROUP BY g, b`
    )
    .all(grid.start, grid.bucketMs, nodeId, fromMs, toMs) as Array<Record<string, number | null>>
  for (const r of rows) {
    const g = gpu(Number(r.g))
    const b = Number(r.b)
    for (const [col, accs] of [
      ['util', g.util],
      ['vp', g.vramPct],
      ['power_w', g.powerW],
      ['runs', g.runs]
    ] as const) {
      merge(
        accs,
        b,
        Number(r[`${col}_n`]),
        Number(r[`${col}_s`]),
        Number(r[`${col}_lo`]),
        Number(r[`${col}_hi`])
      )
    }
  }
  // The node's power: summed over its GPUs at each poll first.
  const watts = db
    .prepare(
      `SELECT ${bucket} AS b, COUNT(p) AS n, SUM(p) AS s, MIN(p) AS lo, MAX(p) AS hi
       FROM (SELECT ts, SUM(power_w) AS p FROM node_metrics
             WHERE node_id = ? AND ts >= ? AND ts < ? GROUP BY ts)
       GROUP BY b`
    )
    .all(grid.start, grid.bucketMs, nodeId, fromMs, toMs) as unknown as AggRow[]
  for (const r of watts)
    merge(power, Number(r.b), Number(r.n), Number(r.s), Number(r.lo), Number(r.hi))
}

// -- the fleet -------------------------------------------------------------------

/** One node's poll, reduced to what the fleet graph sums. */
interface PollFigures {
  rented: number
  busy: number
  /** Σ utilisation of the GPUs that had a reading, and how many did */
  utilSum: number
  utilN: number
}

/**
 * A GPU is busy above GPU_BUSY_UTIL_PCT, or with a run on it: assigned work
 * counts, so what the fleet graph shows as idle is GPUs with nothing to do.
 * The node graph's shading is what shows assigned work that is not running.
 * A GPU with no reading (a gap) is busy only if it has a run.
 */
function pollFigures(s: MetricsSample): PollFigures {
  const f: PollFigures = { rented: gpuCount(s), busy: 0, utilSum: 0, utilN: 0 }
  for (let i = 0; i < f.rented; i++) {
    const g = s.gpus ? gpuAt(s, i) : null
    const util = g && Number.isFinite(g.util) ? g.util : null
    if ((util != null && util > GPU_BUSY_UTIL_PCT) || runsOn(s, i) > 0) f.busy++
    if (util != null) {
      f.utilSum += util
      f.utilN++
    }
  }
  return f
}

/** One node's polls in one bucket, summed. */
interface NodeBucket {
  polls: number
  rented: number
  busy: number
  utilSum: number
  utilN: number
  /** Σ over polls of the idle share of its GPUs */
  idleShare: number
}

/**
 * The whole fleet's GPUs over a range (fleet:gpuHistory): GPUs rented, GPUs
 * busy, mean utilisation, and the $/hr paid for GPUs that were not busy
 * (each node's idle GPU share times its $/hr). Each figure is a node's mean
 * over its polls in the bucket, summed over nodes; a bucket where no node was
 * polled is all null. A node's $/hr is its row's (dph_total), which is fixed
 * for its life.
 */
export function fleetGpuHistory(q: MetricsHistoryQuery, now = Date.now()): FleetGpuHistory {
  const { fromMs, toMs, maxPoints } = rangeOf(q)
  const grid = bucketGrid(fromMs, toMs, maxPoints, MIN_BUCKET_MS)
  const perNode = new Map<string, Array<NodeBucket | null>>()
  const slot = (nodeId: string, b: number): NodeBucket | null => {
    if (b < 0 || b >= grid.count) return null
    let row = perNode.get(nodeId)
    if (!row) {
      row = new Array<NodeBucket | null>(grid.count).fill(null)
      perNode.set(nodeId, row)
    }
    return (row[b] ??= { polls: 0, rented: 0, busy: 0, utilSum: 0, utilN: 0, idleShare: 0 })
  }
  const cutoff = memoryCutoff(now)

  if (fromMs < cutoff) {
    try {
      const rows = getDb()
        .prepare(
          `SELECT node_id AS nodeId, CAST((ts - ?) / ? AS INTEGER) AS b, COUNT(*) AS polls,
                  SUM(g) AS rented, SUM(busy) AS busy, SUM(us) AS utilSum, SUM(un) AS utilN,
                  SUM(CAST(g - busy AS REAL) / g) AS idleShare
           FROM (SELECT node_id, ts, COUNT(*) AS g,
                        SUM(CASE WHEN util > ? OR runs > 0 THEN 1 ELSE 0 END) AS busy,
                        COALESCE(SUM(util), 0) AS us, COUNT(util) AS un
                 FROM node_metrics WHERE ts >= ? AND ts < ? GROUP BY node_id, ts)
           GROUP BY node_id, b`
        )
        .all(
          grid.start,
          grid.bucketMs,
          GPU_BUSY_UTIL_PCT,
          fromMs,
          Math.min(toMs, cutoff)
        ) as unknown as Array<{ nodeId: string; b: number } & NodeBucket>
      for (const r of rows) {
        const s = slot(r.nodeId, Number(r.b))
        if (!s) continue
        s.polls += Number(r.polls)
        s.rented += Number(r.rented)
        s.busy += Number(r.busy)
        s.utilSum += Number(r.utilSum)
        s.utilN += Number(r.utilN)
        s.idleShare += Number(r.idleShare)
      }
    } catch {
      // No table to read: memory's part stands on its own.
    }
  }
  for (const [nodeId, ring] of rings) {
    for (const sample of ring) {
      if (sample.ts < Math.max(fromMs, cutoff) || sample.ts >= toMs) continue
      const s = slot(nodeId, bucketOf(grid, sample.ts))
      if (!s) continue
      const f = pollFigures(sample)
      s.polls++
      s.rented += f.rented
      s.busy += f.busy
      s.utilSum += f.utilSum
      s.utilN += f.utilN
      s.idleShare += f.rented > 0 ? (f.rented - f.busy) / f.rented : 0
    }
  }

  const dph = new Map<string, number>()
  if (perNode.size > 0) {
    try {
      for (const r of getDb().prepare('SELECT id, dph_total FROM nodes').all() as Array<{
        id: string
        dph_total: number | null
      }>) {
        if (r.dph_total != null && Number.isFinite(r.dph_total)) dph.set(r.id, r.dph_total)
      }
    } catch {
      // Idle $/hr reads 0 without the rows' prices.
    }
  }
  const points: FleetGpuPoint[] = []
  for (let b = 0; b < grid.count; b++) {
    let polled = false
    let rented = 0
    let busy = 0
    let utilSum = 0
    let utilN = 0
    let idlePerHour = 0
    for (const [nodeId, row] of perNode) {
      const s = row[b]
      if (!s || s.polls === 0) continue
      polled = true
      rented += s.rented / s.polls
      busy += s.busy / s.polls
      utilSum += s.utilSum / s.polls
      utilN += s.utilN / s.polls
      idlePerHour += (s.idleShare / s.polls) * (dph.get(nodeId) ?? 0)
    }
    points.push({
      ts: grid.start + b * grid.bucketMs,
      gpusRented: polled ? rented : null,
      gpusBusy: polled ? busy : null,
      meanUtil: polled && utilN > 0 ? utilSum / utilN : null,
      idlePerHour: polled ? idlePerHour : null
    })
  }
  return { fromMs, toMs, bucketMs: grid.bucketMs, points }
}
