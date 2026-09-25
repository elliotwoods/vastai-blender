import { describe, expect, it } from 'vitest'
import type { JobState, JobSummary } from '../../../shared/models'
import {
  PENDING_GROUP,
  groupInQueue,
  moveInQueue,
  queueEntriesOf,
  ungroupInQueue,
  upsertJob,
  withQueue
} from './jobQueue'

const job = (
  id: string,
  queuePos: number | null,
  groupId: string | null = null,
  state: JobState = 'queued'
): JobSummary =>
  ({
    id,
    name: id,
    state,
    queuePos,
    groupId,
    submittedAt: 0,
    hiddenAt: null
  }) as JobSummary

/** The queue as "a b+c d": entries in order, a group's members joined by +. */
const order = (jobs: JobSummary[]): string =>
  queueEntriesOf(jobs)
    .map((e) => e.jobIds.join('+'))
    .join(' ')

describe('queueEntriesOf', () => {
  it('orders live jobs by position, a group as one entry, finished jobs out', () => {
    const jobs = [
      job('d', 4),
      job('b', 2, 'g'),
      job('a', 1),
      job('c', 2, 'g'),
      job('x', 3, null, 'complete'),
      job('e', null)
    ]
    expect(queueEntriesOf(jobs)).toEqual([
      { position: 1, groupId: null, jobIds: ['a'] },
      { position: 2, groupId: 'g', jobIds: ['b', 'c'] },
      { position: 3, groupId: null, jobIds: ['d'] },
      { position: 4, groupId: null, jobIds: ['e'] }
    ])
  })
})

describe('moveInQueue', () => {
  const jobs = [
    job('a', 1),
    job('b', 2, 'g'),
    job('c', 2, 'g'),
    job('d', 3),
    job('x', 9, null, 'complete')
  ]

  it('moves a job to just before another', () => {
    expect(order(moveInQueue(jobs, 'd', 'a'))).toBe('d a b+c')
    expect(moveInQueue(jobs, 'd', 'a').find((j) => j.id === 'd')?.queuePos).toBe(1)
  })

  it('moves a whole group, and to the end with null', () => {
    expect(order(moveInQueue(jobs, 'c', null))).toBe('a d b+c')
    expect(order(moveInQueue(jobs, 'a', 'd'))).toBe('b+c a d')
  })

  it('leaves the list alone for a move onto itself or a job not queued', () => {
    expect(moveInQueue(jobs, 'b', 'c')).toBe(jobs)
    expect(moveInQueue(jobs, 'x', 'a')).toBe(jobs)
    expect(moveInQueue(jobs, 'a', 'x')).toBe(jobs)
  })

  it('does not touch a finished job’s position', () => {
    expect(moveInQueue(jobs, 'd', 'a').find((j) => j.id === 'x')?.queuePos).toBe(9)
  })
})

describe('groupInQueue', () => {
  it('makes a group at the partner’s place, with a stand-in id until main answers', () => {
    const jobs = [job('a', 1), job('b', 2), job('c', 3)]
    const next = groupInQueue(jobs, 'c', 'a')
    expect(order(next)).toBe('a+c b')
    expect(next.find((j) => j.id === 'a')?.groupId).toBe(`${PENDING_GROUP}a`)
    expect(next.find((j) => j.id === 'c')?.groupId).toBe(`${PENDING_GROUP}a`)
    expect(groupInQueue(jobs, 'c', 'a', 'g1').find((j) => j.id === 'c')?.groupId).toBe('g1')
  })

  it('joins an existing group, leaving the old one (which dissolves at one member)', () => {
    const jobs = [job('a', 1, 'g'), job('b', 1, 'g'), job('c', 2, 'h'), job('d', 2, 'h')]
    const next = groupInQueue(jobs, 'd', 'a')
    expect(order(next)).toBe('a+b+d c')
    expect(next.find((j) => j.id === 'd')?.groupId).toBe('g')
    expect(next.find((j) => j.id === 'c')?.groupId).toBeNull()
  })
})

describe('ungroupInQueue', () => {
  it('takes a job out to just after its group', () => {
    const jobs = [job('a', 1, 'g'), job('b', 1, 'g'), job('c', 1, 'g'), job('d', 2)]
    const next = ungroupInQueue(jobs, 'a')
    expect(order(next)).toBe('b+c a d')
    expect(next.find((j) => j.id === 'a')?.groupId).toBeNull()
    expect(next.find((j) => j.id === 'b')?.groupId).toBe('g')
  })

  it('dissolves a group of two', () => {
    const next = ungroupInQueue([job('a', 1, 'g'), job('b', 1, 'g')], 'b')
    expect(next.map((j) => j.groupId)).toEqual([null, null])
    expect(order(next)).toBe('a b')
  })

  it('leaves a job with no group alone', () => {
    const jobs = [job('a', 1)]
    expect(ungroupInQueue(jobs, 'a')).toBe(jobs)
  })
})

describe('withQueue', () => {
  it('writes main’s positions and groups in, keeping untouched jobs by reference', () => {
    const jobs = [job('a', 1), job('b', 2)]
    const next = withQueue(jobs, [
      { position: 1, groupId: null, jobIds: ['b'] },
      { position: 2, groupId: null, jobIds: ['a'] }
    ])
    expect(order(next)).toBe('b a')
    expect(withQueue(jobs, [{ position: 1, groupId: null, jobIds: ['a'] }])).toBe(jobs)
  })
})

describe('upsertJob', () => {
  it('replaces or prepends a listed job, and drops one removed from the list', () => {
    const jobs = [job('a', 1), job('b', 2)]
    expect(upsertJob(jobs, { ...job('b', 5) }).map((j) => j.queuePos)).toEqual([1, 5])
    expect(upsertJob(jobs, job('c', 3)).map((j) => j.id)).toEqual(['c', 'a', 'b'])
    expect(upsertJob(jobs, { ...job('a', 1), hiddenAt: 123 }).map((j) => j.id)).toEqual(['b'])
    expect(upsertJob(jobs, { ...job('z', 1), hiddenAt: 123 })).toBe(jobs)
  })
})
