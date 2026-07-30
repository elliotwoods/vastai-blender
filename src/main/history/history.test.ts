import { readFileSync } from 'fs'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HistoryRange } from '../../shared/models'
import { GRID_INTENSITY, WORLD_AVERAGE } from '../carbon/intensity'

// Two swaps make these queries testable outside Electron:
//  - getDb() reaches for electron's userData path, so it's mocked out;
//  - better-sqlite3's native binary is built against Electron's ABI and won't
//    load under plain node, so the fixture DB is node's own SQLite. Both speak
//    the same prepare/all/get/run surface these queries use.
const h = vi.hoisted(() => ({ db: null as unknown as DatabaseSync }))
vi.mock('../db/db', () => ({ getDb: () => h.db }))
// settings.ts reaches for electron's app paths. Overhead 1 keeps the CO2
// arithmetic below readable — the factor's own behaviour is covered in
// carbon/intensity.test.ts.
vi.mock('../settings', () => ({ getSettings: () => ({ co2OverheadFactor: 1 }) }))

const { resolveRange, summary } = await import('./history')

const SCHEMA = readFileSync(fileURLToPath(new URL('../db/schema.sql', import.meta.url)), 'utf8')

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const NOW = 1_700_000_000_000
/**
 * Buckets are aligned to absolute epoch multiples, not to `now`, so tests that
 * care which bucket a row lands in start from an aligned instant an hour back.
 */
const ALIGNED = Math.floor((NOW - HOUR) / (5 * MINUTE)) * (5 * MINUTE)

interface Tick {
  ts: number
  nodeId: string
  jobId?: string | null
  cost?: number
  wh?: number
  powerW?: number | null
  gpuUtil?: number | null
}

function usage(rows: Tick[]): void {
  const stmt = h.db.prepare(
    `INSERT INTO usage_log (ts, node_id, job_id, chunk_id, delta_cost, delta_wh, power_w, gpu_util)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`
  )
  for (const r of rows) {
    stmt.run(
      r.ts,
      r.nodeId,
      r.jobId ?? null,
      r.cost ?? 0.01,
      r.wh ?? 0,
      r.powerW ?? null,
      r.gpuUtil ?? null
    )
  }
}

function job(id: string, name: string): void {
  h.db
    .prepare(
      `INSERT INTO jobs (id, name, blend_path, engine, frame_start, frame_end, frame_step,
                         state, addon_ids, output_dir, cost_so_far, submitted_at)
       VALUES (?, ?, '/x.blend', 'cycles', 1, 10, 1, 'complete', '[]', '/out', 0, ?)`
    )
    .run(id, name, NOW - DAY)
}

/** A node row, which is where a usage row's grid intensity comes from. */
function node(id: string, geolocation: string | null): void {
  h.db
    .prepare(`INSERT INTO nodes (id, state, geolocation) VALUES (?, 'destroyed', ?)`)
    .run(id, geolocation)
}

function frames(jobId: string, n: number): void {
  const stmt = h.db.prepare(
    `INSERT INTO frames (job_id, frame, chunk_id, state) VALUES (?, ?, 'c1', 'downloaded')`
  )
  for (let i = 1; i <= n; i++) stmt.run(jobId, i)
}

beforeEach(() => {
  h.db = new DatabaseSync(':memory:')
  h.db.exec(SCHEMA)
})

describe('resolveRange', () => {
  it('uses a fixed window and bucket per named range', () => {
    expect(resolveRange('1d', NOW, null)).toEqual({ fromMs: NOW - DAY, bucketMs: 5 * MINUTE })
    expect(resolveRange('7d', NOW, null)).toEqual({ fromMs: NOW - 7 * DAY, bucketMs: HOUR })
    expect(resolveRange('30d', NOW, null)).toEqual({ fromMs: NOW - 30 * DAY, bucketMs: 6 * HOUR })
  })

  it('grows the "all" bucket with the span so the point count stays bounded', () => {
    const short = resolveRange('all', NOW, NOW - 2 * DAY)
    const long = resolveRange('all', NOW, NOW - 300 * DAY)
    expect(short.fromMs).toBe(NOW - 2 * DAY)
    expect(long.bucketMs).toBeGreaterThan(short.bucketMs)
    for (const r of [short, long]) {
      expect(Math.ceil((NOW - r.fromMs) / r.bucketMs)).toBeLessThanOrEqual(240)
    }
  })

  it('falls back to a day when nothing has been recorded', () => {
    expect(resolveRange('all', NOW, null).fromMs).toBe(NOW - DAY)
  })
})

describe('summary — bucketing', () => {
  it('sums quantities within a bucket and keeps buckets separate', () => {
    // Three minutes inside one 5-minute bucket, one in the next.
    usage([
      { ts: ALIGNED, nodeId: 'n1', cost: 0.01, wh: 5 },
      { ts: ALIGNED + MINUTE, nodeId: 'n1', cost: 0.01, wh: 5 },
      { ts: ALIGNED + 2 * MINUTE, nodeId: 'n1', cost: 0.01, wh: 5 },
      { ts: ALIGNED + 6 * MINUTE, nodeId: 'n1', cost: 0.02, wh: 7 }
    ])
    const s = summary('1d', NOW)
    expect(s.buckets).toHaveLength(2)
    expect(s.buckets[0].tsStart).toBe(ALIGNED)
    expect(s.buckets[0].cost).toBeCloseTo(0.03, 6)
    expect(s.buckets[0].wh).toBeCloseTo(15, 6)
    expect(s.buckets[1].tsStart).toBe(ALIGNED + 5 * MINUTE)
    expect(s.buckets[1].cost).toBeCloseTo(0.02, 6)
  })

  it('excludes anything older than the window', () => {
    usage([
      { ts: NOW - 3 * DAY, nodeId: 'n1', cost: 5 },
      { ts: NOW - 2 * HOUR, nodeId: 'n1', cost: 1 }
    ])
    expect(summary('1d', NOW).totals.cost).toBeCloseTo(1, 6)
    expect(summary('7d', NOW).totals.cost).toBeCloseTo(6, 6)
  })

  it('reports mean concurrent nodes per bucket, and the range peak', () => {
    const t = ALIGNED
    // Two nodes in one minute, one in the next → peak 2, mean 1.5.
    usage([
      { ts: t, nodeId: 'n1' },
      { ts: t, nodeId: 'n2' },
      { ts: t + MINUTE, nodeId: 'n1' }
    ])
    const s = summary('1d', NOW)
    expect(s.buckets[0].nodeCount).toBeCloseTo(1.5, 6)
    expect(s.totals.peakNodes).toBe(2)
  })

  it('does not mistake nodes recycled through a bucket for a bigger fleet', () => {
    // The defect this replaced: three DIFFERENT nodes, one at a time, one after
    // another. A COUNT(DISTINCT node_id) over the bucket called that a fleet of
    // 3 — on a 6h bucket with 15-minute machines it read ~24 for a 2-node fleet,
    // contradicting the node-hours figure beside it.
    const t = ALIGNED
    usage([
      { ts: t, nodeId: 'n1' },
      { ts: t + MINUTE, nodeId: 'n2' },
      { ts: t + 2 * MINUTE, nodeId: 'n3' }
    ])
    const s = summary('1d', NOW)
    expect(s.buckets[0].nodeCount).toBeCloseTo(1, 6)
    expect(s.totals.peakNodes).toBe(1)
    // ...while the node-minutes they billed are unchanged: 3 node-minutes.
    expect(s.totals.nodeHours).toBeCloseTo(3 / 60, 6)
  })

  it('counts concurrency for rows whose tick timestamps differ by milliseconds', () => {
    // Rows imported from cost_log by the v1 backfill (and those written by
    // pre-2.1 builds, which stamped Date.now() per node) do not share an exact
    // tick ts. Grouping on raw ts would report a concurrency of 1 forever.
    const t = ALIGNED
    usage([
      { ts: t, nodeId: 'n1' },
      { ts: t + 7, nodeId: 'n2' },
      { ts: t + 15, nodeId: 'n3' }
    ])
    expect(summary('1d', NOW).totals.peakNodes).toBe(3)
  })
})

describe('summary — power', () => {
  it('reports mean and peak fleet draw, not per-node draw', () => {
    const t = ALIGNED
    // Two nodes at 300 W for one tick, then one node at 300 W for the next.
    usage([
      { ts: t, nodeId: 'n1', powerW: 300 },
      { ts: t, nodeId: 'n2', powerW: 300 },
      { ts: t + MINUTE, nodeId: 'n1', powerW: 300 }
    ])
    const s = summary('1d', NOW)
    expect(s.totals.peakPowerW).toBe(600)
    // (600 + 300) / 2 ticks
    expect(s.totals.avgPowerW).toBeCloseTo(450, 6)
    expect(s.buckets[0].avgPowerW).toBeCloseTo(450, 6)
  })

  it('ignores nodes that never report wattage rather than counting them as 0 W', () => {
    const t = NOW - 30 * MINUTE
    usage([
      { ts: t, nodeId: 'n1', powerW: 400 },
      { ts: t, nodeId: 'n2', powerW: null }
    ])
    expect(summary('1d', NOW).totals.avgPowerW).toBeCloseTo(400, 6)
  })

  it('leaves power null when nothing ever reported it', () => {
    usage([{ ts: NOW - 30 * MINUTE, nodeId: 'n1' }])
    const s = summary('1d', NOW)
    expect(s.totals.avgPowerW).toBeNull()
    expect(s.totals.peakPowerW).toBeNull()
  })
})

describe('summary — node hours', () => {
  it('counts node-minutes, not rows, so a split node is not double-counted', () => {
    const t = NOW - 30 * MINUTE
    // One node, one tick, but two job rows because it ran two jobs at once.
    usage([
      { ts: t, nodeId: 'n1', jobId: 'job-a', cost: 0.005 },
      { ts: t, nodeId: 'n1', jobId: 'job-b', cost: 0.005 }
    ])
    expect(summary('1d', NOW).totals.nodeHours).toBeCloseTo(1 / 60, 9)
  })

  it('adds up across nodes', () => {
    const t = NOW - 30 * MINUTE
    usage([
      { ts: t, nodeId: 'n1' },
      { ts: t, nodeId: 'n2' },
      { ts: t + MINUTE, nodeId: 'n1' }
    ])
    expect(summary('1d', NOW).totals.nodeHours).toBeCloseTo(3 / 60, 9)
  })
})

describe('summary — job attribution', () => {
  it('ranks jobs by cost and derives per-frame cost', () => {
    job('job-a', 'hero')
    job('job-b', 'plate')
    frames('job-a', 10)
    frames('job-b', 4)
    const t = NOW - 2 * HOUR
    usage([
      { ts: t, nodeId: 'n1', jobId: 'job-a', cost: 0.6, wh: 30 },
      { ts: t + MINUTE, nodeId: 'n1', jobId: 'job-a', cost: 0.4, wh: 20 },
      { ts: t, nodeId: 'n2', jobId: 'job-b', cost: 0.2, wh: 10 }
    ])
    const s = summary('1d', NOW)
    expect(s.topJobs.map((j) => j.jobId)).toEqual(['job-a', 'job-b'])
    const a = s.topJobs[0]
    expect(a.name).toBe('hero')
    expect(a.cost).toBeCloseTo(1, 6)
    expect(a.wh).toBeCloseTo(50, 6)
    expect(a.gpuHours).toBeCloseTo(2 / 60, 9)
    expect(a.framesDone).toBe(10)
    expect(a.costPerFrame).toBeCloseTo(0.1, 6)
  })

  it('keeps idle and provisioning spend out of the job rows but inside the total', () => {
    job('job-a', 'hero')
    const t = NOW - 2 * HOUR
    usage([
      { ts: t, nodeId: 'n1', jobId: 'job-a', cost: 0.7, wh: 20 },
      { ts: t, nodeId: 'n2', jobId: null, cost: 0.3, wh: 5 }
    ])
    const s = summary('1d', NOW)
    expect(s.topJobs).toHaveLength(1)
    expect(s.unattributedCost).toBeCloseTo(0.3, 6)
    expect(s.unattributedWh).toBeCloseTo(5, 6)
    // Attributed + unattributed must reconcile to the headline number.
    expect(s.topJobs[0].cost + s.unattributedCost).toBeCloseTo(s.totals.cost, 6)
  })

  it('survives a job row that has since been deleted', () => {
    usage([{ ts: NOW - HOUR, nodeId: 'n1', jobId: 'ghost', cost: 0.5 }])
    const s = summary('1d', NOW)
    expect(s.topJobs[0]).toMatchObject({ jobId: 'ghost', name: null, costPerFrame: null })
  })
})

describe('summary — balance', () => {
  it('anchors the series at the window edge using the last earlier reading', () => {
    h.db.prepare('INSERT INTO balance_log (ts, balance) VALUES (?, ?)').run(NOW - 5 * DAY, 90)
    h.db.prepare('INSERT INTO balance_log (ts, balance) VALUES (?, ?)').run(NOW - 2 * HOUR, 80)
    const s = summary('1d', NOW)
    // The 5-day-old reading is outside the window but still describes the
    // balance at its left edge.
    expect(s.balancePoints).toEqual([
      { ts: NOW - DAY, balance: 90 },
      { ts: NOW - 2 * HOUR, balance: 80 }
    ])
    expect(s.totals.balanceStart).toBe(90)
    expect(s.totals.balanceEnd).toBe(80)
  })

  it('reports null endpoints when nothing was ever recorded', () => {
    const s = summary('1d', NOW)
    expect(s.balancePoints).toEqual([])
    expect(s.totals.balanceStart).toBeNull()
    expect(s.totals.balanceEnd).toBeNull()
  })
})

describe('summary — CO2 by grid', () => {
  it('costs each node against its own country, not one blended figure', () => {
    node('n-clean', 'Norway, NO')
    node('n-dirty', 'Poland, PL')
    const t = ALIGNED
    // Identical energy on both nodes.
    usage([
      { ts: t, nodeId: 'n-clean', wh: 1000 },
      { ts: t, nodeId: 'n-dirty', wh: 1000 }
    ])
    const s = summary('1d', NOW)
    // 1 kWh each, at overhead 1 → exactly the two table values summed.
    expect(s.totals.co2g).toBeCloseTo(GRID_INTENSITY.NO + GRID_INTENSITY.PL, 6)
    // A blended average would have produced 2 × the mean; it must not.
    expect(s.totals.co2g).not.toBeCloseTo(2000 * (WORLD_AVERAGE / 1000), 6)
  })

  it('falls back to the world average when a node has no recorded location', () => {
    node('n1', null)
    usage([{ ts: ALIGNED, nodeId: 'n1', wh: 1000 }])
    expect(summary('1d', NOW).totals.co2g).toBeCloseTo(WORLD_AVERAGE, 6)
  })

  it('falls back for backfilled rows whose node row never existed', () => {
    // cost_log rows imported from before the nodes table tracked location.
    usage([{ ts: ALIGNED, nodeId: 'ghost-node', wh: 1000 }])
    expect(summary('1d', NOW).totals.co2g).toBeCloseTo(WORLD_AVERAGE, 6)
  })

  it('reports the grids it used, cleanest first', () => {
    node('n-clean', 'Norway, NO')
    node('n-dirty', 'Poland, PL')
    const t = ALIGNED
    usage([
      { ts: t, nodeId: 'n-clean', wh: 500 },
      { ts: t, nodeId: 'n-dirty', wh: 1500 }
    ])
    const src = summary('1d', NOW).totals.co2Sources
    expect(src).toEqual([
      { country: 'NO', gPerKwh: GRID_INTENSITY.NO, wh: 500 },
      { country: 'PL', gPerKwh: GRID_INTENSITY.PL, wh: 1500 }
    ])
  })

  it('leaves grids that supplied no energy out of the breakdown', () => {
    node('n1', 'Poland, PL')
    node('n2', 'Norway, NO')
    usage([
      { ts: ALIGNED, nodeId: 'n1', wh: 100 },
      { ts: ALIGNED, nodeId: 'n2', wh: 0 }
    ])
    expect(summary('1d', NOW).totals.co2Sources).toEqual([
      { country: 'PL', gPerKwh: GRID_INTENSITY.PL, wh: 100 }
    ])
  })

  it('reconciles per-job CO2 with unattributed against the range total', () => {
    job('job-a', 'hero')
    node('n1', 'Germany, DE')
    node('n2', 'Norway, NO')
    const t = ALIGNED
    usage([
      { ts: t, nodeId: 'n1', jobId: 'job-a', wh: 800 },
      { ts: t, nodeId: 'n2', jobId: 'job-a', wh: 400 },
      { ts: t, nodeId: 'n1', jobId: null, wh: 300 }
    ])
    const s = summary('1d', NOW)
    expect(s.topJobs).toHaveLength(1)
    // The job ran on two grids; its CO2 must reflect both, not either one.
    expect(s.topJobs[0].co2g).toBeCloseTo(
      (800 / 1000) * GRID_INTENSITY.DE + (400 / 1000) * GRID_INTENSITY.NO,
      6
    )
    expect(s.unattributedCo2g).toBeCloseTo((300 / 1000) * GRID_INTENSITY.DE, 6)
    expect(s.topJobs[0].co2g + s.unattributedCo2g).toBeCloseTo(s.totals.co2g, 6)
  })

  it('gives each bucket its own CO2', () => {
    node('n1', 'Poland, PL')
    usage([
      { ts: ALIGNED, nodeId: 'n1', wh: 1000 },
      { ts: ALIGNED + 6 * MINUTE, nodeId: 'n1', wh: 2000 }
    ])
    const s = summary('1d', NOW)
    expect(s.buckets).toHaveLength(2)
    expect(s.buckets[0].co2g).toBeCloseTo(GRID_INTENSITY.PL, 6)
    expect(s.buckets[1].co2g).toBeCloseTo(GRID_INTENSITY.PL * 2, 6)
    expect(s.buckets[0].co2g + s.buckets[1].co2g).toBeCloseTo(s.totals.co2g, 6)
  })
})

describe('summary — empty database', () => {
  it('returns a well-formed, zeroed summary', () => {
    for (const r of ['1d', '7d', '30d', 'all'] as HistoryRange[]) {
      const s = summary(r, NOW)
      expect(s.buckets).toEqual([])
      expect(s.topJobs).toEqual([])
      expect(s.earliestMs).toBeNull()
      expect(s.totals.cost).toBe(0)
      expect(s.totals.nodeHours).toBe(0)
      expect(s.totals.co2g).toBe(0)
      expect(s.totals.co2Sources).toEqual([])
      expect(s.unattributedCo2g).toBe(0)
    }
  })
})
