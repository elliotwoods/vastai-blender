/**
 * Live per-chunk render progress — renderer-local, fed by `chunk:progress`.
 *
 * This event used to be thrown away and used only to invalidate the job query,
 * which meant the payload's `currentFrame` never reached the UI at all and
 * every 5s agent poll cost a `job:get` (two COUNT(*) scans of `frames`). Now
 * the numbers land here and `chunk:changed` — lifecycle only — does the
 * invalidating.
 *
 * Note this holds RENDERED counts (what the agent reports), while a job's
 * `framesDone` counts DOWNLOADED frames. They differ mid-chunk by whatever is
 * still in transit, and that is not a bug: one is "made", the other is "here".
 */

import { create } from 'zustand'
import type { ChunkProgressEvent, RenderStatus } from '../../../shared/models'

export interface ChunkProgress extends ChunkProgressEvent {
  /** epoch ms this sample arrived — drives the "stale" affordance */
  at: number
}

interface ProgressState {
  byChunk: Record<string, ChunkProgress>
  /** the same records, by job then chunk: what useJobProgress hands out by reference */
  byJob: Record<string, Record<string, ChunkProgress>>
  record: (e: ChunkProgressEvent) => void
  forget: (chunkId: string) => void
}

function sameStatus(
  a: RenderStatus | null | undefined,
  b: RenderStatus | null | undefined
): boolean {
  if (a == null || b == null) return (a ?? null) === (b ?? null)
  for (const k of Object.keys(a) as Array<keyof RenderStatus>) if (a[k] !== b[k]) return false
  return Object.keys(b).length === Object.keys(a).length
}

/**
 * Whether a sample says nothing its record does not. Blender's status line
 * and the agent's status count as news: a chunk stuck on one frame for
 * minutes still moves its "Sample 32/256", and that is what the live panel
 * shows.
 */
export function sameProgress(prev: ChunkProgressEvent, e: ChunkProgressEvent): boolean {
  return (
    prev.jobId === e.jobId &&
    prev.nodeId === e.nodeId &&
    prev.framesDone === e.framesDone &&
    prev.currentFrame === e.currentFrame &&
    prev.framesTotal === e.framesTotal &&
    (prev.status ?? null) === (e.status ?? null) &&
    (prev.lastLine ?? null) === (e.lastLine ?? null) &&
    (prev.lastProgressAt ?? null) === (e.lastProgressAt ?? null) &&
    (prev.avgFrameS ?? null) === (e.avgFrameS ?? null) &&
    sameStatus(prev.renderStatus, e.renderStatus)
  )
}

export const useProgressStore = create<ProgressState>((set) => ({
  byChunk: {},
  byJob: {},
  record: (e) =>
    set((s) => {
      const prev = s.byChunk[e.chunkId]
      // Identical samples are common — the agent rewrites its state file every
      // ~2s whether or not a frame landed. Returning the same object keeps
      // subscribers from re-rendering on a no-op.
      if (prev && sameProgress(prev, e)) return s
      const rec: ChunkProgress = { ...e, at: Date.now() }
      const byJob = { ...s.byJob, [e.jobId]: { ...s.byJob[e.jobId], [e.chunkId]: rec } }
      // A chunk that moved to another job's index (never expected) leaves the old one.
      if (prev && prev.jobId !== e.jobId) byJob[prev.jobId] = without(byJob[prev.jobId], e.chunkId)
      return { byChunk: { ...s.byChunk, [e.chunkId]: rec }, byJob }
    }),
  forget: (chunkId) =>
    set((s) => {
      const prev = s.byChunk[chunkId]
      if (!prev) return s
      const byJob = { ...s.byJob }
      const left = without(byJob[prev.jobId], chunkId)
      if (Object.keys(left).length === 0) delete byJob[prev.jobId]
      else byJob[prev.jobId] = left
      return { byChunk: without(s.byChunk, chunkId), byJob }
    })
}))

function without<T>(rec: Record<string, T> | undefined, key: string): Record<string, T> {
  const rest = { ...rec }
  delete rest[key]
  return rest
}

/** What useJobProgress returns for a job with no live chunk: one object, so it never looks new. */
export const NO_PROGRESS: Readonly<Record<string, ChunkProgress>> = Object.freeze({})

/**
 * Live progress for one chunk, or null.
 *
 * Returns the STORED RECORD BY REFERENCE — never a freshly-built object. A
 * selector that constructs its return value makes zustand's
 * useSyncExternalStore see a new snapshot on every render and blow the update
 * depth, which is the same trap `NO_LINES` exists for in logStore.
 */
export function useChunkProgress(chunkId: string): ChunkProgress | null {
  return useProgressStore((s) => s.byChunk[chunkId] ?? null)
}

/**
 * Live progress for every chunk of one job, by chunk id: the store's own
 * record (by reference, as useChunkProgress's), which changes only when one
 * of this job's chunks reports something new, so a job's live panel is not
 * re-rendered by every other job's samples. NO_PROGRESS when none.
 */
export function useJobProgress(jobId: string): Readonly<Record<string, ChunkProgress>> {
  return useProgressStore((s) => s.byJob[jobId] ?? NO_PROGRESS)
}
