/**
 * What a node's state means for money and for work, decided once for main
 * and the renderer alike (plan 1.2; #64 #120 #168 #194).
 *
 * "Active" used to be defined in three ways, each an inline list of states:
 * nodeManager's activeCount, activePerHour and accrueCosts; scalePolicy's;
 * and the Fleet screen's and toolbar's. None of them counted a 'failed' node
 * whose destroy had thrown, which is exactly the node still billing. After
 * one Vast blip during an unattended idle scale-down, the caps, the meter,
 * History and the toolbar all skipped an instance that was still billing,
 * and the scheduler rented a replacement next to it.
 *
 * So billing is not read from the lifecycle state here. It is read from the
 * instance. A node may be billing, whatever its state says, while either:
 * - it holds an instance whose destroy nobody has confirmed, or
 * - a create for it is still out with no known result.
 *
 * Pure and free of Electron and the database, so both processes import it
 * and a test can pin every case.
 */

import type { CapacityBudget, NodeSnapshot, NodeState, SettingsPublic } from './models'

/**
 * The facts the billing predicates read. A NodeSnapshot has all of them.
 * Main can build one from a node row (`instance_id`, `destroyed_at`,
 * `create_unknown_since`) without building a whole snapshot.
 */
export type NodeFacts = Pick<NodeSnapshot, 'state' | 'instanceId'> &
  Partial<Pick<NodeSnapshot, 'destroyedAt' | 'createUnknownSince'>>

/** NodeFacts plus the rate, for summing what the fleet costs. */
export type NodeCostFacts = NodeFacts & Pick<NodeSnapshot, 'dphTotal'>

/**
 * A create for this node was sent and nobody knows what it did, so an
 * instance may exist under the node's label with its id unknown.
 *
 * Once the instance id is known, the result is known too: the reply, or
 * plan 1.4's label lookup, named the instance. Until then, one of two things
 * says the result is unknown:
 * - `createUnknownSince`, when set;
 * - a row still 'requested' with no instance id. That is a create in flight
 *   (the row is written before `PUT /asks`, and the id arrives with the
 *   reply), or one a crash cut short. This is also how a row from before the
 *   column existed is read.
 */
export function createOutcomeUnknown(n: NodeFacts): boolean {
  if (n.instanceId != null) return false
  return n.createUnknownSince != null || n.state === 'requested'
}

/**
 * The node may be billing: it holds an instance whose destroy has not been
 * confirmed, or a create for it has an unknown result. This is independent
 * of `state`. A 'failed' node whose destroy threw holds its instance, and so
 * does a 'destroyed' one whose destroy was never confirmed (a DELETE can
 * answer 200 and leave the instance running, #140). A node destroyed while
 * its create was in flight holds whatever that create made.
 *
 * Plan 1.2 counts every node for which this is true against the caps and
 * meters it, and plan 1.1's quit dialog offers to destroy it. A node's
 * instance is gone only once `destroyedAt` is set, and plan 1.2's
 * ensureInstanceGone is what sets it.
 */
export function holdsInstance(n: NodeFacts): boolean {
  if (n.instanceId != null) return n.destroyedAt == null
  return createOutcomeUnknown(n)
}

/**
 * Takes room under maxActiveNodes and the spend cap. This is every node that
 * may be billing: booting, working, being destroyed, or 'failed' with its
 * destroy unconfirmed. Leaving any of them out lets the scheduler rent a
 * replacement next to an instance that is still billing.
 *
 * It says the same as holdsInstance. It is a separate function so that a cap
 * check says what it means, and so that if the two ever differ, the
 * difference is made here and not at each call site.
 */
export function countsTowardCaps(n: NodeFacts): boolean {
  return holdsInstance(n)
}

const DISPATCHABLE: ReadonlySet<NodeState> = new Set<NodeState>(['ready', 'idle', 'rendering'])

/**
 * Work may be sent to the node: it is provisioned and has not been lost,
 * failed or destroyed. 'rendering' is included because a node below its slot
 * target can take more. Main also needs the node's SSH connection, which is
 * not part of the snapshot.
 */
export function isDispatchable(n: NodeFacts): boolean {
  return DISPATCHABLE.has(n.state) && holdsInstance(n)
}

/**
 * Rented and still coming up: capacity already on its way. scalePolicy counts
 * it so that pending work does not justify another rental on every tick of a
 * boot.
 */
export function isBooting(n: NodeFacts): boolean {
  return (n.state === 'requested' || n.state === 'provisioning') && holdsInstance(n)
}

/**
 * The scheduler has work in flight on the node. This comes from its runs
 * (`currentWork`, `slotsInUse`), not from `state`, which the scheduler sets
 * to 'rendering' and 'idle' by hand: a node can read 'rendering' with no run
 * behind it. Either count above zero means busy, so scale-down never takes a
 * node on which one of them still sees a run.
 */
export function isBusy(n: Pick<NodeSnapshot, 'currentWork' | 'slotsInUse'>): boolean {
  return n.currentWork.length > 0 || n.slotsInUse > 0
}

/**
 * The nodes counted against the caps, and what they cost per hour. This is
 * the fleet rate the toolbar, History and the quit dialog show.
 */
export function capUsage(nodes: readonly NodeCostFacts[]): { nodes: number; perHour: number } {
  let count = 0
  let perHour = 0
  for (const n of nodes) {
    if (!countsTowardCaps(n)) continue
    count++
    perHour += n.dphTotal ?? 0
  }
  return { nodes: count, perHour }
}

/**
 * How much more the fleet may rent under maxActiveNodes and the spend cap
 * (plan 1.5). The demand parts (`exclusiveLanes`, `sharedSlots`) are left
 * null for the scheduler to fill in.
 *
 * Only `noSpendCap` means no cap (plan 1.14). A cap that is missing, or not
 * a finite number, without that flag counts as $0/hr, so nothing is rented:
 * a cleared field or a hand-edited file is never read as "spend without
 * limit". Comparing against NaN would have allowed every rental. Main's
 * capHeadroom (scaling.ts) reads the cap the same way, and rounds the same
 * way, so the renderer's confirmation and main's check agree.
 */
export function capacityBudget(
  nodes: readonly NodeCostFacts[],
  settings: Pick<SettingsPublic, 'maxActiveNodes' | 'spendCapPerHour' | 'noSpendCap'>
): CapacityBudget {
  const usage = capUsage(nodes)
  const max = settings.maxActiveNodes
  const nodeRoom = Number.isFinite(max) ? Math.max(0, Math.floor(max) - usage.nodes) : 0
  let spendCap: number | null = null
  let headroomPerHour: number | null = null
  if (settings.noSpendCap !== true) {
    const cap = settings.spendCapPerHour
    spendCap = cap != null && Number.isFinite(cap) ? Math.max(0, cap) : 0
    headroomPerHour = roundDownToMicro(Math.max(0, spendCap - usage.perHour))
  }
  return {
    nodes: usage.nodes,
    maxNodes: max,
    nodeRoom,
    perHour: usage.perHour,
    spendCap,
    headroomPerHour,
    exclusiveLanes: null,
    sharedSlots: null
  }
}

/**
 * Rates are compared to a millionth of a dollar, rounded down, so float noise
 * neither invents headroom nor takes it away. Nodes at $0.10 and $0.20/hr sum
 * to 0.30000000000000004. Under a $0.50/hr cap the headroom then works out as
 * 0.19999999999999996, and an offer at $0.20/hr must still fit.
 */
function roundDownToMicro(dollars: number): number {
  return Math.floor(dollars * 1e6 + 1e-6) / 1e6
}

/**
 * One more node at `dphTotal` $/hr would stay within both caps. The check is
 * against the rate after the rental, not the rate before it: "under the cap
 * now" let a $1.95/hr fleet with a $2/hr cap rent an $8/hr box (A7). An
 * unknown or negative price never fits under a cap.
 */
export function fitsBudget(budget: CapacityBudget, dphTotal: number): boolean {
  if (budget.nodeRoom < 1) return false
  if (budget.headroomPerHour == null) return true
  if (!Number.isFinite(dphTotal) || dphTotal < 0) return false
  return dphTotal <= budget.headroomPerHour
}
