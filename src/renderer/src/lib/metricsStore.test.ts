import { beforeEach, describe, expect, it } from 'vitest'
import type {
  GpuSample,
  MetricsPoint,
  MetricsSample,
  NodeMetricsHistory
} from '../../../shared/models'
import {
  NO_READINGS,
  RING_MAX_READINGS,
  RING_MS,
  mergeSeed,
  readingOf,
  readingsOfHistory,
  useMetricsStore,
  type MetricsReading
} from './metricsStore'

// Feature G's live store: the last hour of each node's GPU use, fed by the
// node:metricsSample push and seeded from node:metricsHistory. What it must
// get right is what the Fleet's graphs then draw: a gap stays a gap, runs on
// a one-GPU node are GPU 0's (or a paid-and-idle GPU never shades), the hour
// is an hour, and one node's sample leaves every other row alone.

const gpu = (index: number, util: number, patch: Partial<GpuSample> = {}): GpuSample => ({
  index,
  util,
  vramUsedGb: 12,
  vramTotalGb: 24,
  temp: 60,
  powerW: 300,
  ...patch
})

function sample(nodeId: string, ts: number, patch: Partial<MetricsSample> = {}): MetricsSample {
  return {
    nodeId,
    ts,
    gpus: [gpu(0, 90), gpu(1, 5)],
    runs: [1, 1],
    unpinnedRuns: 0,
    cpuUtil: 20,
    ramUsedGb: 10,
    ramTotalGb: 64,
    ...patch
  }
}

const point = (ts: number, mean: number | null): MetricsPoint => ({
  ts,
  mean,
  min: mean,
  max: mean
})

const store = (): ReturnType<typeof useMetricsStore.getState> => useMetricsStore.getState()

beforeEach(() => {
  useMetricsStore.setState({ byNode: {}, seeds: {} })
})

describe('readingOf', () => {
  it('keeps each GPU in index order, with VRAM as a share of its card', () => {
    const r = readingOf(sample('n', 1_000))
    expect(r.gpus).toEqual([
      { index: 0, util: 90, vramPct: 50, runs: 1 },
      { index: 1, util: 5, vramPct: 50, runs: 1 }
    ])
    expect(r.powerW).toBe(600)
  })

  it('counts a one-GPU node’s unpinned runs on GPU 0, as main’s history does', () => {
    // The scheduler pins nothing on a one-GPU node, yet the run is on GPU 0:
    // left unpinned here, a phantom run there would never shade as idle.
    const r = readingOf(sample('n', 1, { gpus: [gpu(0, 2)], runs: [0], unpinnedRuns: 1 }))
    expect(r.gpus?.[0].runs).toBe(1)
  })

  it('puts no unpinned run on any one GPU of a multi-GPU node', () => {
    const r = readingOf(sample('n', 1, { runs: [0, 0], unpinnedRuns: 2 }))
    expect(r.gpus?.map((g) => g.runs)).toEqual([0, 0])
  })

  it('reads a poll with no GPU reading as a gap, never as idle GPUs', () => {
    expect(readingOf(sample('n', 7, { gpus: null }))).toEqual({ ts: 7, gpus: null, powerW: null })
  })

  it('takes power 0 as not reported: no line, not a flat 0 W', () => {
    const r = readingOf(sample('n', 1, { gpus: [gpu(0, 50, { powerW: 0 })], runs: [0] }))
    expect(r.powerW).toBeNull()
  })
})

describe('readingsOfHistory', () => {
  const history = (patch: Partial<NodeMetricsHistory> = {}): NodeMetricsHistory => ({
    nodeId: 'n',
    fromMs: 0,
    toMs: 90_000,
    bucketMs: 30_000,
    gpus: [
      {
        index: 0,
        util: [point(0, 80), point(30_000, null), point(60_000, 4)],
        vramPct: [point(0, 40), point(30_000, null), point(60_000, 41)],
        powerW: [],
        runs: [point(0, 1), point(30_000, 1), point(60_000, 0.5)]
      }
    ],
    unpinnedRuns: [],
    cpuUtil: [],
    powerW: [point(0, 250), point(30_000, null), point(60_000, 90)],
    ...patch
  })

  it('stamps each bucket at its middle, so buckets and live polls share one axis', () => {
    expect(readingsOfHistory(history()).map((r) => r.ts)).toEqual([15_000, 45_000, 75_000])
  })

  it('reads a bucket nobody polled as a gap', () => {
    const [a, b, c] = readingsOfHistory(history())
    expect(a.gpus).toEqual([{ index: 0, util: 80, vramPct: 40, runs: 1 }])
    expect(b.gpus).toBeNull()
    expect(c).toEqual({
      ts: 75_000,
      gpus: [{ index: 0, util: 4, vramPct: 41, runs: 0.5 }],
      powerW: 90
    })
  })

  it('never stamps a bucket past the end of the read', () => {
    const r = readingsOfHistory(history({ toMs: 70_000 }))
    expect(r[r.length - 1].ts).toBe(70_000)
  })
})

describe('the store', () => {
  it('appends a node’s samples in time order, one reading per moment', () => {
    store().record(sample('a', 2_000))
    store().record(sample('a', 1_000))
    store().record(sample('a', 2_000, { gpus: [gpu(0, 33)], runs: [0] }))
    const ring = store().byNode.a
    expect(ring.map((r) => r.ts)).toEqual([1_000, 2_000])
    expect(ring[1].gpus?.[0].util).toBe(33)
  })

  it('keeps an hour: a reading older than RING_MS behind the newest goes', () => {
    store().record(sample('a', 0))
    store().record(sample('a', 1_000))
    store().record(sample('a', RING_MS + 500))
    expect(store().byNode.a.map((r) => r.ts)).toEqual([1_000, RING_MS + 500])
  })

  it('bounds a ring by count too, whatever its times say', () => {
    for (let i = 0; i < RING_MAX_READINGS + 5; i++) store().record(sample('a', i))
    const ring = store().byNode.a
    expect(ring.length).toBe(RING_MAX_READINGS)
    expect(ring[0].ts).toBe(5)
  })

  it('leaves every other node’s readings as they were: one sample re-renders one row', () => {
    store().record(sample('a', 1_000))
    store().record(sample('b', 1_000))
    const before = store().byNode.b
    store().record(sample('a', 16_000))
    expect(store().byNode.b).toBe(before)
    expect(store().byNode.a).toHaveLength(2)
  })

  it('seeds a node once: a second claim waits for the first', () => {
    expect(store().beginSeed('a')).toBe(true)
    expect(store().beginSeed('a')).toBe(false)
    store().seed('a', [], 30_000)
    expect(store().beginSeed('a')).toBe(false)
  })

  it('lays a seed under the samples heard meanwhile, never over them', () => {
    store().beginSeed('a')
    store().record(sample('a', 100_000))
    const seed: MetricsReading[] = [
      { ts: 45_000, gpus: [{ index: 0, util: 10, vramPct: 5, runs: 0 }], powerW: null },
      { ts: 75_000, gpus: [{ index: 0, util: 20, vramPct: 5, runs: 0 }], powerW: null },
      // Its bucket (75 000 – 105 000) holds the live sample at 100 000.
      { ts: 90_000, gpus: [{ index: 0, util: 30, vramPct: 5, runs: 0 }], powerW: null }
    ]
    store().seed('a', seed, 30_000)
    expect(store().byNode.a.map((r) => r.ts)).toEqual([45_000, 75_000, 100_000])
  })

  it('lets a failed seed be asked again', () => {
    store().beginSeed('a')
    store().seedFailed('a')
    expect(store().beginSeed('a')).toBe(true)
  })

  it('drops a node that is gone, and a seed that lands after it went', () => {
    store().beginSeed('a')
    store().record(sample('a', 1_000))
    store().forget('a')
    expect(store().byNode.a).toBeUndefined()
    store().seed('a', [{ ts: 500, gpus: null, powerW: null }], 30_000)
    expect(store().byNode.a).toBeUndefined()
  })
})

describe('mergeSeed', () => {
  it('takes the whole seed when nothing has been heard', () => {
    const seed: MetricsReading[] = [{ ts: 1, gpus: null, powerW: null }]
    expect(mergeSeed(NO_READINGS, seed, 30_000)).toEqual(seed)
  })
})
