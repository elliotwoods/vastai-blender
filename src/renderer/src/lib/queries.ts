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
  FleetGpuHistory,
  FleetHoldKind,
  FleetHolds,
  HistoryRange,
  HistorySummary,
  JobDetail,
  JobSubmission,
  JobSummary,
  NodeChunkView,
  NodeMetricsHistory,
  NodeSnapshot,
  RequestNodeOptions,
  RetryMissingResult,
  SettingsPatch,
  SettingsPatchResult,
  SettingsPublic,
  UnclaimedInstance
} from '../../../shared/models'
import type { IpcEventMap, IpcEventMapPending } from '../../../shared/ipc'
import { holdsInstance } from '../../../shared/nodeState'
import { useAlertStore } from './alertStore'
import { ipc } from './ipc'
import { useLogStore } from './logStore'
import {
  NO_READINGS,
  RING_MS,
  readingsOfHistory,
  useMetricsStore,
  type MetricsReading
} from './metricsStore'
import { useProgressStore } from './progressStore'
import { HISTORY_POINTS, rangeMs, type UsageRange } from './usageRange'

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
  holds: ['fleetHolds'] as const,
  unclaimed: ['unclaimed'] as const,
  fleetGpuHistory: (range: UsageRange) => ['fleetGpuHistory', range] as const,
  nodeMetricsHistory: (nodeId: string, range: UsageRange) =>
    ['nodeMetricsHistory', nodeId, range] as const
}

/**
 * Main's reply for a channel it has no handler for. Phase 1's channels were
 * declared before their handlers (shared/ipc.ts), and one that has not
 * landed rejects with this.
 */
function noHandler(e: unknown): boolean {
  return e instanceof Error && e.message.includes('No handler registered')
}

/**
 * Every hold in force, for HoldsBanner. The recovery hold also answers on
 * scheduler:recoveryHold, the channel RecoveryBanner read before FleetHolds
 * gathered the holds in one place. While main has no fleet:holds handler it
 * is read from there, so the banner that says "Resume rendering" never goes
 * missing: without it, recovered work waits for a Resume nobody is offered.
 */
async function readHolds(): Promise<FleetHolds> {
  try {
    return await ipc.invoke('fleet:holds')
  } catch (e) {
    if (!noHandler(e)) throw e
    const r = await ipc.invoke('scheduler:recoveryHold')
    return r ? { recovery: r.chunks } : {}
  }
}

/**
 * Why the fleet is not renting (FleetHolds). Main pushes `fleet:holds` when
 * one is set or released. The interval is a backstop for what changes
 * without a push: recovery's count shrinks as its jobs finish, and main
 * releases the hold itself when none is left.
 */
export function useFleetHolds(): UseQueryResult<FleetHolds> {
  return useQuery({
    queryKey: qk.holds,
    queryFn: readHolds,
    refetchInterval: 30_000,
    retry: 1
  })
}

/** Release one hold: "Resume rendering", "Try now", "Check again". */
export function useReleaseHold(): UseMutationResult<FleetHolds, Error, FleetHoldKind> {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (kind: FleetHoldKind) => {
      try {
        return await ipc.invoke('fleet:releaseHold', kind)
      } catch (e) {
        // As readHolds: recovery's own channel, until fleet:releaseHold lands.
        if (kind !== 'recovery' || !noHandler(e)) throw e
        await ipc.invoke('scheduler:resumeRecovery')
        return readHolds()
      }
    },
    onSuccess: (holds) => qc.setQueryData(qk.holds, holds)
  })
}

/**
 * Instances on the Vast account that no node here holds (plan 1.3), each
 * billing until someone destroys it. Main pushes `fleet:unclaimed` when a
 * reconcile changes the list; the interval covers a push this window missed.
 */
export function useUnclaimed(): UseQueryResult<UnclaimedInstance[]> {
  return useQuery({
    queryKey: qk.unclaimed,
    queryFn: () => ipc.invoke('fleet:unclaimed'),
    refetchInterval: 60_000,
    retry: 1
  })
}

/**
 * Destroy one unclaimed instance. Main answers `ok: false` with the reason
 * when Vast has not confirmed it gone; either way the list is read again,
 * so a row goes only when main has let it go.
 */
export function useDestroyUnclaimed(): UseMutationResult<
  { ok: boolean; message: string },
  Error,
  number
> {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (instanceId: number) => ipc.invoke('fleet:destroyUnclaimed', instanceId),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.unclaimed })
  })
}

/**
 * Rent one node by hand. `overSpendCap` is the user's confirmation that it
 * may take the fleet past the spend cap (plan 1.5): main refuses without it.
 */
export function useRequestNode(): UseMutationResult<void, Error, RequestNodeOptions | undefined> {
  return useMutation({
    mutationFn: (opts?: RequestNodeOptions) => ipc.invoke('fleet:requestNode', opts)
  })
}

/** How often each range's history is read again: about a bucket's width, at least 15 s. */
function historyRefetchMs(range: UsageRange): number {
  return Math.max(15_000, Math.min(60_000, rangeMs(range) / 60))
}

/**
 * The whole fleet's GPU use over the last `range` (Feature G). The window
 * is taken when the read runs, so a refetch slides it. The previous range's
 * chart stays up while a new one loads.
 */
export function useFleetGpuHistory(range: UsageRange): UseQueryResult<FleetGpuHistory> {
  return useQuery({
    queryKey: qk.fleetGpuHistory(range),
    queryFn: () => {
      const toMs = Date.now()
      return ipc.invoke('fleet:gpuHistory', {
        fromMs: toMs - rangeMs(range),
        toMs,
        maxPoints: HISTORY_POINTS
      })
    },
    refetchInterval: historyRefetchMs(range),
    placeholderData: (prev) => prev,
    retry: 1
  })
}

/**
 * One node's use over a range longer than the store's hour (6 h, 24 h),
 * from main's history. Shorter ranges draw from the store, live.
 */
export function useNodeMetricsHistory(
  nodeId: string,
  range: UsageRange,
  enabled: boolean
): UseQueryResult<NodeMetricsHistory> {
  return useQuery({
    queryKey: qk.nodeMetricsHistory(nodeId, range),
    queryFn: () => {
      const toMs = Date.now()
      return ipc.invoke('node:metricsHistory', {
        nodeId,
        fromMs: toMs - rangeMs(range),
        toMs,
        maxPoints: HISTORY_POINTS
      })
    },
    enabled,
    refetchInterval: historyRefetchMs(range),
    placeholderData: (prev) => prev,
    retry: 1
  })
}

/** Buckets for a seed: the store's hour at main's narrowest bucket, 30 s. */
const SEED_POINTS = RING_MS / 30_000

/**
 * One node's last hour of GPU use, live (lib/metricsStore): the stored array
 * by reference, so only this node's samples re-render the caller. The first
 * caller for a node seeds the store from node:metricsHistory, since a
 * window opened mid-session has heard none of the hour.
 */
export function useNodeReadings(nodeId: string): readonly MetricsReading[] {
  useEffect(() => {
    if (!useMetricsStore.getState().beginSeed(nodeId)) return
    const toMs = Date.now()
    ipc
      .invoke('node:metricsHistory', {
        nodeId,
        fromMs: toMs - RING_MS,
        toMs,
        maxPoints: SEED_POINTS
      })
      .then((h) => useMetricsStore.getState().seed(nodeId, readingsOfHistory(h), h.bucketMs))
      .catch((e: unknown) => {
        useMetricsStore.getState().seedFailed(nodeId)
        console.warn(`node:metricsHistory for ${nodeId} failed`, e)
      })
  }, [nodeId])
  return useMetricsStore((s) => s.byNode[nodeId] ?? NO_READINGS)
}

export function useSettings(): UseQueryResult<SettingsPublic> {
  return useQuery({ queryKey: qk.settings, queryFn: () => ipc.invoke('settings:get') })
}

/**
 * Save a settings change through main's sanitizer (plan 1.14). The result
 * says which fields main refused or clamped, and why, so the screen can show
 * it next to the field; the cache takes the settings as main now has them.
 */
export function useUpdateSettings(): UseMutationResult<SettingsPatchResult, Error, SettingsPatch> {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (patch: SettingsPatch) => ipc.invoke('settings:update', patch),
    onSuccess: (result) => qc.setQueryData(qk.settings, result.settings)
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
 * "Re-render missing" (plan 1.15): queue the job's frames not yet
 * downloaded again. Main emits chunk:changed and job:changed for what it
 * queued; the invalidations cover a result that changed nothing visible.
 */
export function useRetryMissing(): UseMutationResult<RetryMissingResult | void, Error, string> {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (jobId: string) => ipc.invoke('job:retryMissing', jobId),
    onSuccess: (_r, jobId) => {
      void qc.invalidateQueries({ queryKey: qk.jobs })
      void qc.invalidateQueries({ queryKey: qk.job(jobId) })
    }
  })
}

/**
 * Every push channel: IpcEventMap's, and Phase 1's still waiting in
 * IpcEventMapPending for main to emit them. They are handled here already,
 * so the integration wave's move from one map to the other changes nothing
 * on this side, and main's first emit lands.
 */
type PushEvents = IpcEventMap & IpcEventMapPending
type PushChannel = keyof PushEvents

/**
 * One handler per push channel, or null for a channel deliberately ignored.
 * A map over every push channel, so a channel added to either map without a
 * decision here is a compile error. The `alert` channel went unsubscribed for
 * the app's whole life that way, and it carries the "Destroy failed ... check
 * the Vast.ai console!" warnings.
 */
type EventHandlers = { [E in PushChannel]: ((payload: PushEvents[E]) => void) | null }

/**
 * ipc.on widened to the pending channels. The preload's `on` subscribes to
 * whatever channel it is given; only its type is limited to IpcEventMap.
 */
const onPush = ipc.on as <E extends PushChannel>(
  channel: E,
  listener: (payload: PushEvents[E]) => void
) => () => void

/**
 * Subscribe to main-process push events and fold them into the Query cache.
 * Mount exactly once (in App).
 */
export function useIpcEvents(): void {
  const qc = useQueryClient()
  useEffect(() => {
    const handlers: EventHandlers = {
      'node:changed': (node) => {
        // Gone for good: its hour of readings with it.
        if (node.state === 'destroyed' && !holdsInstance(node)) {
          useMetricsStore.getState().forget(node.id)
        }
        qc.setQueryData<NodeSnapshot[]>(qk.nodes, (prev) => {
          if (!prev) return prev
          const i = prev.findIndex((n) => n.id === node.id)
          if (i < 0) return [...prev, node]
          const next = [...prev]
          next[i] = node
          return next
        })
      },
      'job:changed': (job) => {
        qc.setQueryData<JobSummary[]>(qk.jobs, (prev) => {
          if (!prev) return prev
          const i = prev.findIndex((j) => j.id === job.id)
          if (i < 0) return [job, ...prev]
          const next = [...prev]
          next[i] = job
          return next
        })
        qc.invalidateQueries({ queryKey: qk.job(job.id) })
      },
      // High-rate (one per in-flight chunk per ~5s agent poll): fold into the
      // local store, never invalidate. This used to trigger a job:get per
      // event, which on a multi-slot fleet is a refetch storm — and the
      // payload's currentFrame was discarded, so the UI could not show the
      // one number that says a render is actually moving.
      'chunk:progress': (p) => {
        useProgressStore.getState().record(p)
      },
      // Low-rate lifecycle: this is the invalidation signal. It fires for
      // requeue too, which INSERTs new -rN chunk rows, so a node's chunk list
      // has to be re-read rather than patched.
      'chunk:changed': (c) => {
        qc.invalidateQueries({ queryKey: qk.job(c.jobId) })
        if (c.nodeId) qc.invalidateQueries({ queryKey: qk.nodeChunks(c.nodeId) })
        else qc.invalidateQueries({ queryKey: ['nodeChunks'] })
        if (c.state === 'complete' || c.state === 'failed') {
          useProgressStore.getState().forget(c.chunkId)
        }
      },
      'asset:added': (e) => {
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
      },
      'fleet:cost': (cost) => {
        qc.setQueryData(qk.fleetCost, cost)
      },
      'render:logLine': (e) => {
        useLogStore.getState().append(e)
      },
      // An append stream with UI state of its own (dismissed, toast timers),
      // so a zustand store like the log's rather than the Query cache. No OS
      // notification from here: main raises it (ipc.ts), even with no window
      // open, so a second one from the window would tell the user twice.
      alert: (a) => {
        useAlertStore.getState().receive(a)
      },
      // High rate (every node, every ~15 s), like chunk:progress: into the
      // metrics store, never an invalidation.
      'node:metricsSample': (sample) => {
        useMetricsStore.getState().record(sample)
      },
      'fleet:holds': (holds) => {
        qc.setQueryData(qk.holds, holds)
      },
      'fleet:unclaimed': (list) => {
        qc.setQueryData(qk.unclaimed, list)
      }
    }

    // Generic over the channel, so each handler is checked against its own
    // payload type rather than the union of all of them.
    const subscribe = <E extends PushChannel>(channel: E): (() => void) | null => {
      const handler = handlers[channel]
      return handler ? onPush(channel, handler) : null
    }
    const subs = (Object.keys(handlers) as PushChannel[]).map(subscribe)

    // Then replay what main raised before this window was listening: the
    // boot-time orphan sweep runs before the window exists. Subscribed first,
    // so nothing falls between the two; an alert that arrives by both routes
    // is merged by seed().
    ipc
      .invoke('alerts:recent')
      .then((records) => useAlertStore.getState().seed(records))
      .catch((e: unknown) => console.error('alerts:recent failed', e))

    return () => subs.forEach((off) => off?.())
  }, [qc])
}
