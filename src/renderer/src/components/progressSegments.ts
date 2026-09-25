/**
 * The pure half of ProgressBar: a job's chunks as bar segments weighted by
 * frames, the bar's state from a job's, and where its ticks go.
 *
 * Segments live in frame INDEX space (0..total-1, frame-domain.ts), so a job
 * with a step of 2 is weighted by the frames it renders, not by frame
 * numbers. Where no chunk covers a stretch of the domain the frames there
 * are done: a requeue narrows a chunk to the frames still missing
 * (scheduler.requeueChunk), so what falls out of every chunk was downloaded.
 */

import type { ChunkSnapshot, ChunkState, JobSummary } from '../../../shared/models'
import { chunkRange, domainOf, type FrameDomain } from '../media/frame-domain'

/** How the bar is drawn as a whole. */
export type ProgressBarState = 'queued' | 'active' | 'complete' | 'failed' | 'cancelled' | 'held'

/** What one stretch of the bar is doing, beyond its done frames. */
export type SegmentTone = 'done' | 'working' | 'queued' | 'failed' | 'cancelled'

export interface ProgressSegment {
  /** the chunk's id; null for a stretch no chunk covers, or a merged run */
  id: string | null
  /** first index of the stretch, in frames from the start of the job */
  start: number
  /** frames in the stretch (> 0) */
  frames: number
  /** of those, done; always its first ones (renders run in order) */
  done: number
  tone: SegmentTone
}

/** Live rendered counts by chunk id (progressStore's records fit). */
export type LiveByChunk = Readonly<Record<string, { framesDone: number } | undefined>>

const TONE_OF: Record<ChunkState, SegmentTone> = {
  pending: 'queued',
  assigned: 'queued',
  rendering: 'working',
  encoding: 'working',
  downloading: 'working',
  complete: 'done',
  failed: 'failed',
  cancelled: 'cancelled'
}

export function segmentTone(state: ChunkState): SegmentTone {
  return TONE_OF[state] ?? 'queued'
}

/** The frame range a job covers; omit it and the chunks' own extent is used, step 1. */
export type SegmentDomain = Pick<JobSummary, 'frameStart' | 'frameEnd' | 'frameStep'>

/**
 * A job's chunks as bar segments in frame order, weighted by frames, with
 * the gaps between them filled as done. A chunk's done count is the larger
 * of its snapshot's (downloaded) and the live one (rendered); a complete
 * chunk is all done. Chunks outside the domain are dropped, and overlapping
 * ones (never expected) are clipped to what the previous left over.
 */
export function segmentsFromChunks(
  chunks: readonly ChunkSnapshot[] | undefined,
  liveByChunk?: LiveByChunk,
  job?: SegmentDomain
): ProgressSegment[] {
  const list = chunks ?? []
  let domain: FrameDomain
  if (job) domain = domainOf(job.frameStart, job.frameEnd, job.frameStep)
  else {
    if (list.length === 0) return []
    domain = domainOf(
      Math.min(...list.map((c) => c.frameStart)),
      Math.max(...list.map((c) => c.frameEnd)),
      1
    )
  }
  const spans: Array<{ from: number; to: number; c: ChunkSnapshot }> = []
  for (const c of list) {
    const r = chunkRange(domain, c.frameStart, c.frameEnd)
    if (r && r.to >= r.from) spans.push({ ...r, c })
  }
  spans.sort((a, b) => a.from - b.from)

  const out: ProgressSegment[] = []
  let next = 0
  const gap = (upTo: number): void => {
    if (upTo > next) {
      out.push({ id: null, start: next, frames: upTo - next, done: upTo - next, tone: 'done' })
    }
  }
  for (const s of spans) {
    const from = Math.max(s.from, next)
    if (s.to < from) continue
    gap(from)
    const frames = s.to - from + 1
    const tone = segmentTone(s.c.state)
    const done =
      tone === 'done'
        ? frames
        : Math.max(
            0,
            Math.min(frames, Math.max(s.c.framesDone ?? 0, liveByChunk?.[s.c.id]?.framesDone ?? 0))
          )
    out.push({ id: s.c.id, start: from, frames, done, tone })
    next = s.to + 1
  }
  gap(domain.count)
  return out
}

/** Frames of each kind across segments: what the bar's aria and counts say. */
export interface SegmentTotals {
  total: number
  done: number
  failed: number
  cancelled: number
  working: number
}

export function segmentTotals(segments: readonly ProgressSegment[]): SegmentTotals {
  const t: SegmentTotals = { total: 0, done: 0, failed: 0, cancelled: 0, working: 0 }
  for (const s of segments) {
    t.total += s.frames
    t.done += s.done
    const rest = s.frames - s.done
    if (s.tone === 'failed') t.failed += rest
    else if (s.tone === 'cancelled') t.cancelled += rest
    else if (s.tone === 'working') t.working += rest
  }
  return t
}

function whole(s: ProgressSegment): 'all' | 'none' | 'part' {
  return s.done >= s.frames ? 'all' : s.done <= 0 ? 'none' : 'part'
}

/**
 * Neighbours that draw the same (both all done, or both untouched with the
 * same tone) merged into one, so a thousand-chunk job is a handful of
 * elements. Merged runs lose their id.
 */
export function mergeSegments(segments: readonly ProgressSegment[]): ProgressSegment[] {
  const out: ProgressSegment[] = []
  for (const s of segments) {
    const prev = out[out.length - 1]
    if (prev && prev.start + prev.frames === s.start) {
      const a = whole(prev)
      const b = whole(s)
      if ((a === 'all' && b === 'all') || (a === 'none' && b === 'none' && prev.tone === s.tone)) {
        out[out.length - 1] = {
          id: null,
          start: prev.start,
          frames: prev.frames + s.frames,
          done: prev.done + s.done,
          tone: a === 'all' ? 'done' : prev.tone
        }
        continue
      }
    }
    out.push({ ...s })
  }
  return out
}

/**
 * The bar state for a job: a live job the retry breaker (or anything else
 * needing the user) has stopped is held; a partial job, finished with frames
 * missing, draws as failed.
 */
export function barStateOf(job: Pick<JobSummary, 'state' | 'attention'>): ProgressBarState {
  switch (job.state) {
    case 'queued':
      return job.attention ? 'held' : 'queued'
    case 'running':
      return job.attention ? 'held' : 'active'
    case 'complete':
      return 'complete'
    case 'cancelled':
      return 'cancelled'
    default:
      return 'failed'
  }
}

/** Fewest pixels a unit needs before the bar marks each one. */
export const MIN_TICK_PX = 3

export type TickPlan =
  | { kind: 'none' }
  /** a mark between every frame: a repeating background, 1/total apart */
  | { kind: 'frames'; total: number }
  /** a mark at each chunk boundary, as fractions of the bar (0 < f < 1) */
  | { kind: 'chunks'; at: number[] }

/**
 * Where the bar's ticks go at `widthPx`: between frames when every frame
 * gets MIN_TICK_PX, else between chunks when the chunks average that much,
 * else none (a bar solid with ticks says nothing).
 */
export function tickPlan(
  widthPx: number,
  total: number,
  segments?: readonly ProgressSegment[]
): TickPlan {
  if (!(widthPx > 0) || !(total > 1)) return { kind: 'none' }
  if (widthPx / total >= MIN_TICK_PX) return { kind: 'frames', total }
  const chunks = (segments ?? []).filter((s) => s.id != null)
  if (chunks.length > 1 && widthPx / chunks.length >= MIN_TICK_PX) {
    const at: number[] = []
    for (const s of segments ?? []) {
      if (s.start > 0 && s.start < total) at.push(s.start / total)
    }
    return { kind: 'chunks', at }
  }
  return { kind: 'none' }
}
