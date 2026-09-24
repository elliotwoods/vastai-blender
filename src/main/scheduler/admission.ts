/**
 * Who may run where — the rules deciding whether a pending chunk can be
 * dispatched to a given node.
 *
 * Pure and dependency-free so the interesting cases (exclusive chunks,
 * reservations, prefetch depth) are testable without SQLite, SSH or a fleet.
 * The scheduler supplies the occupancy; this decides.
 */

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
