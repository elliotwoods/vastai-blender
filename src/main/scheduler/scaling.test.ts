import { describe, expect, it, vi } from 'vitest'
import {
  budgetOpen,
  capHeadroom,
  MAX_REQUESTS_PER_TICK,
  nodesToRequest,
  offerCap,
  offerContribution,
  offerFits,
  planScaling,
  subtractRental,
  type CapacityBudget,
  type PlanScalingInput,
  type ScaleInput
} from './scaling'

// scaling → gpuLanes/slotController → db.ts (electron). The policy is pure;
// nothing here reads the database.
vi.mock('../db/db', () => ({ getDb: () => ({ prepare: () => ({ get: () => undefined }) }) }))

const input = (i: Partial<ScaleInput> = {}): ScaleInput => ({
  pendingShared: 0,
  pendingExclusive: 0,
  sharedCapacity: 0,
  exclusiveCapacity: 0,
  booting: [],
  newNodeLanes: 1,
  newNodeSharedSlots: 2,
  eager: false,
  workRemaining: 0,
  active: 0,
  maxActive: 30,
  perHour: 0,
  spendCap: null,
  held: false,
  ...i
})

describe('nodesToRequest', () => {
  it('rents several nodes in one tick for a big queue', () => {
    expect(nodesToRequest(input({ pendingExclusive: 90 }))).toBe(MAX_REQUESTS_PER_TICK)
  })

  it('ramps a 30-node fleet in a handful of ticks, not 30', () => {
    let active = 0
    let ticks = 0
    while (active < 30 && ticks < 100) {
      active += nodesToRequest(input({ pendingExclusive: 90, active, booting: [] }))
      ticks++
    }
    expect(active).toBe(30)
    expect(ticks).toBeLessThanOrEqual(4)
  })

  it('counts capacity already booting', () => {
    const booting = [
      { lanes: 1, sharedSlots: 2 },
      { lanes: 1, sharedSlots: 2 }
    ]
    expect(nodesToRequest(input({ pendingExclusive: 3, booting, active: 2 }))).toBe(1)
    expect(nodesToRequest(input({ pendingExclusive: 2, booting, active: 2 }))).toBe(0)
  })

  it('sizes exclusive demand in GPU lanes', () => {
    // 4-GPU nodes: 9 pending exclusive chunks need 3 nodes, not 9.
    expect(nodesToRequest(input({ pendingExclusive: 9, newNodeLanes: 4 }))).toBe(3)
  })

  it('subtracts free capacity on ready nodes', () => {
    expect(nodesToRequest(input({ pendingExclusive: 4, exclusiveCapacity: 4 }))).toBe(0)
    expect(nodesToRequest(input({ pendingShared: 5, sharedCapacity: 1 }))).toBe(2)
  })

  it('never exceeds maxActiveNodes', () => {
    expect(nodesToRequest(input({ pendingExclusive: 90, active: 27 }))).toBe(3)
    expect(nodesToRequest(input({ pendingExclusive: 90, active: 30 }))).toBe(0)
  })

  it('rents nothing at or over the spend cap', () => {
    expect(nodesToRequest(input({ pendingExclusive: 9, perHour: 2, spendCap: 2 }))).toBe(0)
    expect(nodesToRequest(input({ pendingExclusive: 9, perHour: 1, spendCap: 2 }))).toBe(8)
  })

  it('rents nothing while startup recovery is held', () => {
    expect(nodesToRequest(input({ pendingExclusive: 9, held: true }))).toBe(0)
  })

  it('eager mode fills to the cap while work remains', () => {
    expect(nodesToRequest(input({ eager: true, workRemaining: 1, active: 26 }))).toBe(4)
    expect(nodesToRequest(input({ eager: true, workRemaining: 0 }))).toBe(0)
  })
})

describe('capHeadroom (plan 1.5)', () => {
  it('is what is left under the cap, so the search only returns offers that fit', () => {
    // The field shape: a $2/h cap with $1.95/h running left the next rental
    // unbounded. Now the search is told $0.05.
    expect(capHeadroom(1.95, 2)).toBe(0.05)
    expect(capHeadroom(0, 2)).toBe(2)
    expect(capHeadroom(1.9, 2)).toBe(0.1)
  })

  it('is zero at or over the cap', () => {
    expect(capHeadroom(2, 2)).toBe(0)
    expect(capHeadroom(3.4, 2)).toBe(0)
  })

  it('counts every node that may still bill: the caller passes failed-but-holding ones', () => {
    // 1.50 live + 0.45 on a node whose destroy failed.
    expect(capHeadroom(1.5 + 0.45, 2)).toBe(0.05)
  })

  it('is unbounded only with the explicit no-cap flag', () => {
    expect(capHeadroom(50, null, true)).toBe(Number.POSITIVE_INFINITY)
    expect(capHeadroom(50, 2, true)).toBe(Number.POSITIVE_INFINITY)
    // A cleared field is not "no limit".
    expect(capHeadroom(0, null)).toBe(0)
    expect(capHeadroom(0, undefined)).toBe(0)
    expect(capHeadroom(0, Number.NaN)).toBe(0)
    expect(capHeadroom(0, -1)).toBe(0)
  })

  it('treats unknown billing as no headroom', () => {
    expect(capHeadroom(Number.NaN, 2)).toBe(0)
    expect(capHeadroom(-1, 2)).toBe(0)
  })

  it('never rounds headroom up', () => {
    expect(capHeadroom(0.1 + 0.2, 0.5)).toBe(0.2)
    expect(capHeadroom(1.9999999, 2)).toBe(0)
  })
})

/** No nodes, nothing queued, no cap, no holds, nothing learned. */
const plan = (i: Partial<PlanScalingInput> = {}): PlanScalingInput => ({
  pendingShared: 0,
  pendingExclusive: 0,
  sharedCapacity: 0,
  exclusiveCapacity: 0,
  booting: [],
  newNodeLanes: 1,
  newNodeSharedSlots: 2,
  usableNodes: 0,
  usableLanes: 0,
  usableSharedSlots: 0,
  pendingFrames: 0,
  remainingExclusiveFrames: 0,
  remainingSharedFrames: 0,
  fleetFramesPerHour: null,
  newNodeFramesPerHour: null,
  eager: false,
  active: 0,
  maxActive: 30,
  perHourBilling: 0,
  spendCap: null,
  noCap: true,
  holds: [],
  ...i
})

/** One live 8×4090 node, every lane busy, rendering at 8 × 60 frames/hour. */
const oneBusy8x4090: Partial<PlanScalingInput> = {
  usableNodes: 1,
  usableLanes: 8,
  exclusiveCapacity: 0,
  active: 1,
  perHourBilling: 4,
  fleetFramesPerHour: 480,
  newNodeFramesPerHour: 480,
  newNodeLanes: 8
}

describe('planScaling: no work, no rent (plan 1.21, job da68b61b)', () => {
  it('buy-ahead rents nothing for the last frame, sitting on a live node', () => {
    // Every frame had landed but one 1-frame requeue sub-chunk, assigned to a
    // live 8×4090; buy-ahead rented two more 8×4090s (~$8/h) for it.
    const p = planScaling(
      plan({
        ...oneBusy8x4090,
        eager: true,
        pendingExclusive: 0,
        pendingFrames: 0,
        remainingExclusiveFrames: 1
      })
    )
    expect(p.status).not.toBe('rent')
    expect(p.nodes).toBe(0)
    expect(budgetOpen(p.budget)).toBe(false)
  })

  it('...and nothing without a learned rate either: buy-ahead counts frames, not chunks', () => {
    const p = planScaling(
      plan({
        ...oneBusy8x4090,
        fleetFramesPerHour: null,
        newNodeFramesPerHour: null,
        eager: true,
        remainingExclusiveFrames: 1
      })
    )
    expect(p.status).toBe('covered')
  })

  it('1 frame left with 1 live node → no rent, even when it waits for a lane', () => {
    const p = planScaling(
      plan({
        ...oneBusy8x4090,
        fleetFramesPerHour: 60,
        newNodeFramesPerHour: 60,
        pendingExclusive: 1,
        pendingFrames: 1,
        remainingExclusiveFrames: 2000 // the busy lanes have hours left
      })
    )
    expect(p.status).toBe('tail')
    expect(p.reason).toMatch(/1 frame left/)
    expect(p.nodes).toBe(0)
  })

  it('does not rent when the fleet finishes everything before a new node could boot', () => {
    // 50 frames left, 480 frames/hour: done in ~6 minutes.
    const p = planScaling(
      plan({
        ...oneBusy8x4090,
        newNodeFramesPerHour: 30, // a slow new node would still have 50 frames of work
        pendingExclusive: 6,
        pendingFrames: 50,
        remainingExclusiveFrames: 50
      })
    )
    expect(p.status).toBe('tail')
    expect(p.reason).toMatch(/before a new node could boot/)
  })

  it('still rents for real work that outlasts a boot', () => {
    const p = planScaling(
      plan({
        ...oneBusy8x4090,
        pendingExclusive: 40,
        pendingFrames: 4000,
        remainingExclusiveFrames: 5000
      })
    )
    expect(p.status).toBe('rent')
    expect(p.budget.exclusiveLanes).toBe(40)
    expect(p.nodes).toBe(5) // 40 lanes at 8 per new node
  })

  it('always rents one node for work when there is no fleet at all', () => {
    const p = planScaling(
      plan({
        pendingExclusive: 1,
        pendingFrames: 1,
        remainingExclusiveFrames: 1,
        newNodeFramesPerHour: 480,
        fleetFramesPerHour: 0
      })
    )
    expect(p.status).toBe('rent')
    expect(p.nodes).toBe(1)
  })

  it('takes the tail rules only on a learned rate, falling back to lane demand', () => {
    const p = planScaling(
      plan({
        ...oneBusy8x4090,
        fleetFramesPerHour: null,
        newNodeFramesPerHour: null,
        pendingExclusive: 1,
        pendingFrames: 1,
        remainingExclusiveFrames: 2000
      })
    )
    expect(p.status).toBe('rent')
  })

  it('buy-ahead still widens a long drain the fleet has prefetched', () => {
    const p = planScaling(
      plan({
        ...oneBusy8x4090,
        eager: true,
        pendingExclusive: 0,
        pendingFrames: 0,
        remainingExclusiveFrames: 3000
      })
    )
    expect(p.status).toBe('rent')
    expect(p.budget.exclusiveLanes).toBe(3000 - 8)
  })
})

describe('planScaling: holds and limits', () => {
  const big: Partial<PlanScalingInput> = {
    pendingExclusive: 20,
    pendingFrames: 2000,
    remainingExclusiveFrames: 2000
  }

  it('an account hold stops scale-up and says why (plan 1.20)', () => {
    const p = planScaling(
      plan({
        ...big,
        holds: [{ kind: 'account', reason: 'Vast balance $0.12, fleet paused, top up' }]
      })
    )
    expect(p.status).toBe('held')
    expect(p.reason).toMatch(/Vast balance \$0\.12/)
    expect(p.budget).toEqual({ exclusiveLanes: 0, sharedSlots: 0, maxDphTotal: 0, maxNodes: 0 })
  })

  it('names every hold at once', () => {
    const p = planScaling(
      plan({
        ...big,
        holds: [
          { kind: 'local-sink', reason: 'output disk full' },
          { kind: 'recovery', reason: 'waiting for you to resume after a restart' }
        ]
      })
    )
    expect(p.reason).toMatch(/output disk full; waiting for you/)
  })

  it('$0.05 of headroom is a $0.05 budget, not a yes (plan 1.5)', () => {
    const p = planScaling(plan({ ...big, perHourBilling: 1.95, spendCap: 2, noCap: false }))
    expect(p.status).toBe('rent')
    expect(p.budget.maxDphTotal).toBe(0.05)
  })

  it('rents nothing when headroom is below the cheapest offer, rather than search in vain', () => {
    const p = planScaling(
      plan({ ...big, perHourBilling: 1.97, spendCap: 2, noCap: false, minOfferDph: 0.05 })
    )
    expect(p.status).toBe('spend-cap')
    expect(p.reason).toMatch(/cheapest offer/)
  })

  it('counts nodes that may still bill against the cap', () => {
    const p = planScaling(plan({ ...big, perHourBilling: 2.3, spendCap: 2, noCap: false }))
    expect(p.status).toBe('spend-cap')
  })

  it('a blank cap without the no-cap flag rents nothing', () => {
    const p = planScaling(plan({ ...big, spendCap: null, noCap: false }))
    expect(p.status).toBe('spend-cap')
  })

  it('stops at max nodes and bounds a batch by room and the per-tick burst', () => {
    expect(planScaling(plan({ ...big, active: 30 })).status).toBe('max-nodes')
    expect(planScaling(plan({ ...big, active: 27 })).budget.maxNodes).toBe(3)
    expect(planScaling(plan({ ...big })).budget.maxNodes).toBe(MAX_REQUESTS_PER_TICK)
  })

  it('reports covered demand as covered, not as a limit', () => {
    const p = planScaling(plan({ pendingExclusive: 4, exclusiveCapacity: 4, active: 30 }))
    expect(p.status).toBe('covered')
  })

  it('agrees with nodesToRequest on the node count where both apply', () => {
    const cases: Array<Partial<ScaleInput & PlanScalingInput>> = [
      { pendingExclusive: 90 },
      { pendingExclusive: 9, newNodeLanes: 4 },
      { pendingShared: 5, sharedCapacity: 1 },
      { pendingExclusive: 3, booting: [{ lanes: 1, sharedSlots: 2 }], active: 1 }
    ]
    for (const c of cases) {
      const frames = (c.pendingExclusive ?? 0) + (c.pendingShared ?? 0)
      const p = planScaling(plan({ ...c, pendingFrames: frames }))
      expect(p.nodes).toBe(nodesToRequest(input(c)))
    }
  })
})

describe('capacity budgets: rent what the offers bring (#227, #237)', () => {
  it("sizes an offer by its own GPUs and hardware, not the filter's floor", () => {
    const eight4090 = { numGpus: 8, gpuRamGb: 24, cpuCoresEffective: 128 }
    expect(offerContribution(eight4090, { slotsPerGpu: 1, maxNodeSlots: 0 }).lanes).toBe(8)
    // A box with few CPUs for its GPUs cannot fit a lane per GPU: one process.
    const starved = { numGpus: 8, gpuRamGb: 24, cpuCoresEffective: 8 }
    expect(offerCap(starved, 0)).toBe(4)
    expect(offerContribution(starved, { slotsPerGpu: 1, maxNodeSlots: 0 }).lanes).toBe(1)
    // EEVEE work gets the whole node as one lane.
    expect(
      offerContribution(eight4090, { slotsPerGpu: 1, maxNodeSlots: 0, engine: 'eevee' }).lanes
    ).toBe(1)
  })

  it('counts the shared slots a node will really start with', () => {
    const four = { numGpus: 4, gpuRamGb: 24, cpuCoresEffective: 64 }
    // Learned 3 per GPU → seeds 12, as initialState would.
    expect(
      offerContribution(four, { slotsPerGpu: 1, maxNodeSlots: 0, learnedSlotsPerGpu: 3 })
        .sharedSlots
    ).toBe(12)
    // Nothing learned: 2, floored at one per pinned lane.
    expect(offerContribution(four, { slotsPerGpu: 1, maxNodeSlots: 0 }).sharedSlots).toBe(4)
    expect(
      offerContribution(
        { numGpus: 1, gpuRamGb: 24, cpuCoresEffective: 16 },
        {
          slotsPerGpu: 1,
          maxNodeSlots: 0
        }
      ).sharedSlots
    ).toBe(2)
  })

  it('stops a batch once the demand is covered: one 8-GPU box for 8 lanes, not 8 boxes', () => {
    let budget: CapacityBudget = planScaling(
      plan({ pendingExclusive: 8, pendingFrames: 800, remainingExclusiveFrames: 800 })
    ).budget
    expect(budget.maxNodes).toBe(8)
    const offer = { numGpus: 8, gpuRamGb: 24, cpuCoresEffective: 128, dphTotal: 3.2 }
    let rented = 0
    while (budgetOpen(budget) && offerFits(budget, offer)) {
      budget = subtractRental(
        budget,
        offer,
        offerContribution(offer, { slotsPerGpu: 1, maxNodeSlots: 0 })
      )
      rented++
    }
    expect(rented).toBe(1)
  })

  it('spends the $/hr budget offer by offer, and refuses an offer that no longer fits', () => {
    const start: CapacityBudget = {
      exclusiveLanes: 10,
      sharedSlots: 0,
      maxDphTotal: 1,
      maxNodes: 8
    }
    const c = { lanes: 1, sharedSlots: 2 }
    let b = subtractRental(start, { dphTotal: 0.4 }, c)
    expect(b.maxDphTotal).toBe(0.6)
    b = subtractRental(b, { dphTotal: 0.4 }, c)
    expect(b.maxDphTotal).toBe(0.2)
    expect(offerFits(b, { dphTotal: 0.4 })).toBe(false)
    expect(offerFits(b, { dphTotal: 0.2 })).toBe(true)
    expect(offerFits(b, { dphTotal: Number.NaN })).toBe(false)
    expect(subtractRental(b, { dphTotal: Number.NaN }, c).maxDphTotal).toBe(0)
    const uncapped = subtractRental({ ...start, maxDphTotal: Infinity }, { dphTotal: 5 }, c)
    expect(uncapped.maxDphTotal).toBe(Infinity)
  })

  it('covers exclusive lanes first, then shared slots, one rental at a time', () => {
    const b0: CapacityBudget = { exclusiveLanes: 2, sharedSlots: 6, maxDphTotal: 10, maxNodes: 3 }
    const c = { lanes: 4, sharedSlots: 4 }
    const b1 = subtractRental(b0, { dphTotal: 1 }, c)
    expect(b1).toMatchObject({ exclusiveLanes: 0, sharedSlots: 6, maxNodes: 2 })
    const b2 = subtractRental(b1, { dphTotal: 1 }, c)
    expect(b2).toMatchObject({ exclusiveLanes: 0, sharedSlots: 2, maxNodes: 1 })
    const b3 = subtractRental(b2, { dphTotal: 1 }, c)
    expect(budgetOpen(b3)).toBe(false)
  })
})
