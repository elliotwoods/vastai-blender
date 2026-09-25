import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClipSyncController } from './ClipSyncController'
import { SPEED_PRESETS, stepSpeed } from './speed'

/** Just the parts of <video> the controller touches. */
class FakeVideo {
  currentTime = 0
  duration = 4
  playbackRate = 1
  defaultPlaybackRate = 1
  paused = true
  play(): Promise<void> {
    this.paused = false
    return Promise.resolve()
  }
  pause(): void {
    this.paused = true
  }
  addEventListener = vi.fn()
  removeEventListener = vi.fn()
}

let rafQueue: Array<() => void> = []
/** Run one animation frame's worth of queued callbacks. */
function frame(): void {
  const q = rafQueue
  rafQueue = []
  for (const fn of q) fn()
}

beforeEach(() => {
  rafQueue = []
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => rafQueue.push(fn))
  vi.stubGlobal('cancelAnimationFrame', () => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
})

function setup(n = 3): { c: ClipSyncController; videos: FakeVideo[] } {
  const c = new ClipSyncController({ fps: 25, totalFrames: 100 })
  const videos = Array.from({ length: n }, () => new FakeVideo())
  for (const v of videos) c.register(v as unknown as HTMLVideoElement)
  return { c, videos }
}

describe('base playback rate', () => {
  it('applies setRate to every clip and notifies subscribers', () => {
    const { c, videos } = setup()
    const seen = vi.fn()
    c.subscribe(seen)
    c.setRate(2)
    expect(c.rate).toBe(2)
    for (const v of videos) {
      expect(v.playbackRate).toBe(2)
      expect(v.defaultPlaybackRate).toBe(2)
    }
    expect(seen).toHaveBeenCalled()
  })

  it('clamps to 0.1–8 and ignores non-finite rates', () => {
    const { c } = setup(1)
    c.setRate(100)
    expect(c.rate).toBe(8)
    c.setRate(0)
    expect(c.rate).toBe(0.1)
    c.setRate(Number.NaN)
    expect(c.rate).toBe(0.1)
  })

  it('gives a clip registered later the current rate', () => {
    const { c } = setup(1)
    c.setRate(0.5)
    const late = new FakeVideo()
    c.register(late as unknown as HTMLVideoElement)
    expect(late.playbackRate).toBe(0.5)
  })

  it('restores the base rate, not 1×, on pause', () => {
    const { c, videos } = setup()
    c.setRate(4)
    c.play()
    // Knock a follower off so the loop nudges it.
    videos[1].currentTime = 0.01
    frame()
    expect(videos[1].playbackRate).not.toBe(4)
    c.pause()
    for (const v of videos) expect(v.playbackRate).toBe(4)
  })

  it('keeps follower nudges within ±2% of the base rate', () => {
    const { c, videos } = setup()
    c.setRate(2)
    c.play()
    const frameDur = 1 / 25
    // Drifts inside one frame, both directions, including the extremes.
    for (const drift of [-frameDur, -frameDur / 3, -0.001, 0, 0.001, frameDur / 2, frameDur]) {
      videos[0].currentTime = 1
      videos[1].currentTime = 1 + drift
      videos[2].currentTime = 1 - drift
      frame()
      for (const v of videos.slice(1)) {
        expect(v.playbackRate).toBeGreaterThanOrEqual(2 * 0.98 - 1e-9)
        expect(v.playbackRate).toBeLessThanOrEqual(2 * 1.02 + 1e-9)
      }
    }
    // Behind speeds up, ahead slows down.
    videos[1].currentTime = 1 - frameDur / 2
    videos[2].currentTime = 1 + frameDur / 2
    frame()
    expect(videos[1].playbackRate).toBeGreaterThan(2)
    expect(videos[2].playbackRate).toBeLessThan(2)
  })

  it('hard-corrects beyond a frame back to the base rate', () => {
    const { c, videos } = setup(2)
    c.setRate(0.5)
    c.play()
    videos[0].currentTime = 1
    videos[1].currentTime = 1.5
    frame()
    expect(videos[1].currentTime).toBe(1)
    expect(videos[1].playbackRate).toBe(0.5)
  })
})

describe('stepSpeed', () => {
  it('walks the presets and holds at the ends', () => {
    expect(stepSpeed(1, 1)).toBe(2)
    expect(stepSpeed(2, 1)).toBe(4)
    expect(stepSpeed(4, 1)).toBe(4)
    expect(stepSpeed(1, -1)).toBe(0.5)
    expect(stepSpeed(0.5, -1)).toBe(0.25)
    expect(stepSpeed(0.25, -1)).toBe(0.25)
  })

  it('steps an off-preset rate to the neighbouring preset', () => {
    expect(stepSpeed(1.5, 1)).toBe(2)
    expect(stepSpeed(1.5, -1)).toBe(1)
    expect(stepSpeed(8, -1)).toBe(4)
    expect(stepSpeed(0.1, 1)).toBe(0.25)
  })

  it('offers 0.25× to 4×', () => {
    expect(SPEED_PRESETS).toEqual([0.25, 0.5, 1, 2, 4])
  })
})
