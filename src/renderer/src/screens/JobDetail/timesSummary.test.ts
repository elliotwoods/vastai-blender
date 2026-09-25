import { describe, expect, it } from 'vitest'
import { fmtSeconds, summariseTimes } from './timesSummary'
import type { SceneRenderTimes } from '../../../../shared/models'

const times = (over: Partial<SceneRenderTimes> = {}): SceneRenderTimes => ({
  gpuName: 'RTX 4090',
  loadS: 40,
  loads: 2,
  frames: 20,
  evalS: 1,
  syncS: 3,
  sampleS: 10,
  saveS: 2,
  peakVramMb: 7000,
  updatedAt: 0,
  ...over
})

describe('summariseTimes', () => {
  it('spreads each chunk load over the frames it rendered', () => {
    const s = summariseTimes(times())!
    // 40 s a load, 10 frames a load: 4 s a frame.
    expect(s.segments.map((x) => [x.key, x.seconds])).toEqual([
      ['load', 4],
      ['eval', 1],
      ['sync', 3],
      ['sample', 10],
      ['save', 2]
    ])
    expect(s.perFrameS).toBe(20)
    expect(s.gpuBusy).toBe(0.5)
  })

  it('has nothing to say before a frame is timed', () => {
    expect(summariseTimes(times({ frames: 0 }))).toBeNull()
  })

  it('leaves out a load it never timed, and a busy share with no sampling timed', () => {
    const s = summariseTimes(times({ loadS: null, loads: 0, sampleS: null }))!
    expect(s.segments[0].seconds).toBe(0)
    expect(s.gpuBusy).toBeNull()
  })
})

describe('fmtSeconds', () => {
  it('reads at every scale', () => {
    expect(fmtSeconds(0.42)).toBe('0.4 s')
    expect(fmtSeconds(62.4)).toBe('62 s')
    expect(fmtSeconds(200)).toBe('3 min 20 s')
  })
})
