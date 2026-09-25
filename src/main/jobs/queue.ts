/**
 * The render queue in the database: the order the scheduler takes queued and
 * running jobs in (jobs.queue_pos), groups of jobs that share one place and
 * render in step (jobs.group_id), and removing a finished job from the Jobs
 * list (jobs.hidden_at). The rules are queueModel.ts's; this reads the rows,
 * applies them, writes back and announces every job whose place changed.
 *
 * A job leaves its group as it ends (jobs.ts leaveGroup, from
 * refreshJobState), and a revived job goes to the end of the queue
 * (revive.ts). Specs already prefetched into a node's inbox are not
 * withdrawn by a move: at most PREFETCH per shared node, and exclusive
 * chunks are never prefetched, so a move takes effect within a couple of
 * chunks per node.
 */

import { randomUUID } from 'crypto'
import { getDb } from '../db/db'
import type { JobState, QueueEntry } from '../../shared/models'
import { emitJobChanged } from './jobs'
import {
  groupInQueue,
  inQueue,
  moveInQueue,
  placements,
  queueOf,
  QueueRefusal,
  ungroupInQueue,
  type QueueRow
} from './queueModel'

export { QueueRefusal } from './queueModel'

interface Row {
  id: string
  state: JobState
  queue_pos: number | null
  group_id: string | null
  submitted_at: number
}

function liveRows(): Row[] {
  return getDb()
    .prepare(
      `SELECT id, state, queue_pos, group_id, submitted_at FROM jobs
        WHERE state IN ('queued', 'running')`
    )
    .all() as Row[]
}

function toQueueRow(r: Row): QueueRow {
  return {
    id: r.id,
    state: r.state,
    queuePos: r.queue_pos,
    groupId: r.group_id,
    submittedAt: r.submitted_at
  }
}

/** The queue now (queue:list): queued and running jobs, in dispatch order. */
export function queueEntries(): QueueEntry[] {
  return queueOf(liveRows().map(toQueueRow))
}

/**
 * Write `entries` back as queue_pos and group_id, in one transaction, and
 * announce every job whose place changed. Returns the queue as written.
 */
function writeQueue(rows: readonly Row[], entries: QueueEntry[]): QueueEntry[] {
  const db = getDb()
  const place = placements(entries)
  const changed: string[] = []
  const update = db.prepare('UPDATE jobs SET queue_pos = ?, group_id = ? WHERE id = ?')
  db.transaction(() => {
    for (const r of rows) {
      const p = place.get(r.id)
      if (!p) continue
      if (p.queuePos === r.queue_pos && p.groupId === r.group_id) continue
      update.run(p.queuePos, p.groupId, r.id)
      changed.push(r.id)
    }
  })()
  for (const id of changed) emitJobChanged(id)
  return entries
}

function jobState(jobId: string): JobState {
  const row = getDb().prepare('SELECT state FROM jobs WHERE id = ?').get(jobId) as
    { state: JobState } | undefined
  if (!row) throw new QueueRefusal('not_found', `no job ${jobId}`)
  return row.state
}

/**
 * Move a job (with its whole group) to just before `before`'s place, or to
 * the end of the queue when `before` is null. Returns the queue as it now is.
 */
export function moveJob(jobId: string, before: string | null): QueueEntry[] {
  jobState(jobId)
  if (before != null) jobState(before)
  const rows = liveRows()
  return writeQueue(rows, moveInQueue(queueOf(rows.map(toQueueRow)), jobId, before))
}

/**
 * Put `jobId` in `withJobId`'s group, at that group's place: the two (or
 * more) share one priority, and the scheduler hands out their chunks in turn
 * towards equal progress. A group is made when `withJobId` has none.
 */
export function groupJobs(jobId: string, withJobId: string): { groupId: string } {
  jobState(jobId)
  jobState(withJobId)
  const rows = liveRows()
  const { entries, groupId } = groupInQueue(
    queueOf(rows.map(toQueueRow)),
    jobId,
    withJobId,
    randomUUID()
  )
  writeQueue(rows, entries)
  return { groupId }
}

/** Take a job out of its group, to the place just after it. */
export function ungroupJob(jobId: string): void {
  jobState(jobId)
  const rows = liveRows()
  writeQueue(rows, ungroupInQueue(queueOf(rows.map(toQueueRow)), jobId))
}

/**
 * Remove a finished job from the Jobs list (job:remove). Its files and rows
 * stay: restoreJob lists it again, and a campaign resubmitting its scene
 * still finds it rather than rendering it again. Refused with code `active`
 * while it is queued or running, or while `liveRuns` says its renders are
 * still being stopped: cancel it first.
 */
export function removeJob(jobId: string, opts: { liveRuns?: boolean } = {}): void {
  const state = jobState(jobId)
  if (inQueue(state) || opts.liveRuns) {
    throw new QueueRefusal(
      'active',
      inQueue(state)
        ? `job ${jobId} is ${state}; cancel it before removing it from the list`
        : `job ${jobId} is still stopping its renders; try again in a moment`
    )
  }
  getDb()
    .prepare('UPDATE jobs SET hidden_at = ? WHERE id = ? AND hidden_at IS NULL')
    .run(Date.now(), jobId)
  emitJobChanged(jobId)
}

/** List a removed job again (job:restore). */
export function restoreJob(jobId: string): void {
  jobState(jobId)
  getDb().prepare('UPDATE jobs SET hidden_at = NULL WHERE id = ?').run(jobId)
  emitJobChanged(jobId)
}
