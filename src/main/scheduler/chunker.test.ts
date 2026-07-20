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
