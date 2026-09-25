/**
 * The job detail screen's pure half: the sidebar's order and its Alt+↑/↓
 * hops, what the chunk grid says about each chunk, the chunk counts, which
 * chunks the live panel shows and when one has gone quiet, and the node
 * sharing switch's wording. Kept apart from the components so it is tested
 * without a DOM.
 */

import type {
  ChunkSnapshot,
  ChunkState,
  ErrorClass,
  JobState,
  JobSummary,
  NodeSnapshot,
  RenderStatus
} from '../../../../shared/models'
import type { StatusTone } from '../../lib/theme'

// -- the jobs sidebar ---------------------------------------------------------

const LIVE: readonly JobState[] = ['queued', 'running']

export function isLiveJobState(state: JobState): boolean {
  return LIVE.includes(state)
}

/**
 * The sidebar's order, the Jobs list's: queued and running jobs in queue
 * order (queuePos, then submission), then finished ones, newest finish
 * first. A local copy of the rule rather than an import from screens/Jobs,
 * which another change owns.
 */
export function sidebarOrder(jobs: readonly JobSummary[]): JobSummary[] {
  const live = jobs.filter((j) => isLiveJobState(j.state) && j.hiddenAt == null)
  const done = jobs.filter((j) => !isLiveJobState(j.state) && j.hiddenAt == null)
  live.sort(
    (a, b) =>
      (a.queuePos ?? Number.MAX_SAFE_INTEGER) - (b.queuePos ?? Number.MAX_SAFE_INTEGER) ||
      a.submittedAt - b.submittedAt
  )
  done.sort(
    (a, b) =>
      (b.finishedAt ?? b.submittedAt) - (a.finishedAt ?? a.submittedAt) ||
      b.submittedAt - a.submittedAt
  )
  return [...live, ...done]
}

/** The job before (-1) or after (+1) `id` in `order`; null at either end or when absent. */
export function neighbourJob(
  order: readonly Pick<JobSummary, 'id'>[],
  id: string,
  dir: -1 | 1
): string | null {
  const i = order.findIndex((j) => j.id === id)
  if (i < 0) return order.length > 0 ? order[dir > 0 ? 0 : order.length - 1].id : null
  return order[i + dir]?.id ?? null
}

/** A job's state as a status dot's tone (a held job's bar says it is held). */
export function jobTone(job: Pick<JobSummary, 'state'>): StatusTone {
  switch (job.state) {
    case 'queued':
      return 'queued'
    case 'running':
      return 'running'
    case 'complete':
      return 'done'
    case 'cancelled':
      return 'dead'
    default:
      return 'error'
  }
}

/** Where the sidebar remembers whether it is open. */
export const SIDEBAR_KEY = 'vr:jobDetail:sidebar'
/** Where the settings section remembers whether it is open. */
export const SETTINGS_KEY = 'vr:jobDetail:settings'

/** A remembered open/closed flag; `fallback` when unset or storage is unavailable. */
export function readFlag(key: string, fallback: boolean): boolean {
  try {
    const v = globalThis.localStorage?.getItem(key)
    return v === '1' ? true : v === '0' ? false : fallback
  } catch {
    return fallback
  }
}

export function writeFlag(key: string, value: boolean): void {
  try {
    globalThis.localStorage?.setItem(key, value ? '1' : '0')
  } catch {
    // private mode, storage full: the choice just is not remembered
  }
}

// -- chunks -------------------------------------------------------------------

/** Frames in a chunk, at the job's step. */
export function chunkFrames(
  c: Pick<ChunkSnapshot, 'frameStart' | 'frameEnd'>,
  step: number
): number {
  const s = Math.max(1, step)
  return c.frameEnd >= c.frameStart ? Math.floor((c.frameEnd - c.frameStart) / s) + 1 : 0
}

/**
 * The chunk size the job was cut with: its largest chunk. A retry narrows a
 * chunk to its missing frames, so the largest is the one still whole. null
 * with no chunks.
 */
export function chunkSizeOf(chunks: readonly ChunkSnapshot[], step: number): number | null {
  let max = 0
  for (const c of chunks) max = Math.max(max, chunkFrames(c, step))
  return max > 0 ? max : null
}

const ACTIVE_STATES: readonly ChunkState[] = ['assigned', 'rendering', 'encoding', 'downloading']

export function isActiveChunk(state: ChunkState): boolean {
  return ACTIVE_STATES.includes(state)
}

export interface ChunkCounts {
  complete: number
  failed: number
  cancelled: number
  active: number
  queued: number
}

export function chunkCounts(chunks: readonly ChunkSnapshot[]): ChunkCounts {
  const n: ChunkCounts = { complete: 0, failed: 0, cancelled: 0, active: 0, queued: 0 }
  for (const c of chunks) {
    if (c.state === 'complete') n.complete++
    else if (c.state === 'failed') n.failed++
    else if (c.state === 'cancelled') n.cancelled++
    else if (c.state === 'pending') n.queued++
    else n.active++
  }
  return n
}

const ERROR_CLASS_WORDS: Record<ErrorClass, string> = {
  transient: 'a passing fault',
  machine: 'the machine',
  account: 'the Vast account',
  job: 'the scene or Blender',
  localFs: 'this computer’s disk'
}

/** How a chunk cell reads: its word, its mark, and its tooltip. */
export interface ChunkCellInfo {
  /** "failed", "cancelled", "rendering"… */
  label: string
  /** "!" for failed, "–" for cancelled, else null */
  mark: string | null
  title: string
}

export function chunkCellInfo(c: ChunkSnapshot, nodeLabel?: string | null): ChunkCellInfo {
  const lines = [`frames ${c.frameStart}–${c.frameEnd} · ${c.state}`]
  if (c.nodeId) lines.push(`on ${nodeLabel ?? c.nodeId.slice(0, 8)}`)
  if (c.retries > 0 || (c.infraRetries ?? 0) > 0) {
    const r = [`${c.retries} render ${c.retries === 1 ? 'retry' : 'retries'}`]
    if (c.infraRetries)
      r.push(`${c.infraRetries} machine ${c.infraRetries === 1 ? 'retry' : 'retries'}`)
    lines.push(r.join(', '))
  }
  if (c.state === 'cancelled') {
    lines.push('Stopped by a cancel before it finished. Re-render missing sends it again.')
  }
  if (c.lastError) {
    const why = c.errorClass ? ` (${ERROR_CLASS_WORDS[c.errorClass] ?? c.errorClass})` : ''
    lines.push(`last error${why}: ${c.lastError}`)
  } else if (c.state === 'failed') {
    lines.push('Failed: no error was recorded.')
  }
  lines.push(`id ${c.id}`)
  return {
    label: c.state,
    mark: c.state === 'failed' ? '!' : c.state === 'cancelled' ? '–' : null,
    title: lines.join('\n')
  }
}

// -- live progress ------------------------------------------------------------

/** After this long without a frame started or saved, a chunk's line reads as stale. */
export const STALE_MS = 30_000

/** Whether a chunk has gone `STALE_MS` without progress; false when it never said. */
export function isStale(lastProgressAt: number | null | undefined, now: number): boolean {
  return lastProgressAt != null && now - lastProgressAt > STALE_MS
}

/** "12s", "3m 04s": how long since a moment, for the stale note. */
export function fmtAgo(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** Blender's MB as "1.2 GB" / "840 MB". */
export function fmtMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`
}

/** Seconds as "0:44", "12:05", "1:02:05". */
export function fmtClock(s: number): string {
  const t = Math.max(0, Math.round(s))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const sec = String(t % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

/** Blender's status as short "label value" pairs; empty when it carries nothing. */
export function statusParts(rs: RenderStatus | null | undefined): Array<[string, string]> {
  if (!rs) return []
  const out: Array<[string, string]> = []
  if (rs.sample != null && rs.samples != null) out.push(['sample', `${rs.sample}/${rs.samples}`])
  if (rs.deviceMemMb != null && rs.deviceMemMb > 0) {
    out.push([
      'VRAM',
      rs.devicePeakMemMb != null && rs.devicePeakMemMb > rs.deviceMemMb
        ? `${fmtMb(rs.deviceMemMb)} (peak ${fmtMb(rs.devicePeakMemMb)})`
        : fmtMb(rs.deviceMemMb)
    ])
  }
  if (rs.memMb != null) {
    out.push([
      'mem',
      rs.peakMemMb != null && rs.peakMemMb > rs.memMb
        ? `${fmtMb(rs.memMb)} (peak ${fmtMb(rs.peakMemMb)})`
        : fmtMb(rs.memMb)
    ])
  }
  if (rs.elapsedS != null) out.push(['frame time', fmtClock(rs.elapsedS)])
  if (rs.remainingS != null) out.push(['left on frame', fmtClock(rs.remainingS)])
  return out
}

/** The phase in a word or two: "Sample 32/256" reads as "sampling", the rest as Blender says. */
export function phaseOf(rs: RenderStatus | null | undefined): string | null {
  if (!rs?.phase) return null
  if (/^sample\b/i.test(rs.phase)) return 'sampling'
  return rs.phase
}

export function nodeLabel(node: NodeSnapshot | undefined, nodeId: string): string {
  if (!node) return nodeId.slice(0, 8)
  const gpu = node.gpuName ?? 'node'
  return node.instanceId != null ? `${gpu} #${node.instanceId}` : `${gpu} ${nodeId.slice(0, 8)}`
}

/** "2 nodes working · 3 chunks active". */
export function describeLive(nodes: number, chunks: number): string {
  return (
    `${nodes} ${nodes === 1 ? 'node' : 'nodes'} working · ` +
    `${chunks} ${chunks === 1 ? 'chunk' : 'chunks'} active`
  )
}

// -- node sharing -------------------------------------------------------------

/**
 * What the node sharing switch does, in the scheduler's terms
 * (scheduler/admission.ts admits, scheduler/slotController.ts,
 * jobs.ts setJobShareNode).
 */
export const SHARE_COPY = {
  label: 'Share nodes with other jobs',
  off:
    'Off: each chunk has its node to itself (on a multi-GPU node, its own GPU), and nothing ' +
    'else renders beside it. Steady speed and the whole card’s memory.',
  on:
    'On: chunks may render side by side with other sharing jobs’ chunks on one node. The app ' +
    'keeps adding renders to a node while its frames per second keep rising, and backs off ' +
    'when memory runs short. Suits scenes whose frames wait on the CPU (loading, syncing); a ' +
    'scene that already fills the GPU gains nothing. Shared and unshared chunks never mix on a node.',
  applies:
    'Applies to chunks not yet started. Chunks already rendering keep their placement, so ' +
    'turning it off takes effect as the shared renders finish.'
} as const
