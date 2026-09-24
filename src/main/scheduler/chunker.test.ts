import { describe, expect, it } from 'vitest'
import { autoChunkSize, framesIn, missingRanges, splitFrames } from './chunker'

describe('autoChunkSize', () => {
  it('targets ~3 chunks in flight per node, clamped to [5, 50]', () => {
    expect(autoChunkSize(20, 2)).toBe(5) // ceil(20/6)=4 → clamp 5
    expect(autoChunkSize(300, 2)).toBe(50)
    expect(autoChunkSize(120, 2)).toBe(20)
    expect(autoChunkSize(10_000, 4)).toBe(50)
  })
})

describe('splitFrames', () => {
  it('covers the range exactly with no overlap (step 1)', () => {
    const ranges = splitFrames(1, 250, 1, 50)
    expect(ranges).toEqual([
      { start: 1, end: 50 },
      { start: 51, end: 100 },
      { start: 101, end: 150 },
      { start: 151, end: 200 },
      { start: 201, end: 250 }
    ])
  })

  it('honours step', () => {
    const ranges = splitFrames(1, 20, 2, 5)
    // frames 1,3,5,7,9 | 11,13,15,17,19
    expect(ranges).toEqual([
      { start: 1, end: 9 },
      { start: 11, end: 19 }
    ])
    const all = ranges.flatMap((r) => framesIn(r, 2))
    expect(all).toEqual([1, 3, 5, 7, 9, 11, 13, 15, 17, 19])
  })

  it('handles a final short chunk', () => {
    const ranges = splitFrames(1, 12, 1, 5)
    expect(ranges).toEqual([
      { start: 1, end: 5 },
      { start: 6, end: 10 },
      { start: 11, end: 12 }
    ])
  })
})

describe('missingRanges', () => {
  it('subtracts downloaded frames into minimal contiguous ranges', () => {
    const dl = new Set([1, 2, 3, 7, 8])
    expect(missingRanges({ start: 1, end: 10 }, 1, dl)).toEqual([
      { start: 4, end: 6 },
      { start: 9, end: 10 }
    ])
  })

  it('returns empty when everything is downloaded', () => {
    const dl = new Set([1, 2, 3, 4, 5])
    expect(missingRanges({ start: 1, end: 5 }, 1, dl)).toEqual([])
  })

  it('returns the whole range when nothing is downloaded', () => {
    expect(missingRanges({ start: 5, end: 9 }, 1, new Set())).toEqual([{ start: 5, end: 9 }])
  })

  it('respects step', () => {
    const dl = new Set([3])
    expect(missingRanges({ start: 1, end: 9 }, 2, dl)).toEqual([
      { start: 1, end: 1 },
      { start: 5, end: 9 }
    ])
  })
})

// A step or chunk size that never advances used to spin these loops until the
// heap ran out — the main process dead while the fleet kept billing. They now
// refuse up front. (Were a guard lost, 0 and -1 below would hang this file
// until the worker ran out of memory rather than fail neatly.)
describe('input guards', () => {
  it('splitFrames refuses a chunk size that is 0, negative or fractional', () => {
    expect(() => splitFrames(1, 10, 1, 0)).toThrow(
      /chunk size must be a whole number of at least 1/
    )
    expect(() => splitFrames(1, 10, 1, -1)).toThrow(/chunk size/)
    expect(() => splitFrames(1, 10, 1, 2.5)).toThrow(/chunk size/)
    expect(() => splitFrames(1, 10, 1, NaN)).toThrow(/chunk size/)
  })

  it('splitFrames refuses a step that is 0, negative or fractional', () => {
    expect(() => splitFrames(1, 10, 0, 5)).toThrow(
      /frame step must be a whole number of at least 1/
    )
    expect(() => splitFrames(1, 10, -1, 5)).toThrow(/frame step/)
    expect(() => splitFrames(1, 10, 2.5, 5)).toThrow(/frame step/)
  })

  it('splitFrames refuses an inverted or fractional range', () => {
    // Used to return [] — a job with no chunks, 'queued' forever.
    expect(() => splitFrames(10, 1, 1, 5)).toThrow(/ends before it starts/)
    expect(() => splitFrames(1.5, 10, 1, 5)).toThrow(/whole frame numbers/)
    expect(() => splitFrames(1, 10.5, 1, 5)).toThrow(/whole frame numbers/)
  })

  it('splitFrames still accepts a single frame and a chunk bigger than the range', () => {
    expect(splitFrames(7, 7, 1, 5)).toEqual([{ start: 7, end: 7 }])
    expect(splitFrames(0, 3, 1, 1000)).toEqual([{ start: 0, end: 3 }])
  })

  it('framesIn refuses a step that is 0, negative or fractional, and an inverted range', () => {
    expect(() => framesIn({ start: 1, end: 10 }, 0)).toThrow(/frame step/)
    expect(() => framesIn({ start: 1, end: 10 }, -1)).toThrow(/frame step/)
    expect(() => framesIn({ start: 1, end: 10 }, 2.5)).toThrow(/frame step/)
    expect(() => framesIn({ start: 10, end: 1 }, 1)).toThrow(/ends before it starts/)
  })

  it('missingRanges refuses a step that never advances, and an inverted range', () => {
    expect(() => missingRanges({ start: 1, end: 10 }, 0, new Set())).toThrow(/frame step/)
    expect(() => missingRanges({ start: 1, end: 10 }, -1, new Set())).toThrow(/frame step/)
    expect(() => missingRanges({ start: 1, end: 10 }, NaN, new Set())).toThrow(/frame step/)
    // An inverted range used to come back empty, which requeue reads as
    // "nothing missing" and marks the chunk complete.
    expect(() => missingRanges({ start: 10, end: 1 }, 1, new Set())).toThrow(
      /ends before it starts/
    )
  })

  it('missingRanges still requeues a legacy fractional-step chunk rather than throw', () => {
    // Jobs created before validation can carry frame_step 2.5. Requeue must
    // not throw on them: it runs mid-bookkeeping in the scheduler, and a throw
    // there strands the run and keeps its node billing. See missingRanges.
    expect(missingRanges({ start: 1, end: 11 }, 2.5, new Set([1]))).toEqual([
      { start: 3.5, end: 11 }
    ])
  })
})
