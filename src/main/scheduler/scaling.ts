/**
 * How many nodes to rent this tick.
 *
 * Scale-up used to be a yes/no question answered once per 15 s tick, renting
 * at most ONE node per tick — so a 30-node fleet spent 7.5 minutes just being
 * requested, before any of it had booted. It also ignored nodes still booting,
 * so while they booted the same pending chunks kept justifying another rental,
 * which only stopped at maxActiveNodes.
 *
 * Now the deficit is sized: pending work, minus free capacity on usable nodes,
 * minus the capacity already on its way in booting nodes, converted to nodes
 * and bounded by maxActiveNodes, a per-tick burst limit, and the spend cap
 * (which the renting loop re-checks per node, since an offer's price is only
 * known once it is picked).
 *
 * Pure, so the arithmetic is testable without a fleet.
 */

/** Rentals per tick. Big enough to ramp 30 nodes in ~1 minute, small enough that
 * one bad offer search cannot buy an entire fleet of the wrong thing at once. */
export const MAX_REQUESTS_PER_TICK = 8

export interface BootingNode {
  /** exclusive lanes it will offer once ready (see gpuLanes) */
  lanes: number
  /** shared slots it will start with */
  sharedSlots: number
}

export interface ScaleInput {
  pendingShared: number
  pendingExclusive: number
  /** free shared slots on usable nodes */
  sharedCapacity: number
  /** free exclusive lanes on usable nodes */
  exclusiveCapacity: number
  /** nodes rented but not yet usable (requested / provisioning) */
  booting: BootingNode[]
  /** expected exclusive lanes on a newly rented node (>= 1) */
  newNodeLanes: number
  /** expected shared slots on a newly rented node (>= 1) */
  newNodeSharedSlots: number
  /** buy-ahead mode: rent to the cap while any work remains */
  eager: boolean
  /** pending + in-flight chunks */
  workRemaining: number
  /** nodes counted against maxActiveNodes (booting included) */
  active: number
  maxActive: number
  /** current fleet $/hr (booting included) */
  perHour: number
  /** null = uncapped */
  spendCap: number | null
  /** startup-recovery hold: nothing is rented until the user resumes */
  held: boolean
  maxPerTick?: number
}

export function nodesToRequest(i: ScaleInput): number {
  if (i.held) return 0
  const room = i.maxActive - i.active
  if (room <= 0) return 0
  if (i.spendCap != null && i.perHour >= i.spendCap) return 0
  const burst = i.maxPerTick ?? MAX_REQUESTS_PER_TICK

  let want: number
  if (i.eager && i.workRemaining > 0) {
    want = room
  } else {
    const bootLanes = i.booting.reduce((a, b) => a + Math.max(1, b.lanes), 0)
    const bootShared = i.booting.reduce((a, b) => a + Math.max(1, b.sharedSlots), 0)
    const exclusiveDeficit = Math.max(0, i.pendingExclusive - i.exclusiveCapacity - bootLanes)
    const sharedDeficit = Math.max(0, i.pendingShared - i.sharedCapacity - bootShared)
    want =
      Math.ceil(exclusiveDeficit / Math.max(1, i.newNodeLanes)) +
      Math.ceil(sharedDeficit / Math.max(1, i.newNodeSharedSlots))
  }
  return Math.max(0, Math.min(want, room, burst))
}
