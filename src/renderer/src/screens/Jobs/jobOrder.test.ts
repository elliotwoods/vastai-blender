import { describe, expect, it } from 'vitest'
import type { JobState, JobSummary } from '../../../../shared/models'
import { blockIntent, dropAction, dropIntent, groupRows, keyboardMove, orderJobs } from './jobOrder'

const job = (
  id: string,
  queuePos: number | null,
  groupId: string | null = null,
  state: JobState = 'queued',
  finishedAt: number | null = null
): JobSummary =>
  ({
    id,
    name: id,
    state,
    queuePos,
    groupId,
    submittedAt: 0,
    finishedAt,
    hiddenAt: null
  }) as JobSummary

const ids = (jobs: JobSummary[]): string => jobs.map((j) => j.id).join(' ')

// queue: a, b+c (group g), d; finished: x (older), y (newer)
const list = [
  job('x', 9, null, 'complete', 100),
  job('d', 3),
  job('c', 2, 'g', 'running'),
  job('a', 1),
  job('y', 7, null, 'cancelled', 200),
  job('b', 2, 'g')
]

describe('orderJobs', () => {
  it('puts live jobs in queue order with groups together, then finished newest first', () => {
    expect(ids(orderJobs(list))).toBe('a c b d y x')
  })

  it('sends jobs with no queue place after the rest of the queue', () => {
    expect(ids(orderJobs([job('n', null), job('a', 1)]))).toBe('a n')
  })
})

describe('groupRows', () => {
  it('makes one block of a group and plain rows of the rest', () => {
    const rows = groupRows(orderJobs(list))
    expect(rows.map((r) => (r.kind === 'group' ? `[${ids(r.jobs)}]` : r.job.id))).toEqual([
      'a',
      '[c b]',
      'd',
      'y',
      'x'
    ])
  })

  it('shows a group of one, or a finished member, as a plain row', () => {
    const rows = groupRows(orderJobs([job('a', 1, 'g'), job('z', 5, 'g', 'complete', 1)]))
    expect(rows.map((r) => r.kind)).toEqual(['single', 'single'])
  })
})

describe('dropIntent', () => {
  it('splits a row into before, group and after', () => {
    expect(dropIntent(0, 40)).toBe('before')
    expect(dropIntent(9, 40)).toBe('before')
    expect(dropIntent(10, 40)).toBe('group')
    expect(dropIntent(29, 40)).toBe('group')
    expect(dropIntent(30, 40)).toBe('after')
    expect(dropIntent(40, 40)).toBe('after')
    expect(dropIntent(5, 0)).toBe('group')
  })

  it('reads the edges inside a group block as grouping', () => {
    expect(blockIntent('before', 0, 3)).toBe('before')
    expect(blockIntent('before', 1, 3)).toBe('group')
    expect(blockIntent('after', 1, 3)).toBe('group')
    expect(blockIntent('after', 2, 3)).toBe('after')
    expect(blockIntent('group', 1, 3)).toBe('group')
  })
})

describe('dropAction', () => {
  it('moves before a job, or before a whole group', () => {
    expect(dropAction(list, 'd', 'a', 'before')).toEqual({ move: { jobId: 'd', before: 'a' } })
    expect(dropAction(list, 'd', 'b', 'before')).toEqual({ move: { jobId: 'd', before: 'c' } })
  })

  it('moves after a job: before the next place, or to the end', () => {
    expect(dropAction(list, 'a', 'b', 'after')).toEqual({ move: { jobId: 'a', before: 'd' } })
    expect(dropAction(list, 'a', 'd', 'after')).toEqual({ move: { jobId: 'a', before: null } })
  })

  it('does nothing for a move that leaves the queue as it is', () => {
    expect(dropAction(list, 'a', 'c', 'before')).toBeNull()
    expect(dropAction(list, 'd', 'b', 'after')).toBeNull()
    expect(dropAction(list, 'a', 'a', 'after')).toBeNull()
  })

  it('groups with another job, not with its own group', () => {
    expect(dropAction(list, 'a', 'd', 'group')).toEqual({ group: { jobId: 'a', withJobId: 'd' } })
    expect(dropAction(list, 'b', 'c', 'group')).toBeNull()
    expect(dropAction(list, 'b', 'c', 'before')).toBeNull()
  })

  it('refuses finished jobs on either end', () => {
    expect(dropAction(list, 'x', 'a', 'before')).toBeNull()
    expect(dropAction(list, 'a', 'x', 'group')).toBeNull()
    expect(dropAction(list, 'a', 'nope', 'group')).toBeNull()
  })
})

describe('keyboardMove', () => {
  it('moves up before the place above, down after the one below', () => {
    expect(keyboardMove(list, 'd', 'up')).toEqual({ move: { jobId: 'd', before: 'c' } })
    expect(keyboardMove(list, 'a', 'down')).toEqual({ move: { jobId: 'a', before: 'd' } })
    expect(keyboardMove(list, 'b', 'down')).toEqual({ move: { jobId: 'b', before: null } })
  })

  it('stops at the ends and ignores finished jobs', () => {
    expect(keyboardMove(list, 'a', 'up')).toBeNull()
    expect(keyboardMove(list, 'd', 'down')).toBeNull()
    expect(keyboardMove(list, 'x', 'up')).toBeNull()
  })
})
