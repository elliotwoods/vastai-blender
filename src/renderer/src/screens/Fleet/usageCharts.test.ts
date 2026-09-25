import { describe, expect, it } from 'vitest'
import type { FleetGpuHistory } from '../../../../shared/models'
import type { GpuReading, MetricsReading } from '../../lib/metricsStore'
import { gpuColor } from '../../components/charts/palette'
import {
  GAP_MIN_MS,
  fleetStripSeries,
  gpuAxisMax,
  latestFleetPoint,
  liveWindow,
  maxGapMs,
  nodeUsageCharts,
  paidIdle,
  sparkPoints
} from './usageCharts'

// What the Fleet's GPU graphs draw (Feature G). The phantom runs of job
// 81fe2875 held 7 of 24 GPUs idle and nothing on screen said so; these pin
// the parts that would say it: a GPU idle with work assigned is shaded, a
// gap breaks the line instead of drawing an idle GPU, and the fleet strip's
// counts come straight from main's buckets.

const g = (
  index: number,
  util: number | null,
  runs = 0,
  vramPct: number | null = 50
): GpuReading => ({
  index,
  util,
  vramPct,
  runs
})

const r = (
  ts: number,
  gpus: GpuReading[] | null,
  powerW: number | null = null
): MetricsReading => ({
  ts,
  gpus,
  powerW
})

const S = 15_000

describe('paidIdle', () => {
  it('is a GPU at or under 10% with a run assigned', () => {
    expect(paidIdle({ util: 3, runs: 1 })).toBe(true)
    expect(paidIdle({ util: 10, runs: 1 })).toBe(true)
    expect(paidIdle({ util: 11, runs: 1 })).toBe(false)
    // Idle with nothing to do is not waste the lanes can fix.
    expect(paidIdle({ util: 0, runs: 0 })).toBe(false)
    // No reading is not idle.
    expect(paidIdle({ util: null, runs: 2 })).toBe(false)
  })
})

describe('sparkPoints', () => {
  it('draws the mean across GPUs over the spread from least to most busy', () => {
    const pts = sparkPoints([r(0, [g(0, 90), g(1, 10), g(2, 50)])], 0, 60_000)
    expect(pts).toEqual([{ x: 0, mean: 50, min: 10, max: 90 }])
  })

  it('breaks at a gap reading and at a hole no reading covers', () => {
    const pts = sparkPoints(
      [r(0, [g(0, 50)]), r(S, null), r(2 * S, [g(0, 60)]), r(2 * S + 5 * 60_000, [g(0, 70)])],
      0,
      60 * 60_000
    )
    expect(pts.map((p) => p.mean)).toEqual([50, null, 60, null, 70])
  })

  it('keeps to its window', () => {
    const pts = sparkPoints([r(0, [g(0, 1)]), r(100, [g(0, 2)])], 50, 200)
    expect(pts.map((p) => p.x)).toEqual([100])
  })
})

describe('nodeUsageCharts', () => {
  it('draws one line per GPU in its own index’s colour, broken at every gap', () => {
    const c = nodeUsageCharts(
      [r(0, [g(0, 90), g(1, 40)]), r(S, null), r(2 * S, [g(0, 95), g(1, 45)])],
      0,
      60_000
    )
    expect(c.gpus).toEqual([0, 1])
    expect(c.util.map((s) => [s.label, s.color])).toEqual([
      ['GPU 0', gpuColor(0)],
      ['GPU 1', gpuColor(1)]
    ])
    expect(c.util[0].points).toEqual([
      { x: 0, y: 90 },
      { x: S, y: null },
      { x: 2 * S, y: 95 }
    ])
    expect(c.vram[1].points.map((p) => p.y)).toEqual([50, null, 50])
  })

  it('shades a GPU idle with a run assigned, one band for a run of idle polls', () => {
    // GPU 1 holds a run and does nothing for three polls: the 81fe2875 shape.
    const c = nodeUsageCharts(
      [
        r(0, [g(0, 95, 1), g(1, 2, 1)]),
        r(S, [g(0, 96, 1), g(1, 1, 1)]),
        r(2 * S, [g(0, 97, 1), g(1, 3, 1)]),
        r(3 * S, [g(0, 98, 1), g(1, 80, 1)])
      ],
      0,
      60 * 60_000
    )
    expect(c.idle).toEqual([{ fromMs: 0, toMs: 3 * S, label: 'GPU 1 idle with work assigned' }])
  })

  it('does not shade a GPU idle with nothing assigned', () => {
    const c = nodeUsageCharts([r(0, [g(0, 0, 0)]), r(S, [g(0, 0, 0)])], 0, 60_000)
    expect(c.idle).toEqual([])
  })

  it('ends a lone idle poll’s band one poll on, and never past the window', () => {
    expect(nodeUsageCharts([r(0, [g(0, 1, 1)])], 0, 60_000).idle).toEqual([
      { fromMs: 0, toMs: S, label: 'GPU 0 idle with work assigned' }
    ])
    expect(nodeUsageCharts([r(50_000, [g(0, 1, 1)])], 0, 60_000).idle[0].toMs).toBe(60_000)
  })

  it('sums power only where it was reported, and draws no power chart without it', () => {
    expect(nodeUsageCharts([r(0, [g(0, 50)], 300)], 0, 60_000).power).toEqual([{ x: 0, y: 300 }])
    expect(nodeUsageCharts([r(0, [g(0, 50)], null)], 0, 60_000).power).toEqual([])
  })
})

describe('liveWindow', () => {
  it('ends at now, or at a reading stamped after the clock last ticked', () => {
    expect(liveWindow([], 1_000_000, 60_000)).toEqual({ fromMs: 940_000, toMs: 1_000_000 })
    expect(liveWindow([r(1_005_000, null)], 1_000_000, 60_000)).toEqual({
      fromMs: 945_000,
      toMs: 1_005_000
    })
  })

  it('bridges nothing wider than a few missed polls, or than its buckets', () => {
    expect(maxGapMs()).toBe(GAP_MIN_MS)
    expect(maxGapMs(10 * 60_000)).toBe(25 * 60_000)
  })
})

describe('the fleet strip', () => {
  const history: FleetGpuHistory = {
    fromMs: 0,
    toMs: 120_000,
    bucketMs: 60_000,
    points: [
      { ts: 0, gpusRented: 24, gpusBusy: 17, meanUtil: 60, idlePerHour: 2.5 },
      { ts: 60_000, gpusRented: null, gpusBusy: null, meanUtil: null, idlePerHour: null }
    ]
  }

  it('draws rented and busy per bucket, a bucket no node was polled in as a break', () => {
    const s = fleetStripSeries(history)
    expect(s.rented).toEqual([
      { x: 30_000, y: 24 },
      { x: 90_000, y: null }
    ])
    expect(s.busy.map((p) => p.y)).toEqual([17, null])
    expect(s.byX.get(30_000)?.idlePerHour).toBe(2.5)
    expect(s.peakRented).toBe(24)
  })

  it('reads its figures from the newest bucket that saw the fleet', () => {
    expect(latestFleetPoint(history)?.gpusBusy).toBe(17)
    expect(latestFleetPoint({ ...history, points: [] })).toBeNull()
  })

  it('tops its axis on whole GPUs', () => {
    expect(gpuAxisMax(24)).toBe(24)
    expect(gpuAxisMax(9)).toBe(12)
    expect(gpuAxisMax(0)).toBe(4)
  })
})
