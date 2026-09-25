import { describe, expect, it } from 'vitest'
import type { ChunkSnapshot, ChunkState } from '../../../shared/models'
import {
  barStateOf,
  mergeSegments,
  segmentTotals,
  segmentsFromChunks,
  tickPlan,
  type ProgressSegment
} from './progressSegments'

const chunk = (
  id: string,
  frameStart: number,
  frameEnd: number,
  state: ChunkState,
  framesDone = 0
): ChunkSnapshot => ({
  id,
  jobId: 'j',
  frameStart,
  frameEnd,
  state,
  nodeId: null,
  framesDone,
  retries: 0
})

describe('segmentsFromChunks', () => {
  it('weights chunks by frames, in frame order, whatever order they come in', () => {
    const segs = segmentsFromChunks(
      [chunk('b', 11, 40, 'rendering', 5), chunk('a', 1, 10, 'complete')],
      undefined,
      { frameStart: 1, frameEnd: 40, frameStep: 1 }
    )
    expect(segs).toEqual([
      { id: 'a', start: 0, frames: 10, done: 10, tone: 'done' },
      { id: 'b', start: 10, frames: 30, done: 5, tone: 'working' }
    ])
  })

  it('counts frames by the job’s step, not frame numbers', () => {
    const segs = segmentsFromChunks(
      [chunk('a', 1, 9, 'pending'), chunk('b', 11, 19, 'failed', 2)],
      undefined,
      {
        frameStart: 1,
        frameEnd: 19,
        frameStep: 2
      }
    )
    expect(segs.map((s) => [s.start, s.frames, s.done, s.tone])).toEqual([
      [0, 5, 0, 'queued'],
      [5, 5, 2, 'failed']
    ])
  })

  it('fills what no chunk covers as done (a requeue narrows a chunk to what is missing)', () => {
    const segs = segmentsFromChunks([chunk('a', 5, 6, 'pending')], undefined, {
      frameStart: 1,
      frameEnd: 10,
      frameStep: 1
    })
    expect(segs).toEqual([
      { id: null, start: 0, frames: 4, done: 4, tone: 'done' },
      { id: 'a', start: 4, frames: 2, done: 0, tone: 'queued' },
      { id: null, start: 6, frames: 4, done: 4, tone: 'done' }
    ])
  })

  it('takes the larger of the snapshot’s and the live done count, never past the chunk', () => {
    const chunks = [chunk('a', 1, 10, 'rendering', 3), chunk('b', 11, 20, 'rendering', 4)]
    const segs = segmentsFromChunks(chunks, { a: { framesDone: 7 }, b: { framesDone: 99 } })
    expect(segs.map((s) => s.done)).toEqual([7, 10])
  })

  it('without a job, spans the chunks themselves; with nothing, is empty', () => {
    expect(segmentsFromChunks([chunk('a', 3, 4, 'cancelled', 1)])).toEqual([
      { id: 'a', start: 0, frames: 2, done: 1, tone: 'cancelled' }
    ])
    expect(segmentsFromChunks([])).toEqual([])
    expect(segmentsFromChunks(undefined)).toEqual([])
  })

  it('drops chunks outside the job and clips overlaps', () => {
    const segs = segmentsFromChunks(
      [chunk('a', 1, 6, 'complete'), chunk('b', 5, 10, 'pending'), chunk('x', 50, 60, 'pending')],
      undefined,
      { frameStart: 1, frameEnd: 10, frameStep: 1 }
    )
    expect(segs.map((s) => [s.id, s.start, s.frames])).toEqual([
      ['a', 0, 6],
      ['b', 6, 4]
    ])
  })
})

describe('segmentTotals and mergeSegments', () => {
  const segs: ProgressSegment[] = [
    { id: 'a', start: 0, frames: 10, done: 10, tone: 'done' },
    { id: null, start: 10, frames: 5, done: 5, tone: 'done' },
    { id: 'b', start: 15, frames: 10, done: 4, tone: 'working' },
    { id: 'c', start: 25, frames: 10, done: 0, tone: 'queued' },
    { id: 'd', start: 35, frames: 10, done: 0, tone: 'queued' },
    { id: 'e', start: 45, frames: 10, done: 2, tone: 'failed' },
    { id: 'f', start: 55, frames: 5, done: 0, tone: 'cancelled' }
  ]

  it('adds up frames of each kind', () => {
    expect(segmentTotals(segs)).toEqual({
      total: 60,
      done: 21,
      failed: 8,
      cancelled: 5,
      working: 6
    })
  })

  it('merges neighbours that draw the same, and nothing else', () => {
    expect(mergeSegments(segs).map((s) => [s.id, s.start, s.frames, s.done, s.tone])).toEqual([
      [null, 0, 15, 15, 'done'],
      ['b', 15, 10, 4, 'working'],
      [null, 25, 20, 0, 'queued'],
      ['e', 45, 10, 2, 'failed'],
      ['f', 55, 5, 0, 'cancelled']
    ])
  })
})

describe('tickPlan', () => {
  const chunks = (n: number, size: number): ProgressSegment[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `c${i}`,
      start: i * size,
      frames: size,
      done: 0,
      tone: 'queued' as const
    }))

  it('marks every frame once each has 3 px', () => {
    expect(tickPlan(300, 100)).toEqual({ kind: 'frames', total: 100 })
    expect(tickPlan(299, 100)).toEqual({ kind: 'none' })
  })

  it('falls back to chunk boundaries when the chunks have room', () => {
    expect(tickPlan(300, 1000, chunks(4, 250))).toEqual({ kind: 'chunks', at: [0.25, 0.5, 0.75] })
    expect(tickPlan(300, 1000, chunks(200, 5))).toEqual({ kind: 'none' })
  })

  it('draws none unmeasured, or for a single unit', () => {
    expect(tickPlan(0, 10)).toEqual({ kind: 'none' })
    expect(tickPlan(300, 1)).toEqual({ kind: 'none' })
  })
})

describe('barStateOf', () => {
  it('reads a job’s state, held when it needs the user', () => {
    const attention = { kind: 'repeatedFailure' as const, message: 'x', since: 0 }
    expect(barStateOf({ state: 'queued' })).toBe('queued')
    expect(barStateOf({ state: 'running' })).toBe('active')
    expect(barStateOf({ state: 'running', attention })).toBe('held')
    expect(barStateOf({ state: 'complete' })).toBe('complete')
    expect(barStateOf({ state: 'partial' })).toBe('failed')
    expect(barStateOf({ state: 'failed' })).toBe('failed')
    expect(barStateOf({ state: 'cancelled' })).toBe('cancelled')
  })
})
