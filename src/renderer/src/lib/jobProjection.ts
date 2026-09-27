/**
 * Where a job is heading, next to where it is: the time it will have taken
 * and what it will have cost, for the Jobs list's "so far / total" columns
 * and the job header. Pure; projected to `now` like JobTiming, so a live
 * job's figures move between job:changed pushes.
 */

import { isLiveJob, projectTiming } from '../../../shared/jobTiming'
import type { JobSummary } from '../../../shared/models'

export type JobProjectionJob = Pick<
  JobSummary,
  | 'state'
  | 'elapsedMs'
  | 'remainingMs'
  | 'etaAt'
  | 'timingAt'
  | 'timingBasis'
  | 'costSoFar'
  | 'framesDone'
  | 'framesTotal'
  | 'framesCancelled'
>

export interface JobTimeTotals {
  /** ms rendering so far (all of it, once finished); null = never started */
  takenMs: number | null
  /** ms it will have taken in all; takenMs once finished; null = no estimate */
  totalMs: number | null
}

export function jobTimeTotals(job: JobProjectionJob, now: number): JobTimeTotals {
  const t = projectTiming(job, now)
  if (!isLiveJob(job.state)) return { takenMs: t.elapsedMs, totalMs: t.elapsedMs }
  const totalMs = t.elapsedMs != null && t.remainingMs != null ? t.elapsedMs + t.remainingMs : null
  return { takenMs: t.elapsedMs, totalMs }
}

export type CostBasis = 'final' | 'time' | 'frames'

/**
 * What the job should cost in all, or null when nothing says yet. A finished
 * job's is what it cost. A live one's scales the spend so far: by time when
 * the timing has an estimate (spend accrues per second of node time), else
 * by frames.
 */
export function expectedCost(
  job: JobProjectionJob,
  now: number
): { cost: number; basis: CostBasis } | null {
  if (!isLiveJob(job.state)) return { cost: job.costSoFar, basis: 'final' }
  const { takenMs, totalMs } = jobTimeTotals(job, now)
  if (takenMs != null && totalMs != null && takenMs > 0 && job.costSoFar > 0) {
    return { cost: (job.costSoFar * totalMs) / takenMs, basis: 'time' }
  }
  const toRender = job.framesTotal - job.framesCancelled
  if (job.framesDone > 0 && job.costSoFar > 0 && toRender > 0) {
    return { cost: (job.costSoFar / job.framesDone) * toRender, basis: 'frames' }
  }
  return null
}

/** A rough estimate (the scene's time per frame, not a measured rate) reads with a "~". */
export function roughMark(job: Pick<JobSummary, 'timingBasis'>): string {
  return job.timingBasis === 'scenePerf' ? '~' : ''
}
