/**
 * Read side of the usage history — everything the History screen asks for, in
 * two queries plus a couple of aggregates. SQL lives here rather than in
 * ipc.ts, which is long enough already.
 *
 * The source is `usage_log`, written once a minute per node by
 * nodeManager.accrueCosts(). Rows with a job_id are attributed spend; rows
 * without are idle/provisioning time (and the one-off cost_log backfill, which
 * predates attribution). Both are real money, so totals always include them and
 * the UI shows the difference as overhead.
 */

import { co2Grams, intensityFor } from '../carbon/intensity'
import { getDb } from '../db/db'
import { getSettings } from '../settings'
import type {
  BalancePoint,
  EngineId,
  HistoryBucket,
  HistoryRange,
  HistorySummary,
  HistoryTotals,
  JobCostRow,
  JobState
} from '../../shared/models'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Window length per range; `all` is unbounded and resolved from the data. */
const RANGE_MS: Record<Exclude<HistoryRange, 'all'>, number> = {
  '1d': DAY,
  '7d': 7 * DAY,
  '30d': 30 * DAY
}

/**
 * Bucket width per range, chosen to land every chart between ~100 and ~290
 * points — dense enough to show shape, sparse enough that each bar is still
 * clickable. `all` scales with how much history exists.
 */
const BUCKET_MS: Record<Exclude<HistoryRange, 'all'>, number> = {
  '1d': 5 * MINUTE, //  288 buckets
  '7d': HOUR, //        168 buckets
  '30d': 6 * HOUR //    120 buckets
}

/** How many top-spending jobs the summary carries. */
const TOP_JOBS = 12

interface BucketRow {
  bucket: number
  cost: number
  wh: number
  power_sum: number | null
  ticks: number
  gpu_util: number | null
}

interface JobRow {
  job_id: string
  cost: number
  wh: number
  minutes: number
  name: string | null
  engine: EngineId | null
  state: JobState | null
  frames_done: number
}

/** Energy split by the grid it was drawn from — the input to every CO2 figure. */
interface GeoWh {
  geo: string | null
  wh: number
}

/**
 * CO2 has to be summed per grid, not per total: a kWh in Norway and a kWh in
 * Poland are twenty times apart, so `SUM(wh) × one_intensity` would be
 * meaningless for a mixed fleet. Every CO2 query therefore groups by the node's
 * location and folds here, where the JS lookup table lives.
 *
 * `nodes` is LEFT JOINed because a usage row can outlive nothing — node rows are
 * never deleted — but backfilled rows from the pre-history cost_log have node
 * ids that may not resolve, and those legitimately have no location.
 */
function foldCo2(rows: GeoWh[], overhead: number): number {
  return rows.reduce((total, r) => total + co2Grams(r.wh, r.geo, overhead), 0)
}

/** Epoch ms of the oldest usage row, or null when nothing has been recorded. */
export function earliestUsageMs(): number | null {
  const row = getDb().prepare('SELECT MIN(ts) AS t FROM usage_log').get() as { t: number | null }
  return row.t ?? null
}

/**
 * Resolve a range to its window start and bucket width. For `all`, the bucket
 * grows with the span so the point count stays bounded — a day per bucket up to
 * ~8 months of history, then wider.
 */
export function resolveRange(
  range: HistoryRange,
  now: number,
  earliest: number | null
): { fromMs: number; bucketMs: number } {
  if (range !== 'all') return { fromMs: now - RANGE_MS[range], bucketMs: BUCKET_MS[range] }
  const fromMs = earliest ?? now - DAY
  const span = Math.max(now - fromMs, HOUR)
  const bucketMs = Math.max(HOUR, Math.ceil(span / 240 / HOUR) * HOUR)
  return { fromMs, bucketMs }
}

/**
 * Bucketed series over `usage_log`.
 *
 * `delta_cost`/`delta_wh` are per-minute totals so they SUM across a bucket,
 * while power and utilisation are point samples so they average. AVG() ignores
 * NULLs, which is exactly what we want: a card that never reported wattage
 * leaves the average to the cards that did rather than pulling it to zero.
 *
 * A bucket with no rows is absent from the result — the caller fills the gap,
 * because "the app wasn't running" and "the fleet was idle" both mean zero
 * spend and neither should be interpolated across.
 */
function buckets(fromMs: number, bucketMs: number, overhead: number): HistoryBucket[] {
  const db = getDb()
  // Energy per (bucket, grid), so each bucket's CO2 can weight its nodes by
  // where they actually ran. At <=290 buckets x a handful of countries this is
  // a few hundred rows — cheaper than it looks, and far simpler than teaching
  // SQLite the intensity table.
  const co2ByBucket = new Map<number, GeoWh[]>()
  for (const r of db
    .prepare(
      `SELECT CAST(u.ts / ? AS INTEGER) * ? AS bucket,
              n.geolocation               AS geo,
              COALESCE(SUM(u.delta_wh), 0) AS wh
         FROM usage_log u LEFT JOIN nodes n ON n.id = u.node_id
        WHERE u.ts >= ?
        GROUP BY bucket, geo`
    )
    .all(bucketMs, bucketMs, fromMs) as Array<{ bucket: number; geo: string | null; wh: number }>) {
    const list = co2ByBucket.get(r.bucket)
    if (list) list.push(r)
    else co2ByBucket.set(r.bucket, [r])
  }

  // Mean concurrent fleet size per bucket. See concurrencyByBucket: a plain
  // COUNT(DISTINCT node_id) over the bucket counts nodes RECYCLED through it,
  // which on a wide bucket reads many times the fleet that ever ran at once.
  const meanNodes = concurrencyByBucket(fromMs, bucketMs)

  const rows = db
    .prepare(
      // CAST is load-bearing: a bound JS number can arrive as REAL, and then
      // `ts / ?` is float division and every row lands in its own "bucket".
      `SELECT CAST(ts / ? AS INTEGER) * ? AS bucket,
              COALESCE(SUM(delta_cost), 0) AS cost,
              COALESCE(SUM(delta_wh), 0)   AS wh,
              SUM(power_w)                 AS power_sum,
              COUNT(DISTINCT ts)           AS ticks,
              AVG(gpu_util)                AS gpu_util
         FROM usage_log
        WHERE ts >= ?
        GROUP BY bucket
        ORDER BY bucket`
    )
    .all(bucketMs, bucketMs, fromMs) as BucketRow[]
  return rows.map((r) => ({
    tsStart: r.bucket,
    cost: r.cost,
    wh: r.wh,
    co2g: foldCo2(co2ByBucket.get(r.bucket) ?? [], overhead),
    // Mean *fleet* draw: total watts observed across the bucket's ticks divided
    // by how many ticks there were, so three nodes at 300 W reads 900 W.
    avgPowerW: r.power_sum != null && r.ticks > 0 ? r.power_sum / r.ticks : null,
    gpuUtil: r.gpu_util,
    nodeCount: meanNodes.get(r.bucket) ?? 0
  }))
}

/**
 * Mean nodes running AT ONCE, per bucket.
 *
 * `usage_log` holds one row per (node, job) share per minute, so fleet size is a
 * property of a single tick — not of a bucket. `COUNT(DISTINCT node_id)` over a
 * 6-hour bucket counts every node that passed through it, so a 2-node fleet
 * recycling machines every 15 minutes reported ~24, contradicting the node-hours
 * figure on the same screen. Count per tick first, then average.
 *
 * Ticks are quantised to the MINUTE rather than grouped on raw `ts`. The current
 * accrual stamps one timestamp per tick across all nodes, but rows imported from
 * `cost_log` by the v1 backfill (and those written by pre-2.1 builds, which
 * called Date.now() inside the per-node loop) differ by a few milliseconds — a
 * strict GROUP BY ts would report a concurrency of 1 for all of that history.
 *
 * Like `avgPowerW`, the mean is over ticks that EXIST: a bucket the app was
 * closed for contributes nothing rather than dragging the average toward zero.
 */
function concurrencyByBucket(fromMs: number, bucketMs: number): Map<number, number> {
  const out = new Map<number, number>()
  for (const r of getDb()
    .prepare(
      `SELECT CAST(tick * 60000 / ? AS INTEGER) * ? AS bucket,
              SUM(n) * 1.0 / COUNT(*)          AS mean_nodes
         FROM (SELECT CAST(ts / 60000 AS INTEGER) AS tick,
                      COUNT(DISTINCT node_id)     AS n
                 FROM usage_log
                WHERE ts >= ?
                GROUP BY tick)
        GROUP BY bucket`
    )
    .all(bucketMs, bucketMs, fromMs) as Array<{ bucket: number; mean_nodes: number }>) {
    out.set(r.bucket, r.mean_nodes)
  }
  return out
}

/** The largest number of nodes that ever billed in the same minute. */
function peakConcurrency(fromMs: number): number {
  const row = getDb()
    .prepare(
      `SELECT MAX(n) AS peak FROM (
         SELECT COUNT(DISTINCT node_id) AS n
           FROM usage_log WHERE ts >= ?
          GROUP BY CAST(ts / 60000 AS INTEGER))`
    )
    .get(fromMs) as { peak: number | null }
  return row.peak ?? 0
}

/**
 * Balance readings in the window, anchored on the left.
 *
 * balance_log only records changes, so a quiet week contains no points at all
 * even though the balance is perfectly well known. Prepending the last reading
 * at or before `fromMs` (restamped to the window edge) lets the step line start
 * at the right height instead of the chart looking empty.
 */
function balancePoints(fromMs: number): BalancePoint[] {
  const db = getDb()
  const inRange = db
    .prepare('SELECT ts, balance FROM balance_log WHERE ts >= ? ORDER BY ts')
    .all(fromMs) as BalancePoint[]
  const anchor = db
    .prepare('SELECT ts, balance FROM balance_log WHERE ts < ? ORDER BY ts DESC LIMIT 1')
    .get(fromMs) as BalancePoint | undefined
  return anchor ? [{ ts: fromMs, balance: anchor.balance }, ...inRange] : inRange
}

/**
 * Spend per job over the window, richest first.
 *
 * `minutes` counts accrual ticks, so node-hours = minutes / 60 — a job on two
 * nodes for an hour correctly reads as two node-hours. Frames come from the
 * `frames` table rather than `chunks.frames_done`, which is reset by requeues.
 */
function topJobs(fromMs: number, limit: number, overhead: number): JobCostRow[] {
  const db = getDb()
  const co2ByJob = new Map<string, GeoWh[]>()
  for (const r of db
    .prepare(
      `SELECT u.job_id AS job_id, n.geolocation AS geo, COALESCE(SUM(u.delta_wh), 0) AS wh
         FROM usage_log u LEFT JOIN nodes n ON n.id = u.node_id
        WHERE u.job_id IS NOT NULL AND u.ts >= ?
        GROUP BY u.job_id, geo`
    )
    .all(fromMs) as Array<{ job_id: string; geo: string | null; wh: number }>) {
    const list = co2ByJob.get(r.job_id)
    if (list) list.push(r)
    else co2ByJob.set(r.job_id, [r])
  }

  const rows = db
    .prepare(
      `SELECT u.job_id                      AS job_id,
              SUM(u.delta_cost)             AS cost,
              SUM(u.delta_wh)               AS wh,
              COUNT(*)                      AS minutes,
              j.name                        AS name,
              j.engine                      AS engine,
              j.state                       AS state,
              (SELECT COUNT(*) FROM frames f
                WHERE f.job_id = u.job_id AND f.state = 'downloaded') AS frames_done
         FROM usage_log u
         LEFT JOIN jobs j ON j.id = u.job_id
        WHERE u.job_id IS NOT NULL AND u.ts >= ?
        GROUP BY u.job_id
        ORDER BY cost DESC
        LIMIT ?`
    )
    .all(fromMs, limit) as JobRow[]
  return rows.map((r) => ({
    jobId: r.job_id,
    name: r.name,
    engine: r.engine,
    state: r.state,
    cost: r.cost,
    wh: r.wh,
    co2g: foldCo2(co2ByJob.get(r.job_id) ?? [], overhead),
    gpuHours: r.minutes / 60,
    framesDone: r.frames_done,
    costPerFrame: r.frames_done > 0 ? r.cost / r.frames_done : null
  }))
}

/** Spend that no job can be blamed for: idle, provisioning, backfilled rows. */
function unattributed(fromMs: number): { cost: number; wh: number } {
  return getDb()
    .prepare(
      `SELECT COALESCE(SUM(delta_cost), 0) AS cost, COALESCE(SUM(delta_wh), 0) AS wh
         FROM usage_log WHERE job_id IS NULL AND ts >= ?`
    )
    .get(fromMs) as { cost: number; wh: number }
}

/**
 * Energy over the window split by the grid that supplied it, with the
 * job-less share carried alongside — one scan serves the range CO2 total, the
 * unattributed CO2 and the "which grids was this costed against" breakdown.
 */
function energyByGrid(fromMs: number): Array<GeoWh & { whUnattributed: number }> {
  return getDb()
    .prepare(
      `SELECT n.geolocation AS geo,
              COALESCE(SUM(u.delta_wh), 0) AS wh,
              COALESCE(SUM(CASE WHEN u.job_id IS NULL THEN u.delta_wh ELSE 0 END), 0)
                AS whUnattributed
         FROM usage_log u LEFT JOIN nodes n ON n.id = u.node_id
        WHERE u.ts >= ?
        GROUP BY geo`
    )
    .all(fromMs) as Array<GeoWh & { whUnattributed: number }>
}

function totals(
  fromMs: number,
  points: BalancePoint[],
  grids: Array<GeoWh & { whUnattributed: number }>,
  overhead: number
): HistoryTotals {
  const db = getDb()
  const agg = db
    .prepare(
      `SELECT COALESCE(SUM(delta_cost), 0) AS cost,
              COALESCE(SUM(delta_wh), 0)   AS wh,
              COUNT(DISTINCT ts || '/' || node_id) AS node_ticks,
              SUM(power_w)                 AS power_sum,
              COUNT(DISTINCT ts)           AS ticks
         FROM usage_log WHERE ts >= ?`
    )
    .get(fromMs) as {
    cost: number
    wh: number
    node_ticks: number
    power_sum: number | null
    ticks: number
  }
  // Peak *fleet* draw, not peak single card: sum each tick, then take the max.
  const peak = db
    .prepare(
      `SELECT MAX(p) AS peak FROM (
         SELECT SUM(power_w) AS p FROM usage_log WHERE ts >= ? GROUP BY ts)`
    )
    .get(fromMs) as { peak: number | null }
  return {
    cost: agg.cost,
    wh: agg.wh,
    co2g: foldCo2(grids, overhead),
    // Cleanest grid first, so the UI leads with the best case rather than an
    // arbitrary row order. Zero-energy grids are noise, not provenance.
    co2Sources: grids
      .filter((g) => g.wh > 0)
      .map((g) => ({ ...intensityFor(g.geo), wh: g.wh }))
      .map(({ country, gPerKwh, wh }) => ({ country, gPerKwh, wh }))
      .sort((a, b) => a.gPerKwh - b.gPerKwh),
    // One distinct (tick, node) pair is one node-minute of billing. Counting
    // rows would over-report, since a node running two jobs writes two rows.
    nodeHours: agg.node_ticks / 60,
    avgPowerW: agg.power_sum != null && agg.ticks > 0 ? agg.power_sum / agg.ticks : null,
    peakPowerW: peak.peak,
    // Range-wide, not the worst bucket's: taking a max over bucket values would
    // inherit whatever those values mean, and a mean can never show the peak.
    peakNodes: peakConcurrency(fromMs),
    balanceStart: points.length ? points[0].balance : null,
    balanceEnd: points.length ? points[points.length - 1].balance : null
  }
}

/** Everything the History screen renders, for one range. */
export function summary(range: HistoryRange, now = Date.now()): HistorySummary {
  const earliestMs = earliestUsageMs()
  const { fromMs, bucketMs } = resolveRange(range, now, earliestMs)
  const points = balancePoints(fromMs)
  const idle = unattributed(fromMs)
  const grids = energyByGrid(fromMs)
  // GPU draw → whole-facility, for the CO2 figures only. Read once per summary
  // so every number in the payload rests on the same assumption.
  const overhead = getSettings().co2OverheadFactor
  return {
    range,
    bucketMs,
    fromMs,
    earliestMs,
    buckets: buckets(fromMs, bucketMs, overhead),
    balancePoints: points,
    totals: totals(fromMs, points, grids, overhead),
    topJobs: topJobs(fromMs, TOP_JOBS, overhead),
    unattributedCost: idle.cost,
    unattributedWh: idle.wh,
    unattributedCo2g: foldCo2(
      grids.map((g) => ({ geo: g.geo, wh: g.whUnattributed })),
      overhead
    )
  }
}
