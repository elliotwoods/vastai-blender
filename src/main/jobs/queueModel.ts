/**
 * The render queue as a list, and the moves the user can make on it: pure,
 * so queue.ts (the database) and VR_MOCK (ipc.ts) share one set of rules,
 * and they are testable without SQLite.
 *
 * The queue is the queued and running jobs. A job on its own is one entry; a
 * group's members share one. Entries are in dispatch order, which queue.ts
 * writes back as jobs.queue_pos 1..n, every member of a group getting its
 * entry's.
 */

import type { JobState, QueueEntry } from '../../shared/models'

/** What the queue reads of a job. */
export interface QueueRow {
  id: string
  state: JobState
  queuePos: number | null
  groupId: string | null
  submittedAt: number
}

/** A move the queue refuses, with a code the caller maps to its error (command layer: `code: message`). */
export class QueueRefusal extends Error {
  override readonly name = 'QueueRefusal'
  constructor(
    readonly code: 'not_found' | 'conflict' | 'active' | 'bad_request',
    message: string
  ) {
    super(`${code}: ${message}`)
  }
}

export function inQueue(state: JobState): boolean {
  return state === 'queued' || state === 'running'
}

/**
 * The queue from job rows: the live ones, in order of queue_pos (a job never
 * placed goes last), then submission. A group's entry stands where its
 * first member does.
 */
export function queueOf(rows: readonly QueueRow[]): QueueEntry[] {
  const live = rows
    .filter((r) => inQueue(r.state))
    .sort(
      (a, b) =>
        (a.queuePos ?? Infinity) - (b.queuePos ?? Infinity) ||
        a.submittedAt - b.submittedAt ||
        a.id.localeCompare(b.id)
    )
  const entries: QueueEntry[] = []
  const byGroup = new Map<string, QueueEntry>()
  for (const r of live) {
    const group = r.groupId ? byGroup.get(r.groupId) : undefined
    if (group) {
      group.jobIds.push(r.id)
      continue
    }
    const entry: QueueEntry = { position: 0, groupId: r.groupId, jobIds: [r.id] }
    if (r.groupId) byGroup.set(r.groupId, entry)
    entries.push(entry)
  }
  // Members in the order they were submitted.
  const submitted = new Map(live.map((r) => [r.id, r.submittedAt]))
  for (const e of entries) {
    e.jobIds.sort((a, b) => submitted.get(a)! - submitted.get(b)! || a.localeCompare(b))
  }
  return renumber(entries)
}

/** Positions 1..n, and a group left with one member is a job on its own. */
function renumber(entries: QueueEntry[]): QueueEntry[] {
  return entries
    .filter((e) => e.jobIds.length > 0)
    .map((e, i) => ({
      position: i + 1,
      groupId: e.jobIds.length > 1 ? e.groupId : null,
      jobIds: [...e.jobIds]
    }))
}

function entryOf(entries: readonly QueueEntry[], jobId: string, what = 'job'): number {
  const i = entries.findIndex((e) => e.jobIds.includes(jobId))
  if (i < 0) {
    throw new QueueRefusal(
      'conflict',
      `${what} ${jobId} is not in the queue (only queued and running jobs are)`
    )
  }
  return i
}

/**
 * Move `jobId`'s entry (its whole group) to just before `before`'s, or to
 * the end when `before` is null. A job before its own entry stays where it is.
 */
export function moveInQueue(
  entries: readonly QueueEntry[],
  jobId: string,
  before: string | null
): QueueEntry[] {
  const from = entryOf(entries, jobId)
  const moving = entries[from]
  if (before != null && moving.jobIds.includes(before)) return renumber([...entries])
  const rest = entries.filter((_, i) => i !== from)
  const at = before == null ? rest.length : entryOf(rest, before, 'target job')
  rest.splice(at, 0, moving)
  return renumber(rest)
}

/**
 * Put `jobId` in `withJobId`'s group (one is made, `newGroupId`, when it has
 * none), at that group's place. `jobId` leaves any group it was in.
 */
export function groupInQueue(
  entries: readonly QueueEntry[],
  jobId: string,
  withJobId: string,
  newGroupId: string
): { entries: QueueEntry[]; groupId: string } {
  if (jobId === withJobId)
    throw new QueueRefusal('bad_request', 'a job cannot be grouped with itself')
  const from = entryOf(entries, jobId)
  const to = entryOf(entries, withJobId, 'target job')
  const target = entries[to]
  const groupId = target.groupId ?? newGroupId
  if (from === to) return { entries: renumber([...entries]), groupId }
  const next = entries.map((e, i) => {
    if (i === from) return { ...e, jobIds: e.jobIds.filter((id) => id !== jobId) }
    if (i === to) return { ...e, groupId, jobIds: [...e.jobIds, jobId] }
    return e
  })
  return { entries: renumber(next), groupId }
}

/** Take `jobId` out of its group, as an entry of its own just after it. */
export function ungroupInQueue(entries: readonly QueueEntry[], jobId: string): QueueEntry[] {
  const from = entryOf(entries, jobId)
  const group = entries[from]
  if (group.jobIds.length < 2) return renumber([...entries])
  const next = [...entries]
  next.splice(
    from,
    1,
    { ...group, jobIds: group.jobIds.filter((id) => id !== jobId) },
    { position: 0, groupId: null, jobIds: [jobId] }
  )
  return renumber(next)
}

/** What each job's queue_pos and group_id are in `entries`. */
export function placements(
  entries: readonly QueueEntry[]
): Map<string, { queuePos: number; groupId: string | null }> {
  const out = new Map<string, { queuePos: number; groupId: string | null }>()
  for (const e of entries) {
    for (const id of e.jobIds) out.set(id, { queuePos: e.position, groupId: e.groupId })
  }
  return out
}
