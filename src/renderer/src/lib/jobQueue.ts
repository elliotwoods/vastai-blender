/**
 * The render queue as the Jobs list cache holds it: each queued or running
 * job's `queuePos`, shared by the members of a group. Pure; queries.ts uses
 * these to show a drag's result before main has answered (useMoveJob,
 * useGroupJob, useUngroupJob) and to take main's answer in.
 *
 * Positions written here are 1-based and dense, as queue:list's are; a
 * finished job's position is left as it was (it is not in the queue).
 */

import { isLiveJob } from '../../../shared/jobTiming'
import type { JobSummary, QueueEntry } from '../../../shared/models'

/** A group id made up on the renderer side until main answers with the real one. */
export const PENDING_GROUP = 'pending:'

/** The live jobs in queue order as entries: a group is one, its members in list order. */
export function queueEntriesOf(jobs: readonly JobSummary[]): QueueEntry[] {
  const live = jobs
    .filter((j) => isLiveJob(j.state))
    .map((j, i) => ({ j, i }))
    // null positions (from before the queue) go last, in submit order
    .sort(
      (a, b) =>
        (a.j.queuePos ?? Number.POSITIVE_INFINITY) - (b.j.queuePos ?? Number.POSITIVE_INFINITY) ||
        a.j.submittedAt - b.j.submittedAt ||
        a.i - b.i
    )
  const out: QueueEntry[] = []
  const byGroup = new Map<string, QueueEntry>()
  for (const { j } of live) {
    const g = j.groupId ? byGroup.get(j.groupId) : undefined
    if (g) {
      g.jobIds.push(j.id)
      continue
    }
    const e: QueueEntry = { position: out.length + 1, groupId: j.groupId, jobIds: [j.id] }
    out.push(e)
    if (j.groupId) byGroup.set(j.groupId, e)
  }
  return out
}

/** Main's queue (queue:list, job:move's answer) written into the jobs' positions and groups. */
export function withQueue(jobs: readonly JobSummary[], queue: readonly QueueEntry[]): JobSummary[] {
  const at = new Map<string, { pos: number; groupId: string | null }>()
  for (const e of queue)
    for (const id of e.jobIds) at.set(id, { pos: e.position, groupId: e.groupId })
  let changed = false
  const out = jobs.map((j) => {
    const q = at.get(j.id)
    if (!q || (j.queuePos === q.pos && j.groupId === q.groupId)) return j
    changed = true
    return { ...j, queuePos: q.pos, groupId: q.groupId }
  })
  return changed ? out : (jobs as JobSummary[])
}

/**
 * `jobId`'s place (its whole group with it) moved to just before `before`'s,
 * or to the end when `before` is null, as job:move does. Unchanged when
 * either job is not in the queue, or a job is moved before itself or its
 * own group.
 */
export function moveInQueue(
  jobs: readonly JobSummary[],
  jobId: string,
  before: string | null
): JobSummary[] {
  const entries = queueEntriesOf(jobs)
  const from = entries.findIndex((e) => e.jobIds.includes(jobId))
  if (from < 0) return jobs as JobSummary[]
  const moving = entries[from]
  if (before != null) {
    const target = entries.find((e) => e.jobIds.includes(before))
    if (!target || target === moving) return jobs as JobSummary[]
  }
  const rest = entries.filter((e) => e !== moving)
  const to = before == null ? rest.length : rest.findIndex((e) => e.jobIds.includes(before))
  rest.splice(to, 0, moving)
  return withQueue(
    jobs,
    rest.map((e, i) => ({ ...e, position: i + 1 }))
  )
}

/**
 * `jobId` put into `withJobId`'s group, at that group's place, as job:group
 * does. A job with no group yet gets `groupId` (main's, or a PENDING_GROUP
 * one until main answers) and so does its partner. `jobId`'s old group is
 * left, dissolving if one member remains.
 */
export function groupInQueue(
  jobs: readonly JobSummary[],
  jobId: string,
  withJobId: string,
  groupId?: string
): JobSummary[] {
  const partner = jobs.find((j) => j.id === withJobId)
  const mover = jobs.find((j) => j.id === jobId)
  if (!partner || !mover || jobId === withJobId) return jobs as JobSummary[]
  const gid = groupId ?? partner.groupId ?? `${PENDING_GROUP}${withJobId}`
  const left = ungroupInQueue(jobs, jobId)
  const entries = queueEntriesOf(left)
  const target = entries.find((e) => e.jobIds.includes(withJobId))
  const moved = entries
    .map((e) => (e === target ? { ...e, groupId: gid, jobIds: [...e.jobIds, jobId] } : e))
    .map((e) => (e !== target && e.jobIds.includes(jobId) ? null : e))
    .filter((e): e is QueueEntry => e != null)
    .map((e, i) => ({ ...e, position: i + 1 }))
  // A job the queue does not hold (finished) still takes the group, for the list.
  const regrouped = left.map((j) =>
    j.id === jobId || j.id === withJobId || (partner.groupId && j.groupId === partner.groupId)
      ? { ...j, groupId: gid }
      : j
  )
  return withQueue(regrouped, moved)
}

/**
 * `jobId` out of its group, to the place just after it, as job:ungroup
 * does. A group left with one member dissolves.
 */
export function ungroupInQueue(jobs: readonly JobSummary[], jobId: string): JobSummary[] {
  const job = jobs.find((j) => j.id === jobId)
  if (!job?.groupId) return jobs as JobSummary[]
  const gid = job.groupId
  const entries = queueEntriesOf(jobs)
  const idx = entries.findIndex((e) => e.groupId === gid)
  const members = jobs.filter((j) => j.groupId === gid && j.id !== jobId)
  const dissolve = members.length <= 1
  let next: JobSummary[] = jobs.map((j) =>
    j.id === jobId || (dissolve && j.groupId === gid) ? { ...j, groupId: null } : j
  )
  if (idx >= 0 && isLiveJob(job.state)) {
    const group = entries[idx]
    const rest = group.jobIds.filter((id) => id !== jobId)
    const reordered: QueueEntry[] = [
      ...entries.slice(0, idx),
      ...(rest.length > 0 ? [{ ...group, groupId: dissolve ? null : gid, jobIds: rest }] : []),
      { position: 0, groupId: null, jobIds: [jobId] },
      ...entries.slice(idx + 1)
    ].map((e, i) => ({ ...e, position: i + 1 }))
    next = withQueue(next, reordered)
  }
  return next
}

/** A job:changed that says the job left the list (job:remove) drops it; others are upserted. */
export function upsertJob(jobs: readonly JobSummary[], job: JobSummary): JobSummary[] {
  const i = jobs.findIndex((j) => j.id === job.id)
  if (job.hiddenAt != null)
    return i < 0 ? (jobs as JobSummary[]) : jobs.filter((j) => j.id !== job.id)
  if (i < 0) return [job, ...jobs]
  const next = [...jobs]
  next[i] = job
  return next
}
