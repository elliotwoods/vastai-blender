/**
 * The order pending chunks are offered in (Scheduler.pendingChunks): the
 * render queue's (jobs/queue.ts), entry by entry, and within a group of jobs
 * sharing one entry, their chunks in turn towards equal progress: each pick
 * goes to the member with the least of its frames committed (rendered,
 * rendering, or already picked in this pass) for its size, so a 100-frame
 * job grouped with a 1000-frame one does not wait for it, nor it for the
 * small one. Pure.
 */

/** What the order reads of a pending chunk. */
export interface QueuedChunk {
  job_id: string
  /** the job's group, which its chunks share an entry with; null = on its own */
  group_id: string | null
  /** frames the chunk would render */
  frames_left: number
}

/** A grouped job's frames: all of them, and those not waiting in a pending chunk. */
export interface JobProgress {
  committed: number
  total: number
}

/** The queue entry a chunk belongs to: its group, or its job alone. */
export function entryKey(c: Pick<QueuedChunk, 'job_id' | 'group_id'>): string {
  return c.group_id != null ? `group:${c.group_id}` : `job:${c.job_id}`
}

/**
 * `rows` in the order to offer them. `rows` come in queue order (queue_pos,
 * then submission, then frame), so an entry's chunks are contiguous and each
 * job's are in frame order; that order is kept for every entry of one job.
 * A grouped job missing from `progress` counts as nothing committed.
 */
export function orderQueue<T extends QueuedChunk>(
  rows: readonly T[],
  progress: ReadonlyMap<string, JobProgress>
): T[] {
  const out: T[] = []
  let i = 0
  while (i < rows.length) {
    const key = entryKey(rows[i])
    let j = i
    while (j < rows.length && entryKey(rows[j]) === key) j++
    const entry = rows.slice(i, j)
    i = j
    if (rows[i - 1].group_id == null) {
      out.push(...entry)
      continue
    }
    // Per member, its chunks in order; members in the order they appear.
    const members = new Map<string, T[]>()
    for (const c of entry) {
      const list = members.get(c.job_id)
      if (list) list.push(c)
      else members.set(c.job_id, [c])
    }
    const done = new Map<string, number>()
    const size = new Map<string, number>()
    for (const [jobId, list] of members) {
      const p = progress.get(jobId)
      const waiting = list.reduce((a, c) => a + c.frames_left, 0)
      const total = Math.max(p?.total ?? waiting, 1)
      size.set(jobId, total)
      done.set(jobId, p ? p.committed : 0)
    }
    for (;;) {
      let best: string | null = null
      let bestRatio = Infinity
      for (const [jobId, list] of members) {
        if (list.length === 0) continue
        const ratio = done.get(jobId)! / size.get(jobId)!
        if (ratio < bestRatio) {
          best = jobId
          bestRatio = ratio
        }
      }
      if (best == null) break
      const c = members.get(best)!.shift()!
      out.push(c)
      done.set(best, done.get(best)! + c.frames_left)
    }
  }
  return out
}
