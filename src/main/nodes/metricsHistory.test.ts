/**
 * Feature G's data side (metricsHistory.ts) on node's own SQLite, built by
 * db.ts's applySchema as the app builds its own (see test/sqlite.ts): the
 * bucketing the graphs draw, the memory ring and its eviction, the 7-day
 * prune, gap samples, and the fleet graph's figures, read from memory and
 * from the table alike.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GpuSample, MetricsSample, NodeMetrics, NodeWorkRef } from '../../shared/models'
import type { Db } from '../db/db'
import { openTestDb } from '../test/sqlite'

// db.ts imports electron for getDb's userData path; every database here is
// in memory, handed out by the mock below.
vi.mock('electron', () => ({
  app: {
    getPath: () => {
      throw new Error('metricsHistory.test: getDb() must not reach electron')
    }
  }
}))
const h = vi.hoisted(() => ({ db: null as unknown as Db, broken: false }))
vi.mock('../db/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('../db/db')>()
  return {
    ...real,
    getDb: () => {
      if (h.broken) throw new Error('SQLITE_FULL: database or disk is full')
      return h.db
    }
  }
})

type Mh = typeof import('./metricsHistory')

const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** An instant on a whole hour, so buckets line up with the samples below. */
const T0 = 1_700_002_800_000

let mh: Mh

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  h.broken = false
  const { applySchema } = await vi.importActual<typeof import('../db/db')>('../db/db')
  h.db = openTestDb(applySchema)
  // Fresh rings and listeners for each test.
  vi.resetModules()
  mh = await import('./metricsHistory')
})
afterEach(() => {
  vi.useRealTimers()
})

function gpu(index: number, util: number, extra: Partial<GpuSample> = {}): GpuSample {
  return { index, util, vramUsedGb: 12, vramTotalGb: 24, temp: 60, powerW: 300, ...extra }
}

/** A probe's sample, as nodeManager's recordSample builds it. */
function metrics(ts: number, gpus: GpuSample[], extra: Partial<NodeMetrics> = {}): NodeMetrics {
  return {
    gpuUtil: gpus.reduce((a, g) => a + g.util, 0) / gpus.length,
    vramUsedGb: 0,
    vramTotalGb: 0,
    gpuTemp: 60,
    powerW: 0,
    powerLimitW: 0,
    cpuUtil: 40,
    cpuLoad1: 1,
    cpuCores: 32,
    ramUsedGb: 20,
    ramTotalGb: 128,
    updatedAt: ts,
    gpus,
    ...extra
  }
}

function work(...gpus: Array<number | null>): NodeWorkRef[] {
  return gpus.map((g, i) => ({ chunkId: `c${i}`, jobId: 'job-1', gpu: g }))
}

function addNode(id: string, dph: number, numGpus: number): void {
  h.db
    .prepare(
      `INSERT INTO nodes (id, instance_id, state, num_gpus, dph_total) VALUES (?, ?, 'rendering', ?, ?)`
    )
    .run(id, Math.floor(Math.random() * 1e6), numGpus, dph)
}

function rows(sql: string, ...args: unknown[]): Array<Record<string, unknown>> {
  return h.db.prepare(sql).all(...args) as Array<Record<string, unknown>>
}

describe('bucketize', () => {
  it('Feature G: no samples at all is a range of gaps, never zeros', () => {
    const { bucketMs, points } = mh.bucketize([], T0 - HOUR, T0, 61)
    expect(bucketMs).toBe(MINUTE)
    expect(points).toHaveLength(60)
    expect(points.every((p) => p.mean === null && p.min === null && p.max === null)).toBe(true)
    expect(points[0].ts).toBe(T0 - HOUR)
    expect(points[59].ts).toBe(T0 - MINUTE)
  })

  it('Feature G: a gap sample breaks the line; a bucket with readings and a gap keeps the readings', () => {
    const samples = [
      { ts: T0 - 3 * MINUTE + 5 * SECOND, value: 50 },
      { ts: T0 - 3 * MINUTE + 20 * SECOND, value: 100 },
      { ts: T0 - 2 * MINUTE + 5 * SECOND, value: null },
      { ts: T0 - 2 * MINUTE + 20 * SECOND, value: null },
      { ts: T0 - MINUTE + 5 * SECOND, value: 30 },
      { ts: T0 - MINUTE + 20 * SECOND, value: null }
    ]
    const { points } = mh.bucketize(samples, T0 - 3 * MINUTE, T0, 4)
    expect(points).toEqual([
      { ts: T0 - 3 * MINUTE, mean: 75, min: 50, max: 100 },
      { ts: T0 - 2 * MINUTE, mean: null, min: null, max: null },
      { ts: T0 - MINUTE, mean: 30, min: 30, max: 30 }
    ])
  })

  it('Feature G: a range wider than the retention stays within maxPoints, empty where nothing is kept', () => {
    // A 30-day range over a week of hourly samples.
    const samples = Array.from({ length: 7 * 24 }, (_, i) => ({
      ts: T0 - 7 * DAY + i * HOUR,
      value: 50
    }))
    const { bucketMs, points } = mh.bucketize(samples, T0 - 30 * DAY, T0, 200)
    expect(points.length).toBeLessThanOrEqual(200)
    expect(bucketMs).toBeGreaterThanOrEqual((30 * DAY) / 200)
    const kept = points.filter((p) => p.mean !== null)
    expect(kept.length).toBeGreaterThan(0)
    for (const p of points) {
      if (p.ts + bucketMs <= T0 - 7 * DAY) expect(p.mean).toBeNull()
    }
    expect(kept.every((p) => p.mean === 50)).toBe(true)
  })

  it('Feature G: samples outside the range are left out, and the buckets do not shift as the range slides', () => {
    const samples = [
      { ts: T0 - 2 * HOUR, value: 99 },
      { ts: T0 - 10 * MINUTE, value: 10 },
      { ts: T0 + MINUTE, value: 99 }
    ]
    const a = mh.bucketize(samples, T0 - HOUR, T0, 12)
    const b = mh.bucketize(samples, T0 - HOUR + 17 * SECOND, T0 + 17 * SECOND, 12)
    expect(a.points.filter((p) => p.mean !== null).map((p) => p.mean)).toEqual([10])
    expect(b.bucketMs).toBe(a.bucketMs)
    // The same edges, epoch-aligned, whatever the range's own start.
    expect(b.points.every((p) => p.ts % b.bucketMs === 0)).toBe(true)
    expect(a.points.map((p) => p.ts)).toEqual(
      expect.arrayContaining(b.points.slice(1, -1).map((p) => p.ts))
    )
  })

  it('Feature G: a history read never returns a bucket narrower than the polls, which would read as gaps', () => {
    const grid = mh.bucketGrid(T0 - 15 * MINUTE, T0, 1_000, mh.MIN_BUCKET_MS)
    expect(grid.bucketMs).toBe(mh.MIN_BUCKET_MS)
    expect(grid.count).toBe(30)
    // One bucket asked for is one bucket, however the range lies.
    expect(mh.bucketGrid(T0 - 7 * MINUTE, T0 + 13 * SECOND, 1)).toMatchObject({ count: 1 })
    for (const maxPoints of [1, 2, 7, 60, 300, 5_000]) {
      const g = mh.bucketGrid(T0 - 13 * DAY - 7 * MINUTE, T0, maxPoints, mh.MIN_BUCKET_MS)
      expect(g.count).toBeLessThanOrEqual(Math.min(maxPoints, mh.MAX_POINTS))
      expect(g.start + g.count * g.bucketMs).toBeGreaterThanOrEqual(T0)
    }
  })
})

describe('runs per GPU', () => {
  it('Feature G: pinned runs count on their GPU, the rest as unpinned', () => {
    expect(mh.runsPerGpu(work(0, 0, 3, null), 4)).toEqual({ runs: [2, 0, 0, 1], unpinned: 1 })
    expect(mh.runsPerGpu([], 2)).toEqual({ runs: [0, 0], unpinned: 0 })
  })

  it('Feature G: on a one-GPU node, where nothing is pinned, its runs are on GPU 0', () => {
    const s = mh.record('n1', metrics(T0, [gpu(0, 3)]), mh.runsPerGpu(work(null), 1))
    expect(s.runs).toEqual([0])
    expect(s.unpinnedRuns).toBe(1)
    expect(mh.runsOn(s, 0)).toBe(1)
    expect(rows('SELECT gpu_index, runs FROM node_metrics')).toEqual([{ gpu_index: 0, runs: 1 }])
  })
})

describe('record, the ring and the table', () => {
  it('Feature G: one poll is one row per GPU, written together, and heard by listeners', () => {
    const heard: MetricsSample[] = []
    mh.onSample((s) => heard.push(s))
    mh.onSample(() => {
      throw new Error('a listener that throws is its own problem')
    })
    const s = mh.record(
      'n1',
      metrics(T0, [gpu(0, 95), gpu(1, 2, { powerW: 0 })]),
      mh.runsPerGpu(work(0, 1), 2),
      { numGpus: 2 }
    )
    expect(heard).toEqual([s])
    expect(s).toMatchObject({ nodeId: 'n1', ts: T0, runs: [1, 1], unpinnedRuns: 0, cpuUtil: 40 })
    expect(rows('SELECT * FROM node_metrics ORDER BY gpu_index')).toEqual([
      {
        ts: T0,
        node_id: 'n1',
        gpu_index: 0,
        util: 95,
        vram_used_gb: 12,
        vram_total_gb: 24,
        power_w: 300,
        runs: 1
      },
      // 0 W is a card that does not report power: no line, not a flat 0 W.
      {
        ts: T0,
        node_id: 'n1',
        gpu_index: 1,
        util: 2,
        vram_used_gb: 12,
        vram_total_gb: 24,
        power_w: null,
        runs: 1
      }
    ])
  })

  it('Feature G: a poll with no reading is a gap, as wide as the node, with its runs kept', () => {
    const s = mh.record('n1', null, mh.runsPerGpu(work(2), 4), { numGpus: 4, ts: T0 })
    expect(s).toMatchObject({ gpus: null, runs: [0, 0, 1, 0], cpuUtil: null, ramTotalGb: null })
    expect(rows('SELECT gpu_index, util, vram_used_gb, power_w, runs FROM node_metrics')).toEqual([
      { gpu_index: 0, util: null, vram_used_gb: null, power_w: null, runs: 0 },
      { gpu_index: 1, util: null, vram_used_gb: null, power_w: null, runs: 0 },
      { gpu_index: 2, util: null, vram_used_gb: null, power_w: null, runs: 1 },
      { gpu_index: 3, util: null, vram_used_gb: null, power_w: null, runs: 0 }
    ])
  })

  it('Feature G: a table write that fails costs the table its row, never the caller, and memory keeps it', () => {
    h.broken = true
    expect(() =>
      mh.record('n1', metrics(T0, [gpu(0, 50)]), mh.runsPerGpu([], 1), { numGpus: 1 })
    ).not.toThrow()
    expect(mh.tableWriteFailures().count).toBe(1)
    expect(mh.tableWriteFailures().last).toMatch(/SQLITE_FULL/)
    expect(mh.recent('n1')).toHaveLength(1)
    h.broken = false
  })

  it('Feature G: the ring keeps about six hours per node, oldest out first', () => {
    for (let t = T0; t <= T0 + 7 * HOUR; t += 15 * SECOND) {
      vi.setSystemTime(t)
      mh.record('n1', metrics(t, [gpu(0, 50)]), mh.runsPerGpu([], 1))
    }
    const kept = mh.recent('n1')
    expect(kept[0].ts).toBe(T0 + 7 * HOUR - mh.RING_MS)
    expect(kept[kept.length - 1].ts).toBe(T0 + 7 * HOUR)
    expect(kept).toHaveLength(mh.RING_MS / (15 * SECOND) + 1)
    // Every one of them is in the table all the same.
    expect(rows('SELECT COUNT(*) AS n FROM node_metrics')[0].n).toBe((7 * HOUR) / (15 * SECOND) + 1)
  })

  it('Feature G: the prune drops a gone node from memory once its ring ages out, and the table past 7 days', () => {
    mh.record('gone', metrics(T0, [gpu(0, 50)]), mh.runsPerGpu([], 1))
    // Older rows, as an earlier session left them.
    const insert = h.db.prepare(
      `INSERT INTO node_metrics (ts, node_id, gpu_index, util, runs) VALUES (?, 'old', 0, 50, 0)`
    )
    for (const age of [8 * DAY, 7 * DAY + MINUTE, 7 * DAY - MINUTE, DAY]) insert.run(T0 - age)

    mh.prune(T0 + HOUR)
    expect(mh.recent('gone')).toHaveLength(1)
    mh.prune(T0 + mh.RING_MS + MINUTE)
    expect(mh.recent('gone')).toEqual([])
    expect(
      rows(`SELECT ts FROM node_metrics WHERE node_id = 'old' ORDER BY ts`).map((r) => r.ts)
    ).toEqual([T0 - DAY])
    // The table kept the gone node's row: it is within the week.
    expect(rows(`SELECT COUNT(*) AS n FROM node_metrics WHERE node_id = 'gone'`)[0].n).toBe(1)
  })
})

describe('one node over time', () => {
  it('Feature G: per GPU utilisation, VRAM %, power and runs, and the node’s CPU and power', () => {
    const at = T0 - 10 * MINUTE
    vi.setSystemTime(at)
    for (let t = at; t < T0; t += 15 * SECOND) {
      vi.setSystemTime(t)
      // GPU 1 holds a run and does nothing: paid for and idle (81fe2875).
      mh.record(
        'n1',
        metrics(t, [gpu(0, 90), gpu(1, 0, { vramUsedGb: 6 })]),
        mh.runsPerGpu(work(0, 1), 2),
        {
          numGpus: 2
        }
      )
    }
    vi.setSystemTime(T0)
    const hist = mh.nodeHistory({ nodeId: 'n1', fromMs: T0 - 10 * MINUTE, toMs: T0, maxPoints: 11 })
    expect(hist.bucketMs).toBe(MINUTE)
    expect(hist.gpus.map((g) => g.index)).toEqual([0, 1])
    const [g0, g1] = hist.gpus
    expect(g0.util.every((p) => p.mean === 90)).toBe(true)
    expect(g1.util.every((p) => p.mean === 0)).toBe(true)
    expect(g1.runs.every((p) => p.mean === 1)).toBe(true)
    expect(g1.vramPct[0].mean).toBe(25)
    expect(hist.powerW[0]).toMatchObject({ mean: 600, min: 600, max: 600 })
    expect(hist.cpuUtil[0].mean).toBe(40)
    expect(hist.unpinnedRuns[0].mean).toBe(0)
  })

  it('Feature G: what the table holds from before this session joins what memory holds, with nothing counted twice', () => {
    // An earlier session: 3 polls at 20% a minute before this one started.
    const insert = h.db.prepare(
      `INSERT INTO node_metrics (ts, node_id, gpu_index, util, vram_used_gb, vram_total_gb, power_w, runs)
       VALUES (?, 'n1', 0, ?, 12, 24, 200, 0)`
    )
    for (const s of [50, 35, 20]) insert.run(T0 - 2 * MINUTE + s * SECOND, 20)
    // This session: every poll is in memory and in the table.
    for (const s of [5, 20, 35, 50]) {
      const t = T0 - MINUTE + s * SECOND
      vi.setSystemTime(t)
      mh.record('n1', metrics(t, [gpu(0, 80)]), mh.runsPerGpu([], 1))
    }
    vi.setSystemTime(T0)
    const hist = mh.nodeHistory({ nodeId: 'n1', fromMs: T0 - 2 * MINUTE, toMs: T0, maxPoints: 3 })
    expect(hist.gpus[0].util).toEqual([
      { ts: T0 - 2 * MINUTE, mean: 20, min: 20, max: 20 },
      { ts: T0 - MINUTE, mean: 80, min: 80, max: 80 }
    ])
    // CPU is kept in memory only.
    expect(hist.cpuUtil.map((p) => p.mean)).toEqual([null, 40])
    expect(hist.powerW.map((p) => p.mean)).toEqual([200, 300])
  })

  it('Feature G: an unreachable stretch is a gap in every series', () => {
    for (const [s, reading] of [
      [5, true],
      [35, false],
      [65, false],
      [95, true]
    ] as const) {
      const t = T0 - 2 * MINUTE + s * SECOND
      vi.setSystemTime(t)
      mh.record('n1', reading ? metrics(t, [gpu(0, 70)]) : null, mh.runsPerGpu([], 1))
    }
    vi.setSystemTime(T0)
    const hist = mh.nodeHistory({ nodeId: 'n1', fromMs: T0 - 2 * MINUTE, toMs: T0, maxPoints: 5 })
    expect(hist.bucketMs).toBe(30 * SECOND)
    expect(hist.gpus[0].util.map((p) => p.mean)).toEqual([70, null, null, 70])
    expect(hist.cpuUtil.map((p) => p.mean)).toEqual([40, null, null, 40])
    expect(hist.powerW.map((p) => p.mean)).toEqual([300, null, null, 300])
  })
})

describe('the fleet over time', () => {
  /**
   * Two nodes for ten minutes: A, 2 GPUs at $2/hr, one GPU busy rendering and
   * one idle with a run pinned to it; B, 4 GPUs at $4/hr, one busy, three
   * idle with nothing; then B unreachable for the last two minutes.
   */
  function fleet(): void {
    addNode('A', 2, 2)
    addNode('B', 4, 4)
    for (let t = T0 - 10 * MINUTE; t < T0; t += 15 * SECOND) {
      vi.setSystemTime(t)
      mh.record('A', metrics(t, [gpu(0, 95), gpu(1, 4)]), mh.runsPerGpu(work(0, 1), 2), {
        numGpus: 2
      })
      const bUp = t < T0 - 2 * MINUTE
      mh.record(
        'B',
        bUp ? metrics(t, [gpu(0, 90), gpu(1, 0), gpu(2, 5), gpu(3, 10)]) : null,
        mh.runsPerGpu(work(0), 4),
        { numGpus: 4 }
      )
    }
    vi.setSystemTime(T0)
  }

  const expected = [
    // B up: 6 rented; busy A0, A1 (a run), B0; util (95+4+90+0+5+10)/6.
    { gpusRented: 6, gpusBusy: 3, meanUtil: 204 / 6, idlePerHour: 0 * 2 + (3 / 4) * 4 },
    // B unreachable: still rented, busy only where a run is; no util to average for it.
    { gpusRented: 6, gpusBusy: 3, meanUtil: 99 / 2, idlePerHour: (3 / 4) * 4 }
  ]

  it('Feature G: GPUs rented and busy (above 10% or with a run), mean utilisation, and idle $/hr', () => {
    fleet()
    const hist = mh.fleetGpuHistory({ fromMs: T0 - 10 * MINUTE, toMs: T0, maxPoints: 6 })
    expect(hist.bucketMs).toBe(2 * MINUTE)
    expect(hist.points).toHaveLength(5)
    for (const p of hist.points.slice(0, 4)) {
      expect(p.gpusRented).toBe(expected[0].gpusRented)
      expect(p.gpusBusy).toBe(expected[0].gpusBusy)
      expect(p.meanUtil).toBeCloseTo(expected[0].meanUtil, 9)
      expect(p.idlePerHour).toBeCloseTo(expected[0].idlePerHour, 9)
    }
    expect(hist.points[4].gpusRented).toBe(expected[1].gpusRented)
    expect(hist.points[4].gpusBusy).toBe(expected[1].gpusBusy)
    expect(hist.points[4].meanUtil).toBeCloseTo(expected[1].meanUtil, 9)
    expect(hist.points[4].idlePerHour).toBeCloseTo(expected[1].idlePerHour, 9)
  })

  it('Feature G: read back from the table after a restart, the fleet graph is the same as from memory', () => {
    fleet()
    const q = { fromMs: T0 - 10 * MINUTE, toMs: T0, maxPoints: 6 }
    const fromMemory = mh.fleetGpuHistory(q)
    // A new process: empty rings, the same table.
    vi.resetModules()
    return import('./metricsHistory').then((fresh) => {
      const fromTable = fresh.fleetGpuHistory(q)
      expect(fromTable.bucketMs).toBe(fromMemory.bucketMs)
      expect(fromTable.points).toHaveLength(fromMemory.points.length)
      fromTable.points.forEach((p, i) => {
        const m = fromMemory.points[i]
        expect(p.ts).toBe(m.ts)
        expect(p.gpusRented).toBe(m.gpusRented)
        expect(p.gpusBusy).toBe(m.gpusBusy)
        expect(p.meanUtil).toBeCloseTo(m.meanUtil!, 9)
        expect(p.idlePerHour).toBeCloseTo(m.idlePerHour!, 9)
      })
      // And a node's own history from the table: the run on A's idle GPU is there.
      const a = fresh.nodeHistory({ nodeId: 'A', ...q })
      expect(a.gpus[1].runs.every((p) => p.mean === 1)).toBe(true)
      expect(a.gpus[1].util.every((p) => p.mean === 4)).toBe(true)
    })
  })

  it('Feature G: memory past its six hours hands over to the table, and a bucket where nobody was polled is empty', () => {
    addNode('A', 2, 1)
    for (let t = T0; t < T0 + 7 * HOUR; t += 15 * SECOND) {
      vi.setSystemTime(t)
      mh.record('A', metrics(t, [gpu(0, t < T0 + HOUR ? 50 : 0)]), mh.runsPerGpu([], 1))
    }
    const now = T0 + 7 * HOUR
    vi.setSystemTime(now)
    // The first hour is older than memory now: from the table.
    const hist = mh.fleetGpuHistory({ fromMs: T0 - HOUR, toMs: now, maxPoints: 9 })
    expect(hist.bucketMs).toBe(HOUR)
    expect(hist.points.map((p) => p.gpusRented)).toEqual([null, 1, 1, 1, 1, 1, 1, 1])
    expect(hist.points.map((p) => p.meanUtil)).toEqual([null, 50, 0, 0, 0, 0, 0, 0])
    expect(hist.points.map((p) => p.idlePerHour)).toEqual([null, 0, 2, 2, 2, 2, 2, 2])
  })

  it('Feature G: no node at all is an empty graph, not an error', () => {
    const hist = mh.fleetGpuHistory({ fromMs: T0 - HOUR, toMs: T0, maxPoints: 61 })
    expect(hist.points).toHaveLength(60)
    expect(hist.points.every((p) => p.gpusRented === null && p.idlePerHour === null)).toBe(true)
  })
})
