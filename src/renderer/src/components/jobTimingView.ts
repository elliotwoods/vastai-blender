/**
 * What JobTiming says about a job's time, as parts to lay out: pure, so the
 * wording is tested without rendering. Main works the figures out
 * (shared/jobTiming.ts) as of `timingAt`; they are projected to `now` here
 * with projectTiming, so a live job's clock runs on and its time left counts
 * down between job:changed pushes.
 *
 *   running   elapsed 1h 02m · 14m left · ETA 14:32
 *   compact   14m left · ETA 14:32
 *   complete  took 1h 02m · finished 14:32
 *   cancelled ran 1h 02m · cancelled Tue 14:32
 *   queued    queued
 */

import { isLiveJob, projectTiming } from '../../../shared/jobTiming'
import type { JobSummary, JobTimingBasis } from '../../../shared/models'
import { fmtEta, fmtSpan } from '../lib/format'

/** The fields of a JobSummary the timing reads. */
export type JobTimingJob = Pick<
  JobSummary,
  | 'state'
  | 'startedAt'
  | 'finishedAt'
  | 'elapsedMs'
  | 'remainingMs'
  | 'etaAt'
  | 'framesPerHour'
  | 'timingBasis'
  | 'timingAt'
>

/**
 * One figure: `label` before it and `after` it in the sans face, `value` in
 * mono. A part with no value is a phrase on its own ("queued").
 */
export interface TimingPart {
  label?: string
  value?: string
  after?: string
  /** the figure the eye should land on (the ETA; the finish time) */
  emphasis?: boolean
  /** a phrase standing in for a figure: "estimating…", "queued" */
  muted?: boolean
}

export type TimingKind = 'queued' | 'running' | 'finished' | 'stopped' | 'none'

export interface JobTimingView {
  kind: TimingKind
  parts: TimingPart[]
  /** the whole story in a sentence, for the tooltip and aria */
  title: string
}

const BASIS_TEXT: Record<JobTimingBasis, string> = {
  downloads: 'from the rate frames have been arriving',
  live: 'from the nodes’ live progress',
  scenePerf: 'a first guess from the scene’s measured time per frame',
  none: ''
}

const STOPPED_VERB: Partial<Record<JobSummary['state'], string>> = {
  failed: 'failed',
  cancelled: 'cancelled',
  partial: 'ended'
}

function rateText(framesPerHour: number | null): string | null {
  if (framesPerHour == null || !Number.isFinite(framesPerHour) || framesPerHour <= 0) return null
  const n = framesPerHour >= 100 ? Math.round(framesPerHour) : Number(framesPerHour.toFixed(1))
  return `${n.toLocaleString()} frames/h`
}

function sentence(parts: TimingPart[]): string {
  return parts.map((p) => [p.label, p.value, p.after].filter(Boolean).join(' ')).join(' · ')
}

export function jobTimingView(job: JobTimingJob, now: number, compact = false): JobTimingView {
  const t = projectTiming(job, now)

  if (isLiveJob(job.state)) {
    if (t.elapsedMs == null) {
      const parts: TimingPart[] = [{ value: 'queued', muted: true }]
      return { kind: 'queued', parts, title: 'Queued: no frame has been sent to a node yet' }
    }
    const elapsed: TimingPart = { label: 'elapsed', value: fmtSpan(t.elapsedMs) }
    // A rough basis gets a "~": the scene's time per frame says little about
    // how many nodes will pick the job up.
    const rough = job.timingBasis === 'scenePerf' ? '~' : ''
    const estimate: TimingPart[] =
      t.remainingMs == null
        ? [{ value: job.state === 'queued' ? 'waiting for a node' : 'estimating…', muted: true }]
        : t.remainingMs === 0
          ? [{ value: 'finishing', muted: true }]
          : [
              { value: `${rough}${fmtSpan(t.remainingMs)}`, after: 'left' },
              ...(t.etaAt != null
                ? [{ label: 'ETA', value: fmtEta(t.etaAt, now), emphasis: true }]
                : [])
            ]
    const hasEstimate = t.remainingMs != null && t.remainingMs > 0
    const parts = compact ? (hasEstimate ? estimate : [elapsed]) : [elapsed, ...estimate]
    const rate = rateText(job.framesPerHour)
    const basis = BASIS_TEXT[job.timingBasis]
    const full = sentence([elapsed, ...estimate])
    const why = [rate, basis].filter(Boolean).join(', ')
    return { kind: 'running', parts, title: why ? `${full} (${why})` : full }
  }

  const verb = job.state === 'complete' ? 'finished' : (STOPPED_VERB[job.state] ?? 'ended')
  const kind: TimingKind = job.state === 'complete' ? 'finished' : 'stopped'
  const took: TimingPart | null =
    t.elapsedMs == null
      ? null
      : { label: job.state === 'complete' ? 'took' : 'ran', value: fmtSpan(t.elapsedMs) }
  const at: TimingPart | null =
    job.finishedAt == null
      ? null
      : { label: verb, value: fmtEta(job.finishedAt, now), emphasis: job.state === 'complete' }
  const all = [took, at].filter((p): p is TimingPart => p != null)
  if (all.length === 0) return { kind: 'none', parts: [], title: '' }
  const parts = compact && took ? [took] : all
  const rate = rateText(job.framesPerHour)
  const full = sentence(all)
  return { kind, parts, title: rate ? `${full} (averaged ${rate})` : full }
}
