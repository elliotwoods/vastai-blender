import { describe, expect, it, vi } from 'vitest'
import type { CapacityBudget, FleetHolds } from '../../shared/models'
import { capacityBudget, fitsBudget, type NodeCostFacts } from '../../shared/nodeState'
import {
  budgetOpen,
  capHeadroom,
  MAX_REQUESTS_PER_TICK,
  nodesToRequest,
  offerCap,
  offerContribution,
  planScaling,
  subtractRental,
  withDemand,
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

/** A node that holds an instance, at `dph` $/hr. */
const node = (dph: number, over: Partial<NodeCostFacts> = {}): NodeCostFacts => ({
  state: 'rendering',
  instanceId: 1,
  dphTotal: dph,
  ...over
})

/** The caps as main reads them: nodeState.capacityBudget over the fleet and settings. */
const caps = (
  nodes: NodeCostFacts[] = [],
  s: { maxActiveNodes?: number; spendCapPerHour?: number | null; noSpendCap?: boolean } = {}
): CapacityBudget =>
  capacityBudget(nodes, { maxActiveNodes: 30, spendCapPerHour: null, noSpendCap: true, ...s })

/**
 * planScaling once took a new node's rate (gpu_perf × GPUs) as
 * newNodeFramesPerHour and stopped whenever the queue was under a boot's
 * worth of it. It reads no such rate now. Fixtures may still carry the figure
 * gpu_perf would give, so that rule coming back fails here.
 */
type Fixture = Partial<PlanScalingInput> & { newNodeFramesPerHour?: number | null }

/** No nodes, nothing queued, no cap, no holds, nothing learned. */
const plan = (i: Fixture = {}): PlanScalingInput => ({
  cap: caps(),
  holds: {},
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
  ratedRuns: 0,
  eager: false,
  ...i
})

/** One live 8×4090 node, every lane busy, rendering at 8 × 60 frames/hour. */
const oneBusy8x4090: Fixture = {
  cap: caps([node(4)]),
  usableNodes: 1,
  usableLanes: 8,
  exclusiveCapacity: 0,
  fleetFramesPerHour: 480,
  ratedRuns: 8,
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
    expect(p.maxRentals).toBe(0)
    expect(budgetOpen(p.budget)).toBe(false)
  })

  it('...and nothing without a learned rate either: buy-ahead counts frames, not chunks', () => {
    const p = planScaling(
      plan({
        ...oneBusy8x4090,
        fleetFramesPerHour: null,
        eager: true,
        remainingExclusiveFrames: 1
      })
    )
    expect(p.status).toBe('covered')
  })

  describe('a fully downloaded retry chunk → no rent', () => {
    // The leftover requeue sub-chunk: pending, but every frame of it is
    // already on this computer.
    const downloaded: Fixture = {
      pendingExclusive: 1,
      pendingFrames: 0,
      remainingExclusiveFrames: 0
    }

    it('with no fleet at all: after a restart', () => {
      const p = planScaling(plan(downloaded))
      expect(p.status).toBe('covered')
      expect(p.reason).toMatch(/no frames left/)
      expect(p.maxRentals).toBe(0)
      expect(budgetOpen(p.budget)).toBe(false)
    })

    it('with a live node and no learned rate: a fresh install, or a new GPU model', () => {
      const p = planScaling(
        plan({
          ...oneBusy8x4090,
          ...downloaded,
          fleetFramesPerHour: null
        })
      )
      expect(p.status).toBe('covered')
      expect(p.nodes).toBe(0)
    })

    it('...and a shared chunk the same way', () => {
      const p = planScaling(plan({ pendingShared: 3, pendingFrames: 0, remainingSharedFrames: 0 }))
      expect(p.status).toBe('covered')
    })
  })

  it('1 frame left with 1 live node → no rent, even when it waits for a lane', () => {
    // One frame is a minute of one run's work; the busy lanes have hours left.
    const p = planScaling(
      plan({
        ...oneBusy8x4090,
        pendingExclusive: 1,
        pendingFrames: 1,
        remainingExclusiveFrames: 2000
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

describe("planScaling: the tail is the fleet's, at the rate it renders these jobs (plan 1.21)", () => {
  it('a heavy scene on a slow fleet rents, whatever gpu_perf learned on a light one', () => {
    // One live 4×4090 measured at 80 frames/h on this scene. gpu_perf, learned
    // on a light scene, says a new 4×4090 does 4800: the old rule read 460
    // frames as ~6 min of a new node's work and left the job ~5.75 h on one node.
    const p = planScaling(
      plan({
        cap: caps([node(1.6)]),
        usableNodes: 1,
        usableLanes: 4,
        fleetFramesPerHour: 80,
        ratedRuns: 4,
        newNodeFramesPerHour: 4800,
        newNodeLanes: 4,
        pendingExclusive: 10,
        pendingFrames: 460,
        remainingExclusiveFrames: 500
      })
    )
    expect(p.status).toBe('rent')
    expect(p.budget.exclusiveLanes).toBe(10)
  })

  it('a slow live node and a fast new one: the queue is judged on the live node', () => {
    // A 1×3060 at 30 frames/h; an 8×4090 would truly do 480.
    const p = planScaling(
      plan({
        cap: caps([node(0.2)]),
        usableNodes: 1,
        usableLanes: 1,
        fleetFramesPerHour: 30,
        ratedRuns: 1,
        newNodeFramesPerHour: 480,
        newNodeLanes: 8,
        pendingExclusive: 2,
        pendingFrames: 70,
        remainingExclusiveFrames: 80
      })
    )
    expect(p.status).toBe('rent')
  })

  it('one chunk renders on one lane, not at the whole fleet rate', () => {
    // 8 runs at 60 frames/h each. The one 70-frame chunk queued behind them
    // takes a lane 70 min, not 70/480 h ≈ 9 min.
    const p = planScaling(
      plan({
        ...oneBusy8x4090,
        newNodeFramesPerHour: 480,
        pendingExclusive: 1,
        pendingFrames: 70,
        remainingExclusiveFrames: 470
      })
    )
    expect(p.status).toBe('rent')
  })

  it('still stops for a short queue on a big fleet', () => {
    // 30 × 8 runs at 60 frames/h: 2000 queued frames in 250 chunks are gone
    // in ~8 min, before a new node could start on any.
    const p = planScaling(
      plan({
        cap: caps(
          Array.from({ length: 30 }, () => node(4)),
          { maxActiveNodes: 40 }
        ),
        usableNodes: 30,
        usableLanes: 240,
        fleetFramesPerHour: 240 * 60,
        ratedRuns: 240,
        newNodeLanes: 8,
        pendingExclusive: 250,
        pendingFrames: 2000,
        remainingExclusiveFrames: 2000 + 240 * 10
      })
    )
    expect(p.status).toBe('tail')
    expect(p.reason).toMatch(/2000 frames left in the queue take the fleet ~8 min/)
  })
})

describe('planScaling: holds and limits', () => {
  const big: Partial<PlanScalingInput> = {
    pendingExclusive: 20,
    pendingFrames: 2000,
    remainingExclusiveFrames: 2000
  }

  it('an account hold stops scale-up and says why (plan 1.20)', () => {
    const holds: FleetHolds = {
      account: { reason: 'Vast balance $0.12, fleet paused, top up', balance: 0.12, since: 0 }
    }
    const p = planScaling(plan({ ...big, holds }))
    expect(p.status).toBe('held')
    expect(p.reason).toMatch(/Vast balance \$0\.12/)
    expect(p.budget.exclusiveLanes).toBe(0)
    expect(budgetOpen(p.budget)).toBe(false)
  })

  it('names every hold at once', () => {
    const holds: FleetHolds = {
      localSink: { reason: 'output disk full', since: 0 },
      recovery: 3,
      scale: { reason: 'rentals keep failing; retrying at 10:42', since: 0, retryAt: 1 }
    }
    const p = planScaling(plan({ ...big, holds }))
    expect(p.reason).toMatch(/output disk full; 3 chunks from the last session/)
    expect(p.reason).toMatch(/rentals keep failing/)
  })

  it('a scale backoff lapses at its retryAt, whoever was meant to clear it', () => {
    const backoff = (retryAt: number | null): FleetHolds => ({
      scale: { reason: 'rentals keep failing; retrying at 10:42', since: 0, retryAt }
    })
    expect(planScaling(plan({ ...big, holds: backoff(2000), now: 1999 })).status).toBe('held')
    expect(planScaling(plan({ ...big, holds: backoff(2000), now: 2000 })).status).toBe('rent')
    // No retry time: only its owner releases it.
    expect(planScaling(plan({ ...big, holds: backoff(null), now: 1e15 })).status).toBe('held')
    // No clock: in force until cleared, as before.
    expect(planScaling(plan({ ...big, holds: backoff(2000) })).status).toBe('held')
    // Other holds have no retry time and stay.
    const both: FleetHolds = { ...backoff(2000), recovery: 2 }
    const p = planScaling(plan({ ...big, holds: both, now: 5000 }))
    expect(p.status).toBe('held')
    expect(p.reason).not.toMatch(/rentals keep failing/)
  })

  it('$0.05 of headroom is a $0.05 budget, not a yes (plan 1.5)', () => {
    const cap = caps([node(1.95)], { spendCapPerHour: 2, noSpendCap: false })
    const p = planScaling(plan({ ...big, cap }))
    expect(p.status).toBe('rent')
    expect(p.budget.headroomPerHour).toBe(0.05)
    // ...the same figure capHeadroom gives main's own checks.
    expect(capHeadroom(1.95, 2)).toBe(p.budget.headroomPerHour)
  })

  it('rents nothing when headroom is below the cheapest offer, rather than search in vain', () => {
    const cap = caps([node(1.97)], { spendCapPerHour: 2, noSpendCap: false })
    const p = planScaling(plan({ ...big, cap, minOfferDph: 0.05 }))
    expect(p.status).toBe('spend-cap')
    expect(p.reason).toMatch(/cheapest offer/)
  })

  it('counts a failed node that still holds its instance against the cap', () => {
    const failedHolding = node(0.8, { state: 'failed' })
    const cap = caps([node(1.5), failedHolding], { spendCapPerHour: 2, noSpendCap: false })
    expect(planScaling(plan({ ...big, cap })).status).toBe('spend-cap')
  })

  it('a blank cap without the no-cap flag rents nothing', () => {
    const cap = caps([], { spendCapPerHour: null, noSpendCap: false })
    const p = planScaling(plan({ ...big, cap }))
    expect(p.status).toBe('spend-cap')
    expect(p.reason).toMatch(/no spend cap is set/)
  })

  it('stops at max nodes and bounds a batch by room and the per-tick burst', () => {
    const full = caps(Array.from({ length: 30 }, () => node(0.2)))
    expect(planScaling(plan({ ...big, cap: full })).status).toBe('max-nodes')
    const three = caps(Array.from({ length: 27 }, () => node(0.2)))
    expect(planScaling(plan({ ...big, cap: three })).maxRentals).toBe(3)
    expect(planScaling(plan({ ...big })).maxRentals).toBe(MAX_REQUESTS_PER_TICK)
  })

  it('reports covered demand as covered, not as a limit', () => {
    const full = caps(Array.from({ length: 30 }, () => node(0.2)))
    const p = planScaling(plan({ cap: full, pendingExclusive: 4, exclusiveCapacity: 4 }))
    expect(p.status).toBe('covered')
  })

  it('agrees with nodesToRequest on the node count where both apply', () => {
    const cases: Array<Partial<ScaleInput>> = [
      { pendingExclusive: 90 },
      { pendingExclusive: 9, newNodeLanes: 4 },
      { pendingShared: 5, sharedCapacity: 1 },
      { pendingExclusive: 3, booting: [{ lanes: 1, sharedSlots: 2 }], active: 1 }
    ]
    for (const { active = 0, ...c } of cases) {
      const frames = (c.pendingExclusive ?? 0) + (c.pendingShared ?? 0)
      const rented = Array.from({ length: active }, () =>
        node(0, { state: 'requested', instanceId: null })
      )
      const p = planScaling(plan({ ...c, cap: caps(rented), pendingFrames: frames }))
      expect(p.nodes).toBe(nodesToRequest(input({ ...c, active })))
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
    const one = { numGpus: 1, gpuRamGb: 24, cpuCoresEffective: 16 }
    expect(offerContribution(one, { slotsPerGpu: 1, maxNodeSlots: 0 }).sharedSlots).toBe(2)
  })

  it('stops a batch once the demand is covered: one 8-GPU box for 8 lanes, not 8 boxes', () => {
    const p = planScaling(plan({ pendingExclusive: 8, pendingFrames: 800 }))
    let budget = p.budget
    expect(p.maxRentals).toBe(8)
    const offer = { numGpus: 8, gpuRamGb: 24, cpuCoresEffective: 128, dphTotal: 3.2 }
    const brings = offerContribution(offer, { slotsPerGpu: 1, maxNodeSlots: 0 })
    let rented = 0
    while (rented < p.maxRentals && budgetOpen(budget) && fitsBudget(budget, offer.dphTotal)) {
      budget = subtractRental(budget, offer, brings)
      rented++
    }
    expect(rented).toBe(1)
  })

  it('spends the $/hr headroom offer by offer, so a later offer must fit what is left', () => {
    const cap = caps([], { spendCapPerHour: 1, noSpendCap: false })
    let b: CapacityBudget = { ...cap, exclusiveLanes: 10, sharedSlots: 0 }
    const c = { lanes: 1, sharedSlots: 2 }
    b = subtractRental(b, { dphTotal: 0.4 }, c)
    expect(b.headroomPerHour).toBe(0.6)
    expect(b.perHour).toBeCloseTo(0.4)
    expect(b.nodes).toBe(1)
    b = subtractRental(b, { dphTotal: 0.4 }, c)
    expect(b.headroomPerHour).toBe(0.2)
    expect(fitsBudget(b, 0.4)).toBe(false)
    expect(fitsBudget(b, 0.2)).toBe(true)
    // An unpriced offer, had it been rented, spends everything.
    expect(subtractRental(b, { dphTotal: Number.NaN }, c).headroomPerHour).toBe(0)
    // No cap stays no cap.
    const uncapped = subtractRental({ ...caps(), exclusiveLanes: 5 }, { dphTotal: 5 }, c)
    expect(uncapped.headroomPerHour).toBeNull()
    expect(budgetOpen(uncapped)).toBe(true)
  })

  it('covers exclusive lanes first, then shared slots, one rental at a time', () => {
    const b0: CapacityBudget = { ...caps(), nodeRoom: 3, exclusiveLanes: 2, sharedSlots: 6 }
    const c = { lanes: 4, sharedSlots: 4 }
    const b1 = subtractRental(b0, { dphTotal: 1 }, c)
    expect(b1).toMatchObject({ exclusiveLanes: 0, sharedSlots: 6, nodeRoom: 2 })
    const b2 = subtractRental(b1, { dphTotal: 1 }, c)
    expect(b2).toMatchObject({ exclusiveLanes: 0, sharedSlots: 2, nodeRoom: 1 })
    const b3 = subtractRental(b2, { dphTotal: 1 }, c)
    expect(budgetOpen(b3)).toBe(false)
  })

  it('leaves a manual request (no demand) to room and money', () => {
    const manual = caps([], { spendCapPerHour: 2, noSpendCap: false })
    expect(manual.exclusiveLanes).toBeNull()
    expect(budgetOpen(manual)).toBe(true)
    const after = subtractRental(manual, { dphTotal: 1.5 }, { lanes: 4, sharedSlots: 4 })
    expect(after.exclusiveLanes).toBeNull()
    expect(after.headroomPerHour).toBe(0.5)
    expect(budgetOpen(subtractRental(after, { dphTotal: 0.5 }, { lanes: 1, sharedSlots: 2 }))).toBe(
      false
    )
  })
})

describe('withDemand: each rental is checked against the live fleet (plan 1.5)', () => {
  type CapSettings = Parameters<typeof capacityBudget>[1]
  const fourDollars: CapSettings = { maxActiveNodes: 30, spendCapPerHour: 4, noSpendCap: false }
  const oneLane = { lanes: 1, sharedSlots: 2 }

  /** One step of requestNodes' loop: may an offer at `dph` be rented now? */
  const mayRent = (
    fleet: NodeCostFacts[],
    settings: CapSettings,
    carried: CapacityBudget,
    dph: number
  ): boolean => {
    const b = withDemand(capacityBudget(fleet, settings), carried)
    return budgetOpen(b) && fitsBudget(b, dph)
  }

  it('a rental made elsewhere between two of the batch refuses the second', () => {
    const fleet: NodeCostFacts[] = []
    const p = planScaling(
      plan({
        cap: capacityBudget(fleet, fourDollars),
        pendingExclusive: 10,
        pendingFrames: 1000,
        remainingExclusiveFrames: 1000
      })
    )
    expect(p.status).toBe('rent')
    let carried = p.budget
    // The batch rents $1.50/h. Its row goes in before the create is sent.
    expect(mayRent(fleet, fourDollars, carried, 1.5)).toBe(true)
    fleet.push(node(1.5, { state: 'requested', instanceId: null }))
    carried = subtractRental(carried, { dphTotal: 1.5 }, oneLane)
    // While that create was out, the user rented $2/h by hand: $3.50 of $4.
    fleet.push(node(2))
    // The batch's own copy still has $2.50 left and would rent a $2.50 offer,
    // taking the fleet to $6/h...
    expect(fitsBudget(carried, 2.5)).toBe(true)
    // ...the live fleet leaves $0.50.
    expect(mayRent(fleet, fourDollars, carried, 2.5)).toBe(false)
    expect(mayRent(fleet, fourDollars, carried, 0.5)).toBe(true)
  })

  it('a lower cap or max nodes saved mid-batch holds from the next rental', () => {
    const fleet = [node(1)]
    const carried: CapacityBudget = {
      ...capacityBudget(fleet, fourDollars),
      exclusiveLanes: 5,
      sharedSlots: 0
    }
    expect(mayRent(fleet, fourDollars, carried, 2)).toBe(true)
    expect(mayRent(fleet, { ...fourDollars, spendCapPerHour: 2 }, carried, 2)).toBe(false)
    expect(mayRent(fleet, { ...fourDollars, maxActiveNodes: 1 }, carried, 0.1)).toBe(false)
  })

  it('takes only the demand from what the batch carries', () => {
    const live = capacityBudget([node(1)], fourDollars)
    const stale: CapacityBudget = { ...capacityBudget([], fourDollars), exclusiveLanes: 3 }
    expect(withDemand(live, stale)).toEqual({ ...live, exclusiveLanes: 3, sharedSlots: null })
    // Covered demand stops the batch; a manual request (no demand) does not.
    expect(budgetOpen(withDemand(live, { ...stale, exclusiveLanes: 0, sharedSlots: 0 }))).toBe(
      false
    )
    expect(budgetOpen(withDemand(live, live))).toBe(true)
  })
})
