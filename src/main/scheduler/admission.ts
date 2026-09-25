/**
 * Who may run where — the rules deciding whether a pending chunk can be
 * dispatched to a given node, and, once an attempt has failed, what that
 * costs and when the chunk and its node may be tried again (plan 1.17).
 *
 * Pure and dependency-free so the interesting cases (exclusive chunks,
 * reservations, prefetch depth, retry budgets) are testable without SQLite,
 * SSH or a fleet. The scheduler supplies the occupancy; this decides.
 */

import type { ErrorClass } from '../../shared/models'

/**
 * Extra specs queued on a node beyond its render slots. The agent claims from
 * a filesystem inbox, so keeping a couple of specs waiting there means a slot
 * that frees up starts the next chunk immediately instead of idling until the
 * next scheduler tick. Shared work only — an exclusive chunk is never
 * prefetched, since it must find the node empty anyway.
 */
export const PREFETCH = 2

export interface NodeOccupancy {
  /** chunks in flight on the node (rendering, encoding, downloading, prefetched) */
  inFlight: number
  /** true when one of them is an exclusive chunk, which locks the whole node */
  hasExclusive: boolean
  /** chunk this node is being drained for, or null */
  reservedFor: string | null
  /** the auto-judged concurrent-render target (see slotController) */
  slotTarget: number
  /**
   * How many EXCLUSIVE chunks the node may run side by side — its GPU lanes
   * (see gpuLanes). Absent/1 = the historical rule: an exclusive chunk holds
   * the whole node. On a 4-GPU node with per-GPU slots it is 4: exclusivity is
   * per GPU, and exclusive chunks still never mix with shared ones.
   */
  exclusiveLanes?: number
}

export interface Candidate {
  id: string
  /** the job's shareNode flag */
  sharesNode: boolean
}

/** Maximum in-flight chunks for shared work, including the prefetch tail. */
export function nodeCapacity(slotTarget: number): number {
  return slotTarget > 1 ? slotTarget + PREFETCH : 1
}

function lanesOf(occ: NodeOccupancy): number {
  return Math.max(1, Math.floor(occ.exclusiveLanes ?? 1))
}

/**
 * May this node take this chunk right now?
 *
 * - A node holding exclusive chunks takes only more exclusive chunks, and only
 *   while it has a free GPU lane (one lane = the whole node, as before, unless
 *   per-GPU slots give it more).
 * - A node reserved for a waiting exclusive chunk takes only that chunk.
 * - An exclusive chunk otherwise needs a completely empty node.
 * - A shared chunk fits while the node is below its target + prefetch.
 */
export function admits(occ: NodeOccupancy, chunk: Candidate): boolean {
  if (occ.reservedFor != null && occ.reservedFor !== chunk.id) return false
  if (occ.hasExclusive) return !chunk.sharesNode && occ.inFlight < lanesOf(occ)
  if (!chunk.sharesNode) return occ.inFlight === 0
  return occ.inFlight < nodeCapacity(occ.slotTarget)
}

/** Does this node have room for anything at all? Cheap pre-filter for the loop. */
export function hasRoom(occ: NodeOccupancy): boolean {
  // Reservations are checked per chunk in admits(); a reserved lane node still
  // has room for the chunk it is reserved for.
  if (occ.hasExclusive) return occ.inFlight < lanesOf(occ)
  if (occ.reservedFor != null) return occ.inFlight === 0
  return occ.inFlight === 0 || occ.inFlight < nodeCapacity(occ.slotTarget)
}

/**
 * Free exclusive lanes on a node: what scale-up counts as room for pending
 * exclusive chunks. A node running shared work has none — an exclusive chunk
 * needs it drained first.
 */
export function freeExclusiveLanes(occ: NodeOccupancy): number {
  if (occ.hasExclusive) return Math.max(0, lanesOf(occ) - occ.inFlight)
  return occ.inFlight === 0 ? lanesOf(occ) : 0
}

// ---------------------------------------------------------------------------
// When a chunk that failed may run again, and where (plan 1.17)
//
// One retry budget used to cover every failure, so a node that could not be
// reached spent the render's chances: job 1d59516c's balance hit $0, Vast
// stopped two of its three nodes, and 16 chunks burned all their retries on
// them in minutes, each with an empty reason, instead of moving to the node
// that still worked. What a failure costs now depends on whose fault it is
// (errors.ts classify), and a node that fails a dispatch is rested before it
// is sent more.

/**
 * Which budget a failed attempt is charged to.
 * - render: `chunks.retries`, the render's own chances (MAX_RETRIES). The
 *   scene or Blender failed, which another node may not fix.
 * - infra: `chunks.infra_retries`. The machine, the network or Vast failed,
 *   not the render; a larger budget, and a chunk never loses a render
 *   chance to a node that died under it.
 * - none: this computer held the frames back (its disk would not take them).
 *   The render was fine, and nothing is sent again until the disk is.
 */
export type RetryBudget = 'render' | 'infra' | 'none'

/** A classification as far as the retry policy reads one (errors.ts Classification). */
export interface FailureClass {
  kind: ErrorClass
  rule: string
  /** the error in words; the breaker reads a setup step's exit code from it */
  reason?: string
}

export function budgetFor(c: FailureClass): RetryBudget {
  if (c.kind === 'job') return 'render'
  if (c.rule === 'local-sink') return 'none'
  return 'infra'
}

/** First wait after a transient failure; each further one doubles it. */
export const RETRY_BACKOFF_BASE_MS = 15_000
/** First rest for a node after a failed dispatch; each further one doubles it. */
export const NODE_REST_BASE_MS = 30_000
/** The longest either waits. */
export const RETRY_BACKOFF_MAX_MS = 10 * 60_000

function doubling(base: number, n: number): number {
  return Math.min(RETRY_BACKOFF_MAX_MS, base * 2 ** Math.max(0, Math.min(20, n - 1)))
}

/**
 * How long a chunk waits before it is dispatched again (chunks.not_before),
 * after the failure that brought its infra_retries to `infraRetries`.
 *
 * Only a transient failure waits: the same node or network may answer in a
 * moment, and sending it again at once only spends another attempt. A
 * machine's failure moves the chunk elsewhere at once; that node rests
 * instead (nodeRestMs). A render failure is sent again at once, as always.
 */
export function chunkBackoffMs(c: FailureClass, infraRetries: number): number {
  if (budgetFor(c) !== 'infra' || c.kind === 'machine') return 0
  return doubling(RETRY_BACKOFF_BASE_MS, infraRetries)
}

/**
 * How long a node is sent nothing new after its `failures`-th failed
 * dispatch in a row. A stopped instance refuses in milliseconds, so without
 * a rest it took the next chunk, and the next, as fast as they came back.
 */
export function nodeRestMs(failures: number): number {
  return doubling(NODE_REST_BASE_MS, failures)
}

/**
 * The job breaker's name for a failure that may be the job's own rather than
 * a machine's, or null for one that cannot be: a node gone, the network, a
 * GPU that fell off. The same name on BREAKER_NODES nodes holds the job.
 * - job: the render failed (a crash, a guard, an error nothing recognises).
 * - node-setup: installing the job's Blender, add-ons or Octane failed. One
 *   node failing it is a flaky mirror or disk; two is a version no mirror
 *   has, or an add-on that will not enable anywhere. Not a step that ended
 *   with no exit code at all ("failed (exit null)"): its connection went,
 *   which says nothing about the job, and two nodes Vast stopped at once
 *   would otherwise hold it.
 * - localFs: this computer could not read what the job sends (its scene
 *   gone or unreadable). Its disk is the same whichever node is asking, so
 *   two failures hold the job, on one node or several.
 */
export function breakerKey(c: FailureClass): string | null {
  if (c.kind === 'job') return 'job'
  if (c.rule === 'node-setup') return /\(exit null\)/.test(c.reason ?? '') ? null : 'node-setup'
  if (c.kind === 'localFs' && c.rule !== 'local-sink') return 'localFs'
  return null
}

/** Distinct nodes one failure must be seen on before it is taken as the job's. */
export const BREAKER_NODES = 2

/**
 * Per job: the breaker keys seen since the job last rendered a chunk, and on
 * which nodes. A chunk that renders resets its job's count: a scene that
 * cannot render fails every attempt, while a Blender that crashes once in a
 * while does so between chunks that finish. The count lives only as long as
 * the process: after a restart the breaker starts again, and the render and
 * infrastructure budgets still bound every chunk.
 */
export class JobBreaker {
  private seen = new Map<string, Map<string, { nodes: Set<string>; count: number }>>()

  /** Note a failure; true when it is the one that trips the breaker for this key. */
  record(jobId: string, key: string, nodeId: string): boolean {
    let byKey = this.seen.get(jobId)
    if (!byKey) {
      byKey = new Map()
      this.seen.set(jobId, byKey)
    }
    const entry = byKey.get(key) ?? { nodes: new Set<string>(), count: 0 }
    byKey.set(key, entry)
    const wasTripped = this.tripped(key, entry)
    entry.nodes.add(nodeId)
    entry.count += 1
    return !wasTripped && this.tripped(key, entry)
  }

  /** The nodes a key has been seen on for a job since it last rendered. */
  nodesFor(jobId: string, key: string): string[] {
    return [...(this.seen.get(jobId)?.get(key)?.nodes ?? [])]
  }

  /** The job rendered a chunk, or the user resumed it: start counting again. */
  reset(jobId: string): void {
    this.seen.delete(jobId)
  }

  private tripped(key: string, e: { nodes: Set<string>; count: number }): boolean {
    return key === 'localFs' ? e.count >= BREAKER_NODES : e.nodes.size >= BREAKER_NODES
  }
}
