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
import type { ChunkProgressEvent } from '../../../shared/models'

export interface ChunkProgress extends ChunkProgressEvent {
  /** epoch ms this sample arrived — drives the "stale" affordance */
  at: number
}

interface ProgressState {
  byChunk: Record<string, ChunkProgress>
  record: (e: ChunkProgressEvent) => void
  forget: (chunkId: string) => void
}

export const useProgressStore = create<ProgressState>((set) => ({
  byChunk: {},
  record: (e) =>
    set((s) => {
      const prev = s.byChunk[e.chunkId]
      // Identical samples are common — the agent rewrites its state file every
      // ~2s whether or not a frame landed. Returning the same object keeps
      // subscribers from re-rendering on a no-op.
      if (
        prev &&
        prev.framesDone === e.framesDone &&
        prev.currentFrame === e.currentFrame &&
        prev.framesTotal === e.framesTotal
      ) {
        return s
      }
      return { byChunk: { ...s.byChunk, [e.chunkId]: { ...e, at: Date.now() } } }
    }),
  forget: (chunkId) =>
    set((s) => {
      if (!(chunkId in s.byChunk)) return s
      const rest = { ...s.byChunk }
      delete rest[chunkId]
      return { byChunk: rest }
    })
}))

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
