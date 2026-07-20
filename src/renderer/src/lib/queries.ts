/**
 * TanStack Query hooks over IPC — the ONLY place query keys live. Everything
 * that crosses IPC goes through Query (cache/invalidation for free); zustand
 * is reserved for renderer-local UI state. `useIpcEvents()` (mounted once in
 * App) maps push events onto the Query cache.
 */

import {
  useMutation,
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
  JobDetail,
  JobSubmission,
  JobSummary,
  NodeSnapshot,
  SettingsPublic
} from '../../../shared/models'
import { ipc } from './ipc'
import { useLogStore } from './logStore'

export const qk = {
  settings: ['settings'] as const,
  nodes: ['nodes'] as const,
  jobs: ['jobs'] as const,
  job: (id: string) => ['job', id] as const,
  assets: (jobId: string) => ['assets', jobId] as const,
  addons: ['addons'] as const,
  fleetCost: ['fleetCost'] as const
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

export function useSubmitJob(): UseMutationResult<{ jobId: string }, Error, JobSubmission> {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (submission: JobSubmission) => ipc.invoke('job:create', submission),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.jobs })
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
      ipc.on('chunk:progress', (p) => {
        qc.invalidateQueries({ queryKey: qk.job(p.jobId) })
      }),
      ipc.on('asset:added', (e) => {
        qc.invalidateQueries({ queryKey: qk.assets(e.jobId) })
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
