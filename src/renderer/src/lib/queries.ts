/**
 * TanStack Query hooks over IPC — the ONLY place query keys live. Everything
 * that crosses IPC goes through Query (cache/invalidation for free); zustand
 * is reserved for renderer-local UI state. `useIpcEvents()` (mounted once in
 * App) maps push events onto the Query cache.
 */

import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult
} from '@tanstack/react-query'
import { useEffect } from 'react'
import type {
  AddonInfo,
  AssetIndex,
  FleetCost,
  HistoryRange,
  HistorySummary,
  JobDetail,
  JobSubmission,
  JobSummary,
  NodeChunkView,
  NodeSnapshot,
  SettingsPublic
} from '../../../shared/models'
import { ipc } from './ipc'
import { useLogStore } from './logStore'
import { useProgressStore } from './progressStore'

export const qk = {
  settings: ['settings'] as const,
  nodes: ['nodes'] as const,
  jobs: ['jobs'] as const,
  job: (id: string) => ['job', id] as const,
  nodeChunks: (nodeId: string) => ['nodeChunks', nodeId] as const,
  thumbBucket: (jobId: string, bucket: number) => ['thumbs', jobId, bucket] as const,
  assets: (jobId: string) => ['assets', jobId] as const,
  addons: ['addons'] as const,
  fleetCost: ['fleetCost'] as const,
  history: (range: HistoryRange) => ['history', range] as const,
  recoveryHold: ['recoveryHold'] as const
}

/**
 * Startup-recovered chunks whose fleet scale-up is paused, or null when none.
 *
 * Set once at boot and only ever cleared by the user, so there is nothing to
 * poll for — but it IS resolved after the window loads, hence a query rather
 * than a prop.
 */
export function useRecoveryHold(): UseQueryResult<{ chunks: number } | null> {
  return useQuery({
    queryKey: qk.recoveryHold,
    queryFn: () => ipc.invoke('scheduler:recoveryHold')
  })
}

export function useResumeRecovery(): UseMutationResult<void, Error, void> {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => ipc.invoke('scheduler:resumeRecovery'),
    onSuccess: () => qc.setQueryData(qk.recoveryHold, null)
  })
}

export function useSettings(): UseQueryResult<SettingsPublic> {
  return useQuery({ queryKey: qk.settings, queryFn: () => ipc.invoke('settings:get') })
}

export function useUpdateSettings(): UseMutationResult<
  SettingsPublic,
  Error,
  Partial<SettingsPublic>
> {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (patch: Partial<SettingsPublic>) => ipc.invoke('settings:set', patch),
    onSuccess: (next) => qc.setQueryData(qk.settings, next)
  })
}

export function useNodes(): UseQueryResult<NodeSnapshot[]> {
  return useQuery({ queryKey: qk.nodes, queryFn: () => ipc.invoke('nodes:list') })
}

export function useJobs(): UseQueryResult<JobSummary[]> {
  return useQuery({ queryKey: qk.jobs, queryFn: () => ipc.invoke('jobs:list') })
}

export function useJob(id: string): UseQueryResult<JobDetail | null> {
  return useQuery({ queryKey: qk.job(id), queryFn: () => ipc.invoke('job:get', id) })
}

/**
 * Frames-per-thumbnail-query bucket. Buckets exist so one arriving thumbnail
 * invalidates a slice rather than a whole job's index — a 2000-frame job would
 * otherwise re-serialise every row on every frame.
 */
export const THUMB_BUCKET = 256

export function bucketOf(frame: number): number {
  return Math.floor(frame / THUMB_BUCKET)
}

/**
 * Thumbnails for a window of the job's frame domain, fetched a bucket at a
 * time. Returns a frame→url map covering the requested span.
 */
export function useThumbWindow(
  jobId: string | undefined,
  from: number,
  to: number
): Map<number, string> {
  const first = bucketOf(from)
  const last = bucketOf(to)
  const buckets: number[] = []
  for (let b = first; b <= last; b++) buckets.push(b)
  const results = useQueries({
    queries: buckets.map((b) => ({
      queryKey: qk.thumbBucket(jobId ?? '', b),
      queryFn: () =>
        ipc.invoke('frames:thumbs', {
          jobId: jobId as string,
          from: b * THUMB_BUCKET,
          to: (b + 1) * THUMB_BUCKET - 1
        }),
      enabled: !!jobId
    }))
  })
  // Rebuilt per render, but only from the visible window's buckets — the
  // alternative (a memo keyed on the results array) re-runs just as often
  // because TanStack returns fresh result objects each render anyway.
  const map = new Map<number, string>()
  for (const r of results) {
    for (const t of r.data ?? []) map.set(t.frame, t.mediaUrl)
  }
  return map
}

/**
 * What a node is rendering. `enabled` exists because this is a four-table join
 * and the Fleet list can hold a dozen collapsed rows — only the expanded one
 * should be asking.
 */
export function useNodeChunks(nodeId: string, enabled = true): UseQueryResult<NodeChunkView[]> {
  return useQuery({
    queryKey: qk.nodeChunks(nodeId),
    queryFn: () => ipc.invoke('node:chunks', { nodeId }),
    enabled
  })
}

export function useAssetIndex(jobId: string | undefined): UseQueryResult<AssetIndex> {
  return useQuery({
    queryKey: qk.assets(jobId ?? ''),
    queryFn: () => ipc.invoke('assets:index', jobId as string),
    enabled: !!jobId
  })
}

export function useAddons(): UseQueryResult<AddonInfo[]> {
  return useQuery({ queryKey: qk.addons, queryFn: () => ipc.invoke('addons:list') })
}

export function useFleetCost(): UseQueryResult<FleetCost | null> {
  // Filled by the fleet:cost push event; null until the first event arrives.
  return useQuery({
    queryKey: qk.fleetCost,
    queryFn: () => Promise.resolve<FleetCost | null>(null),
    staleTime: Infinity
  })
}

/**
 * Usage history for one window. Refetched on the accrual cadence rather than
 * pushed — History is a review surface, and the live numbers already arrive on
 * `fleet:cost`. `placeholderData` keeps the previous range's chart on screen
 * while a wider one loads, so flipping 1D → 30D doesn't flash empty.
 */
export function useHistorySummary(range: HistoryRange): UseQueryResult<HistorySummary> {
  return useQuery({
    queryKey: qk.history(range),
    queryFn: () => ipc.invoke('history:summary', range),
    refetchInterval: 60_000,
    placeholderData: (prev) => prev
  })
}

export function useSubmitJob(): UseMutationResult<{ jobId: string }, Error, JobSubmission> {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (submission: JobSubmission) => ipc.invoke('job:create', submission),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.jobs })
  })
}

/** Toggle a job's node sharing. Main emits job:changed, which refreshes the cache. */
export function useSetJobShareNode(): UseMutationResult<
  void,
  Error,
  { jobId: string; shareNode: boolean }
> {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ jobId, shareNode }: { jobId: string; shareNode: boolean }) =>
      ipc.invoke('job:setShareNode', jobId, shareNode),
    onSuccess: (_r, { jobId }) => {
      void qc.invalidateQueries({ queryKey: qk.jobs })
      void qc.invalidateQueries({ queryKey: qk.job(jobId) })
    }
  })
}

/**
 * Subscribe to main-process push events and fold them into the Query cache.
 * Mount exactly once (in App).
 */
export function useIpcEvents(): void {
  const qc = useQueryClient()
  useEffect(() => {
    const subs = [
      ipc.on('node:changed', (node) => {
        qc.setQueryData<NodeSnapshot[]>(qk.nodes, (prev) => {
          if (!prev) return prev
          const i = prev.findIndex((n) => n.id === node.id)
          if (i < 0) return [...prev, node]
          const next = [...prev]
          next[i] = node
          return next
        })
      }),
      ipc.on('job:changed', (job) => {
        qc.setQueryData<JobSummary[]>(qk.jobs, (prev) => {
          if (!prev) return prev
          const i = prev.findIndex((j) => j.id === job.id)
          if (i < 0) return [job, ...prev]
          const next = [...prev]
          next[i] = job
          return next
        })
        qc.invalidateQueries({ queryKey: qk.job(job.id) })
      }),
      // High-rate (one per in-flight chunk per ~5s agent poll): fold into the
      // local store, never invalidate. This used to trigger a job:get per
      // event, which on a multi-slot fleet is a refetch storm — and the
      // payload's currentFrame was discarded, so the UI could not show the
      // one number that says a render is actually moving.
      ipc.on('chunk:progress', (p) => {
        useProgressStore.getState().record(p)
      }),
      // Low-rate lifecycle: this is the invalidation signal. It fires for
      // requeue too, which INSERTs new -rN chunk rows, so a node's chunk list
      // has to be re-read rather than patched.
      ipc.on('chunk:changed', (c) => {
        qc.invalidateQueries({ queryKey: qk.job(c.jobId) })
        if (c.nodeId) qc.invalidateQueries({ queryKey: qk.nodeChunks(c.nodeId) })
        else qc.invalidateQueries({ queryKey: ['nodeChunks'] })
        if (c.state === 'complete' || c.state === 'failed') {
          useProgressStore.getState().forget(c.chunkId)
        }
      }),
      ipc.on('asset:added', (e) => {
        if (e.kind === 'thumb') {
          // Thumbs are per-frame and land constantly, so they stay out of the
          // whole-job asset index. They DO have to refresh the node panel:
          // its thumbUrl comes from node:chunks, and without this it would
          // freeze at the last chunk STATE transition while frames streamed
          // in — which is exactly the staleness the panel exists to avoid.
          qc.invalidateQueries({ queryKey: ['nodeChunks'] })
          if (e.frame != null) {
            qc.invalidateQueries({ queryKey: qk.thumbBucket(e.jobId, bucketOf(e.frame)) })
          }
          return
        }
        qc.invalidateQueries({ queryKey: qk.assets(e.jobId) })
        // A job's framesDone counts DOWNLOADED frames, so a landing frame is
        // what actually moves it. This is the signal that keeps JobDetail's
        // "frames X/Y" live now that chunk:progress no longer invalidates —
        // and it fires per download rather than per 5s poll per slot, so it
        // is the cheaper of the two by a wide margin.
        if (e.kind === 'frame') qc.invalidateQueries({ queryKey: qk.job(e.jobId) })
        // A new live clip supersedes the one the node panel is showing.
        if (e.kind === 'live') qc.invalidateQueries({ queryKey: ['nodeChunks'] })
      }),
      ipc.on('fleet:cost', (cost) => {
        qc.setQueryData(qk.fleetCost, cost)
      }),
      ipc.on('render:logLine', (e) => {
        useLogStore.getState().append(e)
      })
    ]
    return () => subs.forEach((off) => off())
  }, [qc])
}
