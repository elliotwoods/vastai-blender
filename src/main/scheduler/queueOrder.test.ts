import { describe, expect, it } from 'vitest'
import { entryKey, orderQueue, type JobProgress, type QueuedChunk } from './queueOrder'

interface Row extends QueuedChunk {
  id: string
}

/** `n` chunks of `size` frames of `job`, in frame order. */
function chunks(job: string, n: number, size = 10, group: string | null = null): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${job}${i + 1}`,
    job_id: job,
    group_id: group,
    frames_left: size
  }))
}

const ids = (rows: Row[]): string[] => rows.map((r) => r.id)

describe('orderQueue', () => {
  it('keeps the queue order of jobs on their own', () => {
    const rows = [...chunks('A', 2), ...chunks('B', 2)]
    expect(ids(orderQueue(rows, new Map()))).toEqual(['A1', 'A2', 'B1', 'B2'])
  })

  it("interleaves a group's jobs of one size in turn", () => {
    const rows = [...chunks('A', 3, 10, 'g'), ...chunks('B', 3, 10, 'g'), ...chunks('C', 1)]
    const progress = new Map<string, JobProgress>([
      ['A', { committed: 0, total: 30 }],
      ['B', { committed: 0, total: 30 }]
    ])
    expect(ids(orderQueue(rows, progress))).toEqual(['A1', 'B1', 'A2', 'B2', 'A3', 'B3', 'C1'])
  })

  it('evens out progress, not chunk counts: the small job keeps pace with the big one', () => {
    // A is 100 frames in chunks of 10, B 20 frames in chunks of 10.
    const rows = [...chunks('A', 10, 10, 'g'), ...chunks('B', 2, 10, 'g')]
    const progress = new Map<string, JobProgress>([
      ['A', { committed: 0, total: 100 }],
      ['B', { committed: 0, total: 20 }]
    ])
    const order = ids(orderQueue(rows, progress))
    // B's second chunk goes once A is past half done, not after all of A
    // (a tie goes to the member first in the queue).
    expect(order.slice(0, 8)).toEqual(['A1', 'B1', 'A2', 'A3', 'A4', 'A5', 'A6', 'B2'])
    expect(order).toHaveLength(12)
  })

  it('catches up the member that is behind first', () => {
    const rows = [...chunks('A', 2, 10, 'g'), ...chunks('B', 2, 10, 'g')]
    const progress = new Map<string, JobProgress>([
      ['A', { committed: 20, total: 40 }],
      ['B', { committed: 0, total: 20 }]
    ])
    expect(ids(orderQueue(rows, progress))).toEqual(['B1', 'A1', 'B2', 'A2'])
  })

  it('names an entry by its group, else its job', () => {
    expect(entryKey({ job_id: 'A', group_id: 'g' })).toBe(entryKey({ job_id: 'B', group_id: 'g' }))
    expect(entryKey({ job_id: 'A', group_id: null })).not.toBe(
      entryKey({ job_id: 'B', group_id: null })
    )
  })
})
