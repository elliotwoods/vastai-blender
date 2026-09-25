import { describe, expect, it } from 'vitest'
import { estimateJobTiming, projectTiming, type JobTimingInput } from './jobTiming'

const MIN = 60_000
const NOW = 1_800_000_000_000

function input(over: Partial<JobTimingInput> = {}): JobTimingInput {
  return {
    now: NOW,
    state: 'running',
    startedAt: NOW - 60 * MIN,
    finishedAt: null,
    framesDone: 100,
    framesTotal: 400,
    ...over
  }
}

/** `n` downloads `gap` ms apart, the newest `ago` ms before NOW. */
function downloads(n: number, gap: number, ago = 0): number[] {
  return Array.from({ length: n }, (_, i) => NOW - ago - (n - 1 - i) * gap)
}

describe('estimateJobTiming', () => {
  it('reads the rate from the frames landing, every node in parallel included', () => {
    // Four nodes, each landing a frame every 2 minutes: one every 30 s.
    const t = estimateJobTiming(input({ recentDownloads: downloads(30, 30_000) }))
    expect(t.basis).toBe('downloads')
    expect(t.framesPerHour).toBeCloseTo(120)
    // 300 frames at 2 a minute.
    expect(t.remainingMs).toBe(150 * MIN)
    expect(t.etaAt).toBe(NOW + 150 * MIN)
    expect(t.elapsedMs).toBe(60 * MIN)
  })

  it('reads only the last 30 downloads', () => {
    const slow = downloads(40, 10 * MIN, 30 * 30_000)
    const fast = downloads(30, 30_000)
    const t = estimateJobTiming(input({ recentDownloads: [...fast, ...slow] }))
    expect(t.framesPerHour).toBeCloseTo(120)
  })

  it('slows the estimate while frames stop arriving, then falls back', () => {
    const recent = downloads(30, 30_000)
    const fresh = estimateJobTiming(input({ recentDownloads: recent }))
    // Ten minutes with nothing landing.
    const stalled = estimateJobTiming(input({ now: NOW + 10 * MIN, recentDownloads: recent }))
    expect(stalled.basis).toBe('downloads')
    expect(stalled.framesPerHour!).toBeLessThan(fresh.framesPerHour! * 0.7)
    expect(stalled.remainingMs!).toBeGreaterThan(fresh.remainingMs!)
    // Past a quarter of an hour the window is not believed: the live rate is.
    const stale = estimateJobTiming(
      input({ now: NOW + 20 * MIN, recentDownloads: recent, liveFramesPerSec: 1 / 60 })
    )
    expect(stale.basis).toBe('live')
    expect(stale.framesPerHour).toBeCloseTo(60)
  })

  it('uses the runs’ measured rates before any frame has landed', () => {
    const t = estimateJobTiming(
      input({ framesDone: 0, recentDownloads: [NOW - MIN], liveFramesPerSec: 0.02 })
    )
    expect(t.basis).toBe('live')
    expect(t.remainingMs).toBe(Math.round(400 / 0.02) * 1000)
  })

  it('falls back to the scene’s measured seconds per frame times the renders running', () => {
    const t = estimateJobTiming(
      input({ framesDone: 0, liveFramesPerSec: null, secondsPerFrame: 90, liveLanes: 3 })
    )
    expect(t.basis).toBe('scenePerf')
    expect(t.framesPerHour).toBeCloseTo(120)
    expect(t.remainingMs).toBe(200 * MIN)
  })

  it('estimates nothing for a job no node is rendering yet', () => {
    const t = estimateJobTiming(
      input({ state: 'queued', startedAt: null, framesDone: 0, secondsPerFrame: 90, liveLanes: 0 })
    )
    expect(t).toEqual({
      elapsedMs: null,
      remainingMs: null,
      etaAt: null,
      framesPerHour: null,
      basis: 'none'
    })
  })

  it('leaves the frames a cancel stopped out of what is left', () => {
    const t = estimateJobTiming(
      input({ framesCancelled: 200, recentDownloads: downloads(30, 30_000) })
    )
    expect(t.remainingMs).toBe(50 * MIN)
  })

  it('a cancelled job has no estimate, and its clock stopped at the cancel', () => {
    const t = estimateJobTiming(
      input({
        state: 'cancelled',
        finishedAt: NOW - 30 * MIN,
        framesCancelled: 300,
        recentDownloads: downloads(30, 30_000, 30 * MIN)
      })
    )
    expect(t).toEqual({
      elapsedMs: 30 * MIN,
      remainingMs: null,
      etaAt: null,
      framesPerHour: 200,
      basis: 'none'
    })
  })

  it('a complete job has nothing left and was done when it finished', () => {
    const t = estimateJobTiming(
      input({ state: 'complete', framesDone: 400, finishedAt: NOW - 10 * MIN })
    )
    expect(t).toMatchObject({ elapsedMs: 50 * MIN, remainingMs: 0, etaAt: NOW - 10 * MIN })
  })

  it('a finished job with no recorded end has no elapsed time', () => {
    expect(estimateJobTiming(input({ state: 'partial' })).elapsedMs).toBeNull()
  })
})

describe('projectTiming', () => {
  it('runs a live job’s clock on and counts down to zero, never below', () => {
    const t = {
      state: 'running' as const,
      elapsedMs: MIN,
      remainingMs: 2 * MIN,
      etaAt: NOW + 2 * MIN,
      timingAt: NOW
    }
    expect(projectTiming(t, NOW + 30_000)).toEqual({
      elapsedMs: MIN + 30_000,
      remainingMs: 90_000,
      etaAt: NOW + 2 * MIN
    })
    expect(projectTiming(t, NOW + 5 * MIN).remainingMs).toBe(0)
  })

  it('leaves a finished job as it was', () => {
    const t = {
      state: 'complete' as const,
      elapsedMs: MIN,
      remainingMs: 0,
      etaAt: NOW,
      timingAt: NOW
    }
    expect(projectTiming(t, NOW + 5 * MIN)).toEqual({ elapsedMs: MIN, remainingMs: 0, etaAt: NOW })
  })
})
