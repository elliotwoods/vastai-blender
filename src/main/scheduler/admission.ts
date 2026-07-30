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

/**
 * May this node take this chunk right now?
 *
 * - A node holding an exclusive chunk takes nothing else until it finishes.
 * - A node reserved for a waiting exclusive chunk takes only that chunk.
 * - An exclusive chunk needs a completely empty node.
 * - A shared chunk fits while the node is below its target + prefetch.
 */
export function admits(occ: NodeOccupancy, chunk: Candidate): boolean {
  if (occ.hasExclusive) return false
  if (occ.reservedFor != null && occ.reservedFor !== chunk.id) return false
  if (!chunk.sharesNode) return occ.inFlight === 0
  return occ.inFlight < nodeCapacity(occ.slotTarget)
}

/** Does this node have room for anything at all? Cheap pre-filter for the loop. */
export function hasRoom(occ: NodeOccupancy): boolean {
  if (occ.hasExclusive) return false
  if (occ.reservedFor != null) return occ.inFlight === 0
  return occ.inFlight === 0 || occ.inFlight < nodeCapacity(occ.slotTarget)
}
