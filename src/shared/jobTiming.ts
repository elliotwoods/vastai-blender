/**
 * How long a job has been rendering, how long it has left, and when it will
 * be done. Pure, and shared: main works it out for each JobSummary it sends
 * (jobs.ts), and the renderer projects the same figures forward between
 * updates (projectTiming) rather than showing a countdown that only moves
 * when the next job:changed arrives.
 *
 * The rate behind the estimate comes from the best evidence there is:
 *  1. downloads: the last few frames that landed on this computer. They are
 *     the job's real throughput, every node working in parallel included,
 *     and the estimate decays on its own when frames stop arriving;
 *  2. live: the sum of the rates the job's runs measure from their progress
 *     polls, before any frame has landed;
 *  3. scenePerf: the scene's measured seconds per frame (scene_perf) times
 *     the renders running now, before any run has measured a rate.
 * With none of them (a job still waiting for a node), nothing is estimated.
 */

import type { JobState, JobTimingBasis } from './models'

export type { JobTimingBasis }

export interface JobTimingInput {
  /** epoch ms the estimate is for */
  now: number
  state: JobState
  /** epoch ms the job's first chunk was dispatched; null = never */
  startedAt: number | null
  /** epoch ms the job reached a final state; null = not finished */
  finishedAt: number | null
  framesDone: number
  framesTotal: number
  /** frames the cancel stopped, which nothing will render */
  framesCancelled?: number
  /** downloaded_at of the job's most recent frames (any order); at most the last 30 matter */
  recentDownloads?: readonly number[]
  /** sum of the job's live runs' measured rates, frames per second; null = none measured */
  liveFramesPerSec?: number | null
  /** the scene's measured seconds per frame on one render (scene_perf); null = never timed */
  secondsPerFrame?: number | null
  /** renders of this job running now */
  liveLanes?: number
}

export interface JobTiming {
  /** ms from startedAt to finishedAt, or to now while unfinished; null = never started */
  elapsedMs: number | null
  /** ms still to go at `now`; 0 once complete; null = cannot be told, or never will be */
  remainingMs: number | null
  /** epoch ms the job should be done (finishedAt once it is); null as remainingMs */
  etaAt: number | null
  /** the rate the estimate is from, frames per hour; for a finished job its average */
  framesPerHour: number | null
  basis: JobTimingBasis
}

/** How many of the latest downloads the window reads. */
export const DOWNLOAD_WINDOW = 30
/** Fewest downloads the window needs: two gaps between frames. */
const MIN_DOWNLOADS = 3
/**
 * After how long without a frame the download window is not believed any
 * more (and the next basis is tried): a quarter of an hour, or four of the
 * window's mean gaps if frames came slower than that.
 */
const STALE_MIN_MS = 15 * 60_000
const STALE_GAPS = 4

const LIVE_STATES: ReadonlySet<JobState> = new Set<JobState>(['queued', 'running'])

export function isLiveJob(state: JobState): boolean {
  return LIVE_STATES.has(state)
}

function positive(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0
}

/**
 * Frames per ms from the download window, or null when it says nothing.
 *
 * The mean gap between the window's frames, over (last − first); when the
 * newest frame is older than one mean gap, the span runs to `now` less one
 * gap instead, so the rate falls smoothly while frames stop arriving, and
 * the window is dropped once it is stale.
 */
function downloadRate(times: readonly number[], now: number): number | null {
  const sorted = [...times].filter((t) => Number.isFinite(t) && t <= now).sort((a, b) => a - b)
  const window = sorted.slice(-DOWNLOAD_WINDOW)
  if (window.length < MIN_DOWNLOADS) return null
  const first = window[0]
  const last = window[window.length - 1]
  const gaps = window.length - 1
  if (last <= first) return null
  const meanGap = (last - first) / gaps
  if (now - last > Math.max(STALE_MIN_MS, STALE_GAPS * meanGap)) return null
  const span = Math.max(last - first, now - first - meanGap)
  return gaps / span
}

export function estimateJobTiming(i: JobTimingInput): JobTiming {
  const live = isLiveJob(i.state)
  // A finished job with no finishedAt (one from before it was recorded that
  // the backfill could not place) has no end to measure to.
  const end = i.finishedAt ?? (live ? i.now : null)
  const elapsedMs = i.startedAt != null && end != null ? Math.max(0, end - i.startedAt) : null

  if (!live) {
    // Finished: what it averaged, and no estimate. A complete job took no
    // time more; a cancelled, failed or partial one never will finish.
    const framesPerHour =
      elapsedMs != null && elapsedMs > 0 && i.framesDone > 0
        ? (i.framesDone / elapsedMs) * 3_600_000
        : null
    const complete = i.state === 'complete'
    return {
      elapsedMs,
      remainingMs: complete ? 0 : null,
      etaAt: complete ? (i.finishedAt ?? null) : null,
      framesPerHour,
      basis: 'none'
    }
  }

  let perMs: number | null = null
  let basis: JobTimingBasis = 'none'
  const fromDownloads = downloadRate(i.recentDownloads ?? [], i.now)
  if (fromDownloads != null) {
    perMs = fromDownloads
    basis = 'downloads'
  } else if (positive(i.liveFramesPerSec)) {
    perMs = i.liveFramesPerSec / 1000
    basis = 'live'
  } else if (positive(i.secondsPerFrame) && positive(i.liveLanes)) {
    perMs = i.liveLanes / (i.secondsPerFrame * 1000)
    basis = 'scenePerf'
  }

  const left = Math.max(0, i.framesTotal - i.framesDone - (i.framesCancelled ?? 0))
  if (perMs == null) {
    return { elapsedMs, remainingMs: null, etaAt: null, framesPerHour: null, basis }
  }
  const remainingMs = Math.round(left / perMs)
  return {
    elapsedMs,
    remainingMs,
    etaAt: i.now + remainingMs,
    framesPerHour: perMs * 3_600_000,
    basis
  }
}

/** The timing fields as a JobSummary carries them, `timingAt` the moment they were worked out. */
export interface TimingFields {
  state: JobState
  elapsedMs: number | null
  remainingMs: number | null
  etaAt: number | null
  timingAt: number
}

/**
 * A summary's elapsed and remaining time as of `now`, projected from when
 * main worked them out: a live job's clock runs on and its remaining time
 * counts down (to 0, never below: past the ETA it is "any moment now").
 * The ETA itself does not move between updates.
 */
export function projectTiming(
  t: TimingFields,
  now: number
): { elapsedMs: number | null; remainingMs: number | null; etaAt: number | null } {
  if (!isLiveJob(t.state)) {
    return { elapsedMs: t.elapsedMs, remainingMs: t.remainingMs, etaAt: t.etaAt }
  }
  const dt = Math.max(0, now - t.timingAt)
  return {
    elapsedMs: t.elapsedMs == null ? null : t.elapsedMs + dt,
    remainingMs: t.remainingMs == null ? null : Math.max(0, t.remainingMs - dt),
    etaAt: t.etaAt
  }
}
