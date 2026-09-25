import { describe, expect, it } from 'vitest'
import { concatList, nextVersionName, planSegments, type PlanClip } from './jobClipPlan'

const clip = (chunkId: string, frames: number, over: Partial<PlanClip> = {}): PlanClip => ({
  chunkId,
  absPath: `/r/previews/${chunkId}_sdr.mp4`,
  fps: 25,
  frames,
  width: 1920,
  height: 1080,
  codec: 'hevc',
  hdr: 0,
  ...over
})

describe('planSegments', () => {
  it('orders by frame and merges adjacent chunks into one segment', () => {
    const chunks = [
      { id: 'c', frameStart: 105, frameEnd: 106 },
      { id: 'a', frameStart: 101, frameEnd: 102 },
      { id: 'b', frameStart: 103, frameEnd: 104 }
    ]
    const plan = planSegments(chunks, [clip('a', 2), clip('b', 2), clip('c', 2)], 1)!
    expect(plan.files).toEqual([
      '/r/previews/a_sdr.mp4',
      '/r/previews/b_sdr.mp4',
      '/r/previews/c_sdr.mp4'
    ])
    expect(plan.segments).toEqual([{ start: 101, end: 106 }])
    expect(plan.frames).toBe(6)
  })

  it('leaves a gap where a chunk has no clip', () => {
    const chunks = [
      { id: 'a', frameStart: 1, frameEnd: 10 },
      { id: 'b', frameStart: 11, frameEnd: 20 },
      { id: 'c', frameStart: 21, frameEnd: 30 }
    ]
    const plan = planSegments(chunks, [clip('a', 10), clip('c', 10)], 1)!
    expect(plan.segments).toEqual([
      { start: 1, end: 10 },
      { start: 21, end: 30 }
    ])
  })

  it('honours frame step when merging and counting', () => {
    const chunks = [
      { id: 'a', frameStart: 1, frameEnd: 9 }, // 1,3,5,7,9
      { id: 'b', frameStart: 11, frameEnd: 15 } // 11,13,15
    ]
    const plan = planSegments(chunks, [clip('a', 5), clip('b', 3)], 2)!
    expect(plan.segments).toEqual([{ start: 1, end: 15 }])
    expect(plan.frames).toBe(8)
  })

  it('drops a clip whose frame count no longer matches its (narrowed) chunk', () => {
    const chunks = [
      { id: 'a', frameStart: 1, frameEnd: 4 },
      { id: 'b', frameStart: 5, frameEnd: 6 }
    ]
    const plan = planSegments(chunks, [clip('a', 4), clip('b', 10)], 1)!
    expect(plan.files).toEqual(['/r/previews/a_sdr.mp4'])
    expect(plan.segments).toEqual([{ start: 1, end: 4 }])
  })

  it('keeps the majority stream shape so -c copy stays valid', () => {
    const chunks = [
      { id: 'a', frameStart: 1, frameEnd: 2 },
      { id: 'b', frameStart: 3, frameEnd: 4 },
      { id: 'c', frameStart: 5, frameEnd: 6 }
    ]
    const plan = planSegments(
      chunks,
      [clip('a', 2), clip('b', 2, { width: 960 }), clip('c', 2)],
      1
    )!
    expect(plan.files).toHaveLength(2)
    expect(plan.segments).toEqual([
      { start: 1, end: 2 },
      { start: 5, end: 6 }
    ])
    expect(plan.width).toBe(1920)
  })

  it('returns null with nothing usable', () => {
    expect(planSegments([{ id: 'a', frameStart: 1, frameEnd: 2 }], [], 1)).toBeNull()
  })
})

describe('nextVersionName', () => {
  it('starts at v1 and increments', () => {
    expect(nextVersionName('previewSdr', null)).toBe('job_previewSdr.v1.mp4')
    expect(nextVersionName('previewSdr', '/x/job_previewSdr.v9.mp4')).toBe('job_previewSdr.v10.mp4')
  })
})

describe('concatList', () => {
  it('quotes paths and escapes single quotes', () => {
    expect(concatList(["/a/it's.mp4", '/b c/d.mp4'])).toBe(
      "file '/a/it'\\''s.mp4'\nfile '/b c/d.mp4'\n"
    )
  })

  it('refuses a path with a line break or other control character', () => {
    // A newline cannot be escaped in a concat list: it would end this `file`
    // directive and start one of the path's choosing, which `-safe 0` obeys.
    for (const bad of [
      "/r/a.mp4'\nfile '/etc/passwd",
      '/r/a.mp4\rfile http://x/',
      '/r/a\u0000.mp4',
      '/r/a\u001b.mp4'
    ]) {
      expect(() => concatList(['/r/ok.mp4', bad])).toThrow(/control character/)
    }
  })
})
