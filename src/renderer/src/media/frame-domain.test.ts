import { describe, expect, it } from 'vitest'
import { chunkRange, containsFrame, domainOf, frameAt, indexOf } from './frame-domain'

describe('domainOf', () => {
  it('counts inclusive ranges', () => {
    expect(domainOf(1, 100, 1).count).toBe(100)
    expect(domainOf(1, 1, 1).count).toBe(1)
    expect(domainOf(0, 0, 1).count).toBe(1)
  })

  it('counts stepped ranges', () => {
    // 1,3,5,7,9 — the end lands on a step
    expect(domainOf(1, 9, 2).count).toBe(5)
    // 1,3,5,7,9 — the end does NOT land on a step, and must not invent a 10th
    expect(domainOf(1, 10, 2).count).toBe(5)
  })

  it('treats an empty or malformed range as zero frames', () => {
    expect(domainOf(10, 1, 1).count).toBe(0)
    expect(domainOf(1, 10, 0).step).toBe(1)
  })
})

describe('frameAt / indexOf', () => {
  it('round-trips every index', () => {
    for (const step of [1, 2, 5]) {
      const d = domainOf(7, 7 + step * 40, step)
      for (let i = 0; i < d.count; i++) {
        expect(indexOf(d, frameAt(d, i))).toBe(i)
      }
    }
  })

  it('snaps a between-steps frame down to the preceding rendered one', () => {
    // A scrub landing mid-step should select the frame you can actually see.
    const d = domainOf(1, 21, 5) // 1, 6, 11, 16, 21
    expect(frameAt(d, indexOf(d, 8))).toBe(6)
    expect(frameAt(d, indexOf(d, 10))).toBe(6)
    expect(frameAt(d, indexOf(d, 11))).toBe(11)
  })

  it('clamps out-of-range on both sides', () => {
    const d = domainOf(10, 20, 1)
    expect(indexOf(d, -100)).toBe(0)
    expect(indexOf(d, 9)).toBe(0)
    expect(indexOf(d, 9999)).toBe(d.count - 1)
    expect(frameAt(d, -5)).toBe(10)
    expect(frameAt(d, 9999)).toBe(20)
  })
})

describe('containsFrame', () => {
  it('accepts only frames on a step', () => {
    const d = domainOf(1, 9, 2)
    expect(containsFrame(d, 1)).toBe(true)
    expect(containsFrame(d, 2)).toBe(false)
    expect(containsFrame(d, 9)).toBe(true)
    expect(containsFrame(d, 11)).toBe(false)
    expect(containsFrame(d, 0)).toBe(false)
  })
})

describe('chunkRange', () => {
  it('maps a chunk onto strip indices', () => {
    const d = domainOf(1, 100, 1)
    expect(chunkRange(d, 26, 50)).toEqual({ from: 25, to: 49 })
  })

  it('clips a chunk that overhangs the domain', () => {
    const d = domainOf(10, 20, 1)
    expect(chunkRange(d, 1, 12)).toEqual({ from: 0, to: 2 })
    expect(chunkRange(d, 18, 99)).toEqual({ from: 8, to: 10 })
  })

  it('returns null for a chunk outside the domain', () => {
    // Requeue narrows chunks, so a stale chunk row can name frames this job
    // no longer covers — that must not paint a band at index 0.
    const d = domainOf(10, 20, 1)
    expect(chunkRange(d, 1, 9)).toBeNull()
    expect(chunkRange(d, 21, 30)).toBeNull()
  })
})
