/**
 * Give a job's failed chunks another go.
 *
 * Moved out of index.ts's VR_JOB_SPEC driver, which revives a half-done job
 * when a campaign is resubmitted rather than creating a duplicate, so that
 * plan 1.15's job:retryMissing can share it instead of a second copy of the
 * SQL. A chunk fails for good once its retries are spent, perhaps by a
 * dispatch bug fixed since; reviving it puts it back to pending with a
 * fresh budget, and the scheduler renders only what is still missing,
 * because requeue has already narrowed a chunk's range to the frames that
 * never arrived.
 *
 * Both budgets are fresh (plan 1.17 counts the machine's failures in
 * infra_retries apart from the render's in retries) and any backoff is
 * lifted: a chunk revived with its infra budget spent would fail again at
 * its first dropped connection. error_kind stays as the record of why it
 * failed last. A job the breaker holds (jobs.attention) stays held: its
 * chunks wait, pending, for the hold to be released.
 */

import { getDb } from '../db/db'
import { emitChunksChanged, refreshJobState } from './jobs'

/** Put `jobId`'s failed chunks back to pending. Returns how many were revived. */
export function reviveFailedChunks(jobId: string): number {
  const db = getDb()
  const failed = db
    .prepare(`SELECT id FROM chunks WHERE job_id = ? AND state = 'failed'`)
    .all(jobId) as Array<{ id: string }>
  if (failed.length === 0) return 0
  const revived = db
    .prepare(
      `UPDATE chunks SET state = 'pending', node_id = NULL, retries = 0,
              infra_retries = 0, not_before = NULL
        WHERE job_id = ? AND state = 'failed'`
    )
    .run(jobId).changes
  emitChunksChanged(failed.map((c) => c.id))
  refreshJobState(jobId)
  return revived
}
