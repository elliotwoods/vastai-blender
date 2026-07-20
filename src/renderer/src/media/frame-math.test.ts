import { describe, expect, it } from 'vitest'
import {
  clampFrame,
  formatTimecode,
  frameToPhase,
  frameToTime,
  phaseToFrame,
  timeToFrame
} from './frame-math'

describe('frameToTime / timeToFrame', () => {
  it('round-trips every frame at common fps values', () => {
    for (const fps of [24, 25, 30, 23.976, 29.97, 60]) {
      for (let f = 0; f < 200; f++) {
        expect(timeToFrame(frameToTime(f, fps), fps, 200)).toBe(f)
      }
    }
  })

  it('seeks to frame centers (never lands on the previous frame)', () => {
    const fps = 25
    // A decoder snapping to the nearest frame boundary must still resolve
    // the intended frame from the center-of-interval time.
    for (let f = 0; f < 100; f++) {
      const t = frameToTime(f, fps)
      expect(t).toBeGreaterThan(f / fps)
      expect(t).toBeLessThan((f + 1) / fps)
    }
  })

  it('clamps out-of-range times', () => {
    expect(timeToFrame(-1, 25, 100)).toBe(0)
    expect(timeToFrame(999, 25, 100)).toBe(99)
  })
})

describe('formatTimecode', () => {
  it('formats MM:SS:FF', () => {
    expect(formatTimecode(0, 25)).toBe('00:00:00')
    expect(formatTimecode(24, 25)).toBe('00:00:24')
    expect(formatTimecode(25, 25)).toBe('00:01:00')
    expect(formatTimecode(25 * 60 + 3, 25)).toBe('01:00:03')
  })
})

describe('phase mapping', () => {
  it('round-trips frames through phase', () => {
    for (let f = 0; f < 100; f++) {
      expect(phaseToFrame(frameToPhase(f, 100), 100)).toBe(f)
    }
  })
})

describe('clampFrame', () => {
  it('clamps and rounds', () => {
    expect(clampFrame(-5, 100)).toBe(0)
    expect(clampFrame(150, 100)).toBe(99)
    expect(clampFrame(49.6, 100)).toBe(50)
  })
})
