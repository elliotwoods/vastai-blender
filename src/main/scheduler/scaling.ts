/**
 * How much to rent this tick.
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
 * planScaling() (plan 1.5, 1.21) goes further, and replaces nodesToRequest:
 *
 * - It returns a CapacityBudget (shared/models.ts: node room, $/hr headroom,
 *   and the exclusive lanes and shared slots still wanted) instead of a node
 *   count. requestNodes subtracts each offer's real contribution as it rents
 *   (offerContribution, subtractRental) and stops once the demand is
 *   covered. A node count sized on the GPU-count filter and placeholder slot
 *   counts rented whatever ranked best, 8-GPU boxes included, for 1-lane
 *   demand (#227, #237).
 * - The spend cap is a budget, not a yes/no: the headroom goes to the offer
 *   search as maxDphTotal, and every rental spends from it. capHeadroom()
 *   and nodeState.capacityBudget() read the cap and round it the same way.
 * - It knows the tail. A new node takes ~10 min to boot and provision
 *   before its first frame. In job da68b61b every frame had landed except a
 *   1-frame requeue sub-chunk, sitting on a live node, and buy-ahead rented
 *   two more 8×4090s (~$8/h) for it. It never rents for work that a new node
 *   would do in less time than it takes to boot, or that the fleet already
 *   has finishes before a new node could arrive, and buy-ahead counts frames,
 *   not chunks.
 * - Any FleetHolds entry (account, local sink, recovery, scale backoff)
 *   stops it with the hold's reason, for scheduler:scaleStatus.
 *
 * Pure, so the arithmetic is testable without a fleet.
 */

import type { CapacityBudget, EngineId, FleetHolds, NodeMetrics } from '../../shared/models'
import { planLanes } from './gpuLanes'
import { hardCap, seedTarget } from './slotController'

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

/**
 * @deprecated Use planScaling(): this sizes by node count and ignores the
 * price of the node it rents (see capHeadroom) and the tail. Kept until the
 * scheduler's scalePolicy and requestNodes move to budgets (plan 1.5, 1.21).
 */
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

/**
 * $/hr the fleet may still add under the spend cap.
 *
 * The cap used to be tested against the fleet as it stood (`perHour <
 * cap`), so the offer about to be rented was never counted: with a $2/h cap
 * and $1.95/h running, the next rental could be any price, a multi-GPU box
 * at several times the cap included (#5, #16, #35, #65, #94, #144, #158).
 * requestNodes passes this to findOffers as maxDphTotal, so the search only
 * returns offers that fit, and re-checks each offer against what is left
 * before renting it (plan 1.5).
 *
 * @param perHourBillingNow $/hr of every node that may hold an instance,
 *   failed-but-holding and destroying ones included: an instance nobody has
 *   confirmed gone may still bill, so it still counts against the cap
 * @param cap the spend cap in $/hr
 * @param noCap the explicit "no cap" setting. Only that means uncapped: a
 *   missing, blank or nonsense cap without it rents nothing, so a cleared
 *   field is never read as "spend without limit" (plan 1.14)
 *
 * Rounded down to a millionth of a dollar, so float noise can neither invent
 * headroom nor turn $0.05 into $0.04999…
 */
export function capHeadroom(
  perHourBillingNow: number,
  cap: number | null | undefined,
  noCap = false
): number {
  if (noCap === true) return Number.POSITIVE_INFINITY
  if (cap == null || !Number.isFinite(cap) || cap <= 0) return 0
  // Unknown billing is not zero billing.
  if (!Number.isFinite(perHourBillingNow) || perHourBillingNow < 0) return 0
  const left = cap - perHourBillingNow
  if (!(left > 0)) return 0
  return Math.floor(left * 1e6 + 1e-6) / 1e6
}

// ---------------------------------------------------------------------------
// Capacity budgets (plan 1.5) and the tail (plan 1.21)
// ---------------------------------------------------------------------------

/** How long a newly rented node takes to boot and provision before its first frame. */
export const NEW_NODE_LEAD_MS = 10 * 60_000

export type ScaleStatus = 'rent' | 'held' | 'covered' | 'tail' | 'max-nodes' | 'spend-cap'

export interface ScalingPlan {
  status: ScaleStatus
  /** one line for scheduler:scaleStatus and logs: why the budget is what it is */
  reason: string
  /**
   * The caps it was given, with the demand this batch has to cover filled in
   * (exclusiveLanes, sharedSlots; 0 unless status is 'rent'). requestNodes
   * searches with maxDphTotal = headroomPerHour, rents while budgetOpen(),
   * checks each offer with nodeState.fitsBudget and spends the budget down
   * with subtractRental.
   */
  budget: CapacityBudget
  /** rentals this batch may make: the node room and the per-tick burst. 0 unless 'rent'. */
  maxRentals: number
  /**
   * The demand as a node count at the new-node estimate, at most maxRentals,
   * for a caller that still rents by count. 0 unless 'rent'.
   */
  nodes: number
}

export interface PlanScalingInput {
  /**
   * The fleet's caps: nodeState.capacityBudget(nodes, settings), which counts
   * every node that may still bill and reads the cap only as noSpendCap
   * allows. Its demand fields are ignored; planScaling fills them in.
   */
  cap: CapacityBudget
  /** every hold in force (fleet:holds); any one stops scale-up */
  holds: FleetHolds

  pendingShared: number
  pendingExclusive: number
  /** free shared slots on usable nodes */
  sharedCapacity: number
  /** free exclusive lanes on usable nodes */
  exclusiveCapacity: number
  /** nodes rented but not yet usable, at what each will bring (offerContribution) */
  booting: BootingNode[]
  /** expected exclusive lanes / shared slots on a newly rented node, for `nodes` */
  newNodeLanes: number
  newNodeSharedSlots: number

  /** usable (ready/idle/rendering) nodes */
  usableNodes: number
  /** all exclusive lanes on usable nodes, busy or free */
  usableLanes: number
  /** all shared-slot targets on usable nodes, busy or free */
  usableSharedSlots: number
  /**
   * Frames of the pending chunks not yet downloaded: the only work a new node
   * could be given. A frame already on this computer needs no node, so a
   * requeued chunk whose frames have all landed counts 0 here, however many
   * chunks it adds to pendingExclusive (job da68b61b).
   */
  pendingFrames: number
  /** frames not yet downloaded, pending or in flight, by kind of job */
  remainingExclusiveFrames: number
  remainingSharedFrames: number
  /** frames/hr the usable and booting fleet delivers; null = not learned yet */
  fleetFramesPerHour: number | null
  /** frames/hr a newly rented node would deliver (gpu_perf × GPUs); null = not learned */
  newNodeFramesPerHour: number | null
  /** boot + provision time of a new node; default NEW_NODE_LEAD_MS */
  newNodeLeadMs?: number

  /** buy-ahead: rent while frames outnumber the fleet's lanes and slots */
  eager: boolean
  /** the cheapest offer worth searching for: less headroom than this rents nothing */
  minOfferDph?: number
  maxPerTick?: number
}

const money = (v: number | null): string => (v == null ? 'uncapped' : `$${v.toFixed(2)}/h`)

function mins(ms: number): string {
  return `${Math.max(1, Math.round(ms / 60_000))} min`
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/** Each hold's reason, worded for scale status. */
function holdReasons(h: FleetHolds): string[] {
  const out: string[] = []
  if (h.account) out.push(h.account.reason)
  if (h.localSink) out.push(h.localSink.reason)
  if (h.recovery != null) {
    out.push(`${plural(h.recovery, 'chunk')} from the last session wait for you to resume`)
  }
  if (h.scale) out.push(h.scale.reason)
  return out
}

/** Scale-up for this tick: a capacity budget, or the reason there is none. */
export function planScaling(i: PlanScalingInput): ScalingPlan {
  const stop = (status: ScaleStatus, reason: string): ScalingPlan => ({
    status,
    reason,
    budget: { ...i.cap, exclusiveLanes: 0, sharedSlots: 0 },
    maxRentals: 0,
    nodes: 0
  })

  const held = holdReasons(i.holds)
  if (held.length > 0) return stop('held', `scale-up paused: ${held.join('; ')}`)

  // --- Demand, in lanes and slots. ---
  const bootLanes = i.booting.reduce((a, b) => a + Math.max(1, b.lanes), 0)
  const bootShared = i.booting.reduce((a, b) => a + Math.max(1, b.sharedSlots), 0)
  let exclusive: number
  let shared: number
  if (i.eager) {
    // Buy-ahead: frames against every lane and slot the fleet has or has on
    // the way, busy or not. A chunk cannot use more lanes than it has frames,
    // so a 1-frame remainder on a live 8-GPU node wants nothing.
    exclusive = Math.max(0, i.remainingExclusiveFrames - i.usableLanes - bootLanes)
    shared = Math.max(0, i.remainingSharedFrames - i.usableSharedSlots - bootShared)
  } else {
    exclusive = Math.max(0, i.pendingExclusive - i.exclusiveCapacity - bootLanes)
    shared = Math.max(0, i.pendingShared - i.sharedCapacity - bootShared)
  }
  if (exclusive === 0 && shared === 0) {
    return stop(
      'covered',
      i.eager
        ? 'the fleet has a lane or slot for every frame left'
        : 'free and booting capacity covers the queue'
    )
  }

  // --- No frames, no rent. ---
  // What a new node could be given: pending work, or for buy-ahead whatever
  // is left (buy-ahead exists for queues the fleet has already prefetched).
  // Zero frames is less than a boot at any rate, so this needs neither a
  // fleet nor a learned rate: after a restart, on a fresh install or on a new
  // GPU model, a pending chunk whose frames have all landed still rented a
  // node for nothing.
  const givable = i.eager ? i.remainingExclusiveFrames + i.remainingSharedFrames : i.pendingFrames
  if (!(givable > 0)) {
    return stop(
      'covered',
      i.eager
        ? 'no frames left to render'
        : 'no frames left to render: every frame of the pending chunks is downloaded'
    )
  }

  // --- The tail: never rent for work a new node could not get to in time. ---
  // Only with a fleet to do it: with no node at all, a single frame still
  // needs one rented.
  const lead = i.newNodeLeadMs ?? NEW_NODE_LEAD_MS
  if (i.usableNodes + i.booting.length > 0) {
    // Pending frames count whole, even those free lanes will take. That
    // overstates a new node's share, so this errs toward renting, as before:
    // the tail rules can only ever stop a rental, never add one.
    if (i.newNodeFramesPerHour != null && i.newNodeFramesPerHour > 0) {
      const workMs = (givable / i.newNodeFramesPerHour) * 3_600_000
      if (workMs < lead) {
        return stop(
          'tail',
          `${plural(givable, 'frame')} left for a new node is ~${mins(workMs)} of its work, less than the ~${mins(lead)} it takes to boot`
        )
      }
    }
    const remaining = i.remainingExclusiveFrames + i.remainingSharedFrames
    if (i.fleetFramesPerHour != null && i.fleetFramesPerHour > 0) {
      const finishMs = (remaining / i.fleetFramesPerHour) * 3_600_000
      if (finishMs <= lead) {
        return stop(
          'tail',
          `the fleet finishes the last ${plural(remaining, 'frame')} in ~${mins(finishMs)}, before a new node could boot (~${mins(lead)})`
        )
      }
    }
  }

  // --- Limits. ---
  if (!(i.cap.nodeRoom >= 1)) {
    return stop('max-nodes', `at max nodes (${i.cap.nodes} of ${i.cap.maxNodes})`)
  }
  const headroom = i.cap.headroomPerHour
  const minOffer = Math.max(0, i.minOfferDph ?? 0)
  if (headroom != null && (!(headroom > 0) || headroom < minOffer)) {
    if (!(i.cap.spendCap != null && i.cap.spendCap > 0)) {
      return stop('spend-cap', 'no spend cap is set, and "no cap" is off: nothing is rented')
    }
    return stop(
      'spend-cap',
      `spend cap: ${money(i.cap.perHour)} of ${money(i.cap.spendCap)} in use leaves ${money(headroom)}` +
        (headroom > 0 ? `, less than the cheapest offer (${money(minOffer)})` : '')
    )
  }

  const maxRentals = Math.max(0, Math.min(i.cap.nodeRoom, i.maxPerTick ?? MAX_REQUESTS_PER_TICK))
  const nodes = Math.min(
    maxRentals,
    Math.ceil(exclusive / Math.max(1, i.newNodeLanes)) +
      Math.ceil(shared / Math.max(1, i.newNodeSharedSlots))
  )
  const want = [
    exclusive > 0 ? plural(exclusive, 'exclusive lane') : null,
    shared > 0 ? plural(shared, 'shared slot') : null
  ].filter((x): x is string => x != null)
  return {
    status: 'rent',
    reason: `short ${want.join(' and ')}: up to ${plural(maxRentals, 'rental')} within ${money(headroom)}`,
    budget: { ...i.cap, exclusiveLanes: exclusive, sharedSlots: shared },
    maxRentals,
    nodes
  }
}

/** What one rented node adds to the fleet. */
export interface RentalContribution {
  lanes: number
  sharedSlots: number
}

/** The offer fields capacity is estimated from (shared Offer, or a booting node's row). */
export interface OfferShape {
  numGpus: number
  gpuRamGb?: number | null
  cpuCoresEffective?: number | null
}

/**
 * The hardware ceiling an offer will have, from what the offer lists: the
 * same hardCap the node gets once metrics arrive, fed its CPUs and total
 * VRAM. RAM is not listed, so it does not bound the estimate.
 */
export function offerCap(offer: OfferShape, maxNodeSlots: number): number {
  const gpus = Math.max(1, Math.floor(offer.numGpus || 1))
  const listed: NodeMetrics = {
    gpuUtil: 0,
    vramUsedGb: 0,
    vramTotalGb: Math.max(0, (offer.gpuRamGb ?? 0) * gpus),
    gpuTemp: 0,
    powerW: 0,
    powerLimitW: 0,
    cpuUtil: 0,
    cpuLoad1: 0,
    cpuCores: Math.max(0, offer.cpuCoresEffective ?? 0),
    ramUsedGb: 0,
    ramTotalGb: 0,
    updatedAt: 0
  }
  return hardCap(listed, Math.max(0, maxNodeSlots))
}

/**
 * What renting this offer brings: its GPU lanes (planLanes on the offer's own
 * GPU count, not the filter's floor) and the shared slots it will start at
 * (the learned per-GPU optimum × its GPUs, as initialState seeds it). Use the
 * same estimate for booting nodes.
 */
export function offerContribution(
  offer: OfferShape,
  o: {
    slotsPerGpu: number
    maxNodeSlots: number
    /** gpu_slots.best_slots for the offer's model; null = nothing learned */
    learnedSlotsPerGpu?: number | null
    /** the engine of the work it is rented for; EEVEE and Octane get one lane */
    engine?: EngineId | null
  }
): RentalContribution {
  const cap = offerCap(offer, o.maxNodeSlots)
  const plan = planLanes(offer.numGpus, o.slotsPerGpu, cap, o.engine)
  const sharedSlots = seedTarget(o.learnedSlotsPerGpu ?? null, cap, {
    numGpus: offer.numGpus,
    floor: plan.pin ? plan.lanes : 1
  })
  return { lanes: plan.lanes, sharedSlots }
}

/** Rounded down to a millionth of a dollar, never below zero (as capHeadroom). */
const microDown = (v: number): number => Math.max(0, Math.floor(v * 1e6 + 1e-6) / 1e6)

/**
 * The budget after renting `offer`: one node more, its price spent from the
 * headroom, and what it brings taken off the demand. A node serves exclusive
 * or shared work, not both at once, so it covers exclusive lanes first and
 * shared slots only once no exclusive demand is left, the way nodesToRequest
 * added the two. Demand that is null (a manual request) stays null.
 */
export function subtractRental(
  budget: CapacityBudget,
  offer: { dphTotal: number },
  c: RentalContribution
): CapacityBudget {
  // An unpriced offer spends all the headroom: it should never have been rented.
  const price = Number.isFinite(offer.dphTotal) ? Math.max(0, offer.dphTotal) : Infinity
  const next: CapacityBudget = {
    ...budget,
    nodes: budget.nodes + 1,
    nodeRoom: Math.max(0, budget.nodeRoom - 1),
    perHour: budget.perHour + (Number.isFinite(price) ? price : 0)
  }
  if (budget.headroomPerHour != null) {
    const left = budget.headroomPerHour - price
    next.headroomPerHour = Number.isFinite(left) ? microDown(left) : 0
  }
  if (budget.exclusiveLanes != null && budget.exclusiveLanes > 0) {
    next.exclusiveLanes = Math.max(0, budget.exclusiveLanes - c.lanes)
  } else if (budget.sharedSlots != null) {
    next.sharedSlots = Math.max(0, budget.sharedSlots - c.sharedSlots)
  }
  return next
}

/**
 * Is there still room, money and demand left in the budget? Demand that is
 * null on both counts means the batch is not limited by it (a manual
 * request): room and money decide.
 */
export function budgetOpen(b: CapacityBudget): boolean {
  if (!(b.nodeRoom >= 1)) return false
  if (b.headroomPerHour != null && !(b.headroomPerHour > 0)) return false
  const ex = b.exclusiveLanes ?? null
  const sh = b.sharedSlots ?? null
  if (ex == null && sh == null) return true
  return (ex ?? 0) > 0 || (sh ?? 0) > 0
}
