/**
 * Give a job's missing frames another go: plan 1.15's "Re-render missing"
 * (job:retryMissing, app/recovery.ts), and the VR_JOB_SPEC driver's heal of
 * a half-done job when a campaign is resubmitted (app/headless/jobSpec.ts).
 * One copy of the SQL for both, moved out of index.ts.
 *
 * A chunk fails for good once its retries are spent, perhaps by a dispatch
 * bug fixed since, and a cancel marks every chunk still open 'cancelled'.
 * Either way it
 * keeps the range of its last attempt, frames that landed during it
 * included: requeue narrows a range only when it sends the chunk out again.
 * The spec sends the whole range, so a chunk revived as it stood rendered
 * and billed those frames again (skipped only by Overwrite off, on the node
 * that still had the chunk's folder). So each one is narrowed first, as
 * requeue does it (missingRanges over the frames table): it keeps its id for
 * its first run of missing frames, each further run becomes a new chunk, and
 * a failed or cancelled chunk with nothing missing is complete.
 *
 * "Missing" is every frame not yet downloaded that no live chunk (pending or
 * in flight) already covers, read from the frames table rather than the
 * chunks' states. A job can be 'partial' with no failed chunk at all:
 * refreshJobState calls a job whose chunks are all complete but whose frames
 * are not all on disk partial, and builds before 0.9 completed chunks like
 * that. Such a chunk is reopened like a failed one. A frame no chunk's range
 * covers any more gets a chunk of its own. So the "Re-render missing (N
 * frames)" JobDetail offers is what gets queued.
 *
 * Both budgets are fresh (plan 1.17 counts the machine's failures in
 * infra_retries apart from the render's in retries) and any backoff is
 * lifted: a chunk revived with its infra budget spent would fail again at
 * its first dropped connection. error_kind stays as the record of why it
 * failed last.
 *
 * Not revived: a job the scheduler failed outright (failJob, plan 1.16), for
 * a scene no node can render as it stands or an engine none has. It renders
 * its snapshot of the scene (1.12), so reviving it would pay for a node to
 * fail the same way; it is submitted again once the scene is fixed. A
 * cancelled job is: re-rendering what it is missing is how a cancel is
 * undone. A job the breaker holds (jobs.attention) stays held here, its
 * chunks pending behind the hold; job:retryMissing releases the hold
 * (app/recovery.ts), a resubmitted campaign does not.
 */

import { getDb } from '../db/db'
import { getSettings } from '../settings'
import { autoChunkSize, missingRanges, splitFrames, type FrameRange } from '../scheduler/chunker'
import type { ChunkState, JobState, RetryMissingResult } from '../../shared/models'
import { emitChunksChanged, refreshJobState } from './jobs'

/** A chunk that stopped short of complete: out of retries, or cancelled. */
const STOPPED: ReadonlySet<ChunkState> = new Set<ChunkState>(['failed', 'cancelled'])

/** A chunk with a run to come or under way: its frames are already queued. */
const LIVE: ReadonlySet<ChunkState> = new Set<ChunkState>([
  'pending',
  'assigned',
  'rendering',
  'encoding',
  'downloading'
])

interface JobRow {
  id: string
  name: string
  state: JobState
  frame_step: number
  chunk_size: number | null
}

interface ChunkRow {
  id: string
  frame_start: number
  frame_end: number
  state: ChunkState
  error_kind: string | null
}

/** A job reviveFailedChunks will not revive, with why, in words for the user. */
export class NotRevivable extends Error {
  override readonly name = 'NotRevivable'
}

/**
 * Put every missing frame of `jobId` back in the queue (see the header).
 * Returns the frames queued and the chunks they are in: `{ frames: 0,
 * chunks: 0 }` when nothing is missing. Throws NotRevivable for an unknown
 * job, one the scheduler failed outright and one whose frame step would
 * never advance, and whatever missingRanges or splitFrames throw on a range
 * or chunk size they refuse; either way having written nothing.
 */
export function reviveFailedChunks(jobId: string): RetryMissingResult {
  const db = getDb()
  const job = db
    .prepare('SELECT id, name, state, frame_step, chunk_size FROM jobs WHERE id = ?')
    .get(jobId) as JobRow | undefined
  if (!job) throw new NotRevivable(`no job ${jobId}`)
  if (job.state === 'failed') {
    throw new NotRevivable(
      `job ${job.name} failed outright: no node can render it as it stands, and rendering ` +
        'it again would fail the same way. Fix the scene and submit it again.'
    )
  }
  // Checked before any walk over the job's grid, the one below included:
  // a step that never advances would spin there for good. This runs on the
  // main process's one thread (job:retryMissing, the VR_JOB_SPEC driver),
  // so a spin stops everything: destroys, the supervisor, the quit dialog.
  // createJob cannot write such a step; a hand-edited or damaged database
  // can. As missingRanges' own check, which lets old jobs' fractional steps
  // through.
  const step = job.frame_step
  if (!Number.isFinite(step) || step <= 0) {
    throw new NotRevivable(`job ${job.name} has no usable frame step (${step})`)
  }

  const chunks = db
    .prepare(
      `SELECT id, frame_start, frame_end, state, error_kind FROM chunks
        WHERE job_id = ? ORDER BY frame_start, id`
    )
    .all(jobId) as ChunkRow[]
  const live = chunks.filter((c) => LIVE.has(c.state))
  const covered = (f: number): boolean => live.some((c) => f >= c.frame_start && f <= c.frame_end)
  const missing = new Set(
    (
      db
        .prepare(`SELECT frame FROM frames WHERE job_id = ? AND state != 'downloaded'`)
        .all(jobId) as Array<{ frame: number }>
    )
      .map((r) => r.frame)
      .filter((f) => !covered(f))
  )
  // Nothing to queue, and no stopped chunk to settle as complete.
  if (missing.size === 0 && !chunks.some((c) => STOPPED.has(c.state))) {
    return { frames: 0, chunks: 0 }
  }

  const touched: string[] = []
  let frames = 0
  let queued = 0

  db.transaction(() => {
    const exists = db.prepare('SELECT 1 FROM chunks WHERE id = ?')
    // `-m` for missing, apart from the scheduler's `-rN` re-splits, and never
    // an id in use: the same range may have been re-rendered before.
    const freshId = (range: FrameRange): string => {
      const base = `${jobId.slice(0, 8)}-${range.start}-${range.end}`
      for (let n = 1; ; n++) {
        const id = `${base}-m${n}`
        if (!exists.get(id)) return id
      }
    }
    const reopen = db.prepare(
      `UPDATE chunks SET state = 'pending', node_id = NULL, frames_done = 0, retries = 0,
              infra_retries = 0, not_before = NULL, frame_start = ?, frame_end = ?,
              assigned_at = NULL
        WHERE id = ?`
    )
    const insert = db.prepare(
      `INSERT INTO chunks (id, job_id, frame_start, frame_end, state, frames_done, retries,
                           infra_retries, not_before, error_kind)
       VALUES (?, ?, ?, ?, 'pending', 0, 0, 0, NULL, ?)`
    )
    const complete = db.prepare(`UPDATE chunks SET state = 'complete' WHERE id = ?`)
    // A frame not yet downloaded follows the chunk now covering it, as
    // requeue re-points them; a downloaded one keeps the chunk that
    // delivered it.
    const repoint = db.prepare(
      `UPDATE frames SET chunk_id = ?
        WHERE job_id = ? AND frame BETWEEN ? AND ? AND state != 'downloaded'`
    )
    /** `range` is `chunkId`'s now: count its missing frames as queued. */
    const claim = (chunkId: string, range: FrameRange): void => {
      for (const f of missing) {
        if (f >= range.start && f <= range.end) {
          missing.delete(f)
          frames++
        }
      }
      repoint.run(chunkId, jobId, range.start, range.end)
      touched.push(chunkId)
      queued++
    }

    for (const c of chunks) {
      if (!STOPPED.has(c.state) && c.state !== 'complete') continue
      // Its frames still to render: missing, and not claimed by a chunk
      // before it.
      const have = new Set<number>()
      for (let f = c.frame_start; f <= c.frame_end; f += step) if (!missing.has(f)) have.add(f)
      const ranges = missingRanges({ start: c.frame_start, end: c.frame_end }, step, have)
      if (ranges.length === 0) {
        // Everything it was to deliver is on disk: complete, or the job
        // stays partial with no frame missing.
        if (STOPPED.has(c.state)) {
          complete.run(c.id)
          touched.push(c.id)
        }
        continue
      }
      const [first, ...rest] = ranges
      reopen.run(first.start, first.end, c.id)
      claim(c.id, first)
      for (const range of rest) {
        const id = freshId(range)
        insert.run(id, jobId, range.start, range.end, c.error_kind)
        claim(id, range)
      }
    }

    // Frames no chunk's range covers any more. Nothing writes one today; a
    // chunk row lost to a crash or a hand edit would. Runs on the job's
    // grid, cut to its chunk size.
    if (missing.size > 0) {
      const size = job.chunk_size ?? autoChunkSize(missing.size, getSettings().maxActiveNodes)
      for (const run of gridRuns([...missing], step)) {
        for (const range of splitFrames(run.start, run.end, step, size)) {
          const id = freshId(range)
          insert.run(id, jobId, range.start, range.end, null)
          claim(id, range)
        }
      }
    }

    // A cancel is final to refreshJobState. What the cancel left is queued
    // again, so the job is no longer cancelled.
    if (queued > 0 && job.state === 'cancelled') {
      db.prepare(`UPDATE jobs SET state = 'queued' WHERE id = ?`).run(jobId)
    }
    // A finished job queued again joins the end of the queue (jobs/queue.ts),
    // behind what was waiting meanwhile, and is listed again if the user had
    // removed it. One still queued or running keeps its place.
    if (queued > 0 && job.state !== 'queued' && job.state !== 'running') {
      db.prepare(
        `UPDATE jobs SET queue_pos = (SELECT COALESCE(MAX(queue_pos), 0) + 1 FROM jobs),
                hidden_at = NULL, group_id = NULL
          WHERE id = ?`
      ).run(jobId)
    }
  })()

  emitChunksChanged(touched)
  refreshJobState(jobId)
  return { frames, chunks: queued }
}

/** `frames` in order, cut into runs where each frame follows the last by `step`. */
function gridRuns(frames: number[], step: number): FrameRange[] {
  const runs: FrameRange[] = []
  for (const f of [...frames].sort((a, b) => a - b)) {
    const last = runs.at(-1)
    if (last && f === last.end + step) last.end = f
    else runs.push({ start: f, end: f })
  }
  return runs
}
