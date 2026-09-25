/**
 * The Jobs list's order and what a drag onto it means. Pure, so the rules
 * are tested without a pointer:
 *
 *  - orderJobs: the live jobs in queue order (queuePos; a group's members
 *    together, at the group's place), then the finished ones, newest first.
 *  - groupRows: that order as rows, a group's members in one block.
 *  - dropIntent: where on a row the pointer is. The top quarter is "before",
 *    the bottom quarter "after", the middle "group with".
 *  - dropAction: the queue call a drop makes (job:move or job:group), or null
 *    when it would change nothing or isn't allowed (a finished job, itself).
 *
 * Main moves a group as one (jobs/queue.ts moveJob): moving any member moves
 * them all, and "before" a member of a group is before the whole group. So
 * the edges between two rows of one group mean nothing to a move; there the
 * drop reads as "group with" (a no-op for a member of that group). Leaving a
 * group is the member's unlink button, not a drag.
 */

import { isLiveJob } from '../../../../shared/jobTiming'
import type { JobSummary } from '../../../../shared/models'
import { queueEntriesOf } from '../../lib/jobQueue'

export type DropIntent = 'before' | 'after' | 'group'

export type JobListRow =
  { kind: 'single'; job: JobSummary } | { kind: 'group'; groupId: string; jobs: JobSummary[] }

export type DropAction =
  | { move: { jobId: string; before: string | null } }
  | { group: { jobId: string; withJobId: string } }

/** The live jobs in queue order, a group's members together; then the finished, newest first. */
export function orderJobs(jobs: readonly JobSummary[]): JobSummary[] {
  const byId = new Map(jobs.map((j) => [j.id, j]))
  const live = queueEntriesOf(jobs).flatMap((e) =>
    e.jobIds.map((id) => byId.get(id)).filter((j): j is JobSummary => j != null)
  )
  const finished = jobs
    .filter((j) => !isLiveJob(j.state))
    .map((j, i) => ({ j, i }))
    .sort(
      (a, b) =>
        (b.j.finishedAt ?? b.j.submittedAt) - (a.j.finishedAt ?? a.j.submittedAt) ||
        b.j.submittedAt - a.j.submittedAt ||
        a.i - b.i
    )
    .map(({ j }) => j)
  return [...live, ...finished]
}

/**
 * The ordered jobs as rows: consecutive live members of one group become a
 * block; a group of one (the rest finished or ungrouped) is a plain row.
 */
export function groupRows(ordered: readonly JobSummary[]): JobListRow[] {
  const rows: JobListRow[] = []
  for (const job of ordered) {
    const prev = rows[rows.length - 1]
    const gid = isLiveJob(job.state) ? job.groupId : null
    if (gid && prev) {
      if (prev.kind === 'group' && prev.groupId === gid) {
        prev.jobs.push(job)
        continue
      }
      if (prev.kind === 'single' && isLiveJob(prev.job.state) && prev.job.groupId === gid) {
        rows[rows.length - 1] = { kind: 'group', groupId: gid, jobs: [prev.job, job] }
        continue
      }
    }
    rows.push({ kind: 'single', job })
  }
  return rows
}

/** Where on a row of `height` px the pointer is, `offsetY` px from its top. */
export function dropIntent(offsetY: number, height: number): DropIntent {
  if (!(height > 0)) return 'group'
  const f = offsetY / height
  if (f < 0.25) return 'before'
  if (f >= 0.75) return 'after'
  return 'group'
}

/**
 * A row's intent in its group block: only the block's outer edges are a
 * place in the queue, so an edge between two members reads as "group with".
 */
export function blockIntent(intent: DropIntent, index: number, size: number): DropIntent {
  if (intent === 'before' && index > 0) return 'group'
  if (intent === 'after' && index < size - 1) return 'group'
  return intent
}

/** One place in the queue: a job, or a group's members. */
function liveEntries(jobs: readonly JobSummary[]): string[][] {
  return queueEntriesOf(jobs).map((e) => e.jobIds)
}

/**
 * The queue call dropping `sourceId` on `targetId` with `intent` makes, or
 * null: a job onto itself, a finished job on either end, a job grouped with
 * its own group, or a move that leaves the queue as it is.
 */
export function dropAction(
  jobs: readonly JobSummary[],
  sourceId: string,
  targetId: string,
  intent: DropIntent
): DropAction | null {
  if (sourceId === targetId) return null
  const source = jobs.find((j) => j.id === sourceId)
  const target = jobs.find((j) => j.id === targetId)
  if (!source || !target || !isLiveJob(source.state) || !isLiveJob(target.state)) return null
  const sameGroup = source.groupId != null && source.groupId === target.groupId

  if (intent === 'group') {
    return sameGroup ? null : { group: { jobId: sourceId, withJobId: targetId } }
  }
  if (sameGroup) return null

  const entries = liveEntries(jobs)
  const from = entries.findIndex((e) => e.includes(sourceId))
  const at = entries.findIndex((e) => e.includes(targetId))
  if (from < 0 || at < 0) return null
  if (intent === 'before') {
    // already just before it
    if (from === at - 1) return null
    return { move: { jobId: sourceId, before: entries[at][0] } }
  }
  // after: before whatever follows the target, or to the end
  if (from === at + 1) return null
  const next = entries[at + 1]
  return { move: { jobId: sourceId, before: next ? next[0] : null } }
}

/** Alt+↑ / Alt+↓ on a live row: before the place above it, or after the one below. */
export function keyboardMove(
  jobs: readonly JobSummary[],
  jobId: string,
  dir: 'up' | 'down'
): DropAction | null {
  const entries = liveEntries(jobs)
  const from = entries.findIndex((e) => e.includes(jobId))
  if (from < 0) return null
  if (dir === 'up') {
    if (from === 0) return null
    return { move: { jobId, before: entries[from - 1][0] } }
  }
  if (from === entries.length - 1) return null
  const after = entries[from + 2]
  return { move: { jobId, before: after ? after[0] : null } }
}
