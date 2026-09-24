import { describe, expect, it } from 'vitest'
import type { NodeState } from './models'
import {
  capacityBudget,
  capUsage,
  countsTowardCaps,
  createOutcomeUnknown,
  fitsBudget,
  holdsInstance,
  isBooting,
  isBusy,
  isDispatchable,
  type NodeCostFacts,
  type NodeFacts
} from './nodeState'

const ALL_STATES: NodeState[] = [
  'requested',
  'provisioning',
  'ready',
  'rendering',
  'encoding',
  'idle',
  'unreachable',
  'draining',
  'failed',
  'destroying',
  'destroyed'
]

/** A node with an instance, nothing confirmed destroyed, and no create outstanding. */
function node(state: NodeState, patch: Partial<NodeFacts> = {}): NodeFacts {
  return { state, instanceId: 4242, destroyedAt: null, createUnknownSince: null, ...patch }
}

function priced(state: NodeState, dphTotal: number, patch: Partial<NodeFacts> = {}): NodeCostFacts {
  return { ...node(state, patch), dphTotal }
}

describe('holdsInstance', () => {
  it('holds in every state while the instance has not been confirmed destroyed', () => {
    for (const state of ALL_STATES) expect(holdsInstance(node(state)), state).toBe(true)
  })

  it('a destroy that threw leaves a failed node holding its instance (#64 #194)', () => {
    // destroyNode's catch: 'failed', "destroy failed: …", instance id kept.
    // The old inline filters dropped it from the caps, the meter and History
    // while Vast kept billing it.
    const failedDestroy = node('failed', { instanceId: 9001 })
    expect(holdsInstance(failedDestroy)).toBe(true)
    expect(countsTowardCaps(failedDestroy)).toBe(true)
  })

  it('a node being destroyed still holds its instance until the destroy is confirmed', () => {
    expect(holdsInstance(node('destroying'))).toBe(true)
    expect(countsTowardCaps(node('destroying'))).toBe(true)
  })

  it("'destroyed' is not enough: only a confirmed destroy lets go (#140)", () => {
    // A DELETE can answer 200 {success:false} and leave the instance running.
    expect(holdsInstance(node('destroyed'))).toBe(true)
    // A snapshot built before destroyedAt existed reads the same way.
    expect(holdsInstance({ state: 'destroyed', instanceId: 7 })).toBe(true)
    expect(holdsInstance(node('destroyed', { destroyedAt: 1_700_000_000_000 }))).toBe(false)
  })

  it('a confirmed destroy lets go whatever the state says', () => {
    for (const state of ALL_STATES) {
      expect(holdsInstance(node(state, { destroyedAt: 1 })), state).toBe(false)
    }
  })

  it('a create in flight holds, before any instance id exists', () => {
    // rentOffer writes the 'requested' row before PUT /asks; the id comes
    // with the reply. maxActiveNodes has always counted this row, and a quit
    // or a cap check mid-create must too.
    const inFlight = node('requested', { instanceId: null })
    expect(createOutcomeUnknown(inFlight)).toBe(true)
    expect(holdsInstance(inFlight)).toBe(true)
    expect(countsTowardCaps(inFlight)).toBe(true)
  })

  it('a rental cancelled while its create was in flight holds, whatever state the cancel left (Phase 0 review, 1.2/1.4)', () => {
    // cancelledCreateUnknown: the create threw without a refusal from Vast,
    // so the instance may exist, billing under the node's label with its id
    // known to nobody. The row ends 'failed' (or 'destroyed', if the destroy
    // landed first) with instance_id NULL, which every old filter skipped.
    const since = 1_700_000_000_000
    for (const state of ['failed', 'destroyed', 'destroying'] as const) {
      const cancelled = node(state, { instanceId: null, createUnknownSince: since })
      expect(createOutcomeUnknown(cancelled), state).toBe(true)
      expect(holdsInstance(cancelled), state).toBe(true)
      expect(countsTowardCaps(cancelled), state).toBe(true)
    }
  })

  it('a create Vast refused, or a node destroyed before it rented anything, holds nothing', () => {
    // rentOffer's catch on a 4xx: 'failed', instance_id NULL, no outcome in doubt.
    expect(holdsInstance(node('failed', { instanceId: null }))).toBe(false)
    expect(holdsInstance(node('destroyed', { instanceId: null }))).toBe(false)
    expect(countsTowardCaps(node('failed', { instanceId: null }))).toBe(false)
  })

  it('once the instance id is known, the create outcome is known too', () => {
    // The label lookup adopted the instance and it was then destroyed; a
    // createUnknownSince left behind must not keep it holding forever.
    const adoptedThenDestroyed = node('destroyed', {
      instanceId: 55,
      createUnknownSince: 1,
      destroyedAt: 2
    })
    expect(createOutcomeUnknown(adoptedThenDestroyed)).toBe(false)
    expect(holdsInstance(adoptedThenDestroyed)).toBe(false)
  })

  it('a destroyedAt on a row with no instance id cannot settle an unknown create', () => {
    // Nothing with an id was destroyed, so nothing about the unknown
    // instance was confirmed.
    const n = node('destroyed', { instanceId: null, createUnknownSince: 1, destroyedAt: 2 })
    expect(holdsInstance(n)).toBe(true)
  })
})

describe('isDispatchable', () => {
  it('only a provisioned node that has not been lost, failed or destroyed takes work', () => {
    const yes = ALL_STATES.filter((s) => isDispatchable(node(s)))
    // The states scheduler.tick and scalePolicy's `usable` have always used.
    expect(yes).toEqual(['ready', 'rendering', 'idle'])
  })

  it('never a node whose destroy was confirmed, even if its state was not updated', () => {
    expect(isDispatchable(node('idle', { destroyedAt: 5 }))).toBe(false)
    expect(isDispatchable(node('ready', { instanceId: null }))).toBe(false)
  })
})

describe('isBooting', () => {
  it('is capacity on its way: requested or provisioning, and holding', () => {
    expect(ALL_STATES.filter((s) => isBooting(node(s)))).toEqual(['requested', 'provisioning'])
    expect(isBooting(node('requested', { instanceId: null }))).toBe(true)
    expect(isBooting(node('provisioning', { destroyedAt: 1 }))).toBe(false)
  })
})

describe('isBusy', () => {
  it('reads the runs, not the state (81fe2875)', () => {
    expect(isBusy({ currentWork: [], slotsInUse: 0 })).toBe(false)
    expect(isBusy({ currentWork: [{ chunkId: 'c', jobId: 'j', gpu: 0 }], slotsInUse: 1 })).toBe(
      true
    )
    // One source seeing a run is enough to keep scale-down away.
    expect(isBusy({ currentWork: [], slotsInUse: 1 })).toBe(true)
    expect(isBusy({ currentWork: [{ chunkId: 'c', jobId: 'j' }], slotsInUse: 0 })).toBe(true)
  })
})

describe('capUsage', () => {
  it('meters and caps every node that may be billing, and nothing else (#64 #168)', () => {
    const fleet: NodeCostFacts[] = [
      priced('rendering', 1.0),
      priced('provisioning', 0.5),
      priced('requested', 0.25, { instanceId: null }), // create in flight
      priced('failed', 2.0), // destroy threw: still billing
      priced('destroying', 0.75),
      priced('destroyed', 3.0, { destroyedAt: 1 }), // gone
      priced('failed', 4.0, { instanceId: null }) // Vast refused the create
    ]
    const u = capUsage(fleet)
    expect(u.nodes).toBe(5)
    expect(u.perHour).toBeCloseTo(4.5, 10)
  })

  it('a rate Vast never reported adds nothing, but the node still counts', () => {
    expect(capUsage([{ ...node('ready'), dphTotal: null }])).toEqual({ nodes: 1, perHour: 0 })
  })
})

describe('capacityBudget / fitsBudget', () => {
  const settings = { maxActiveNodes: 4, spendCapPerHour: 2 }

  it('a $1.95/hr fleet under a $2/hr cap has $0.05/hr left, not room for an $8/hr box (A7)', () => {
    const b = capacityBudget([priced('rendering', 1.95)], settings)
    expect(b.nodes).toBe(1)
    expect(b.nodeRoom).toBe(3)
    expect(b.perHour).toBeCloseTo(1.95, 10)
    // 2 - 1.95 is 0.050000000000000044: rounded down, not up.
    expect(b.headroomPerHour).toBe(0.05)
    expect(fitsBudget(b, 8)).toBe(false)
    expect(fitsBudget(b, 0.05)).toBe(true)
    expect(fitsBudget(b, 0.06)).toBe(false)
  })

  it('counts a failed node that may still be billing against both caps (#64)', () => {
    const b = capacityBudget([priced('failed', 1.9), priced('rendering', 0.05)], settings)
    expect(b.nodes).toBe(2)
    expect(b.headroomPerHour).toBeCloseTo(0.05, 10)
    expect(fitsBudget(b, 0.5)).toBe(false)
  })

  it('does not let float rounding refuse an offer that fits exactly', () => {
    // 0.1 + 0.2 is 0.30000000000000004, leaving 0.19999999999999996.
    const b = capacityBudget([priced('ready', 0.1), priced('ready', 0.2)], {
      maxActiveNodes: 4,
      spendCapPerHour: 0.5
    })
    expect(b.headroomPerHour).toBe(0.2)
    expect(fitsBudget(b, 0.2)).toBe(true)
    expect(fitsBudget(b, 0.2001)).toBe(false)
  })

  it('no room under maxActiveNodes refuses whatever the price', () => {
    const b = capacityBudget([priced('ready', 0.1), priced('failed', 0.1)], {
      maxActiveNodes: 2,
      spendCapPerHour: null,
      noSpendCap: true
    })
    expect(b.nodeRoom).toBe(0)
    expect(fitsBudget(b, 0.01)).toBe(false)
  })

  it('over the cap leaves no headroom rather than a negative one', () => {
    const b = capacityBudget([priced('ready', 3)], settings)
    expect(b.headroomPerHour).toBe(0)
    expect(fitsBudget(b, 0)).toBe(true)
    expect(fitsBudget(b, 0.01)).toBe(false)
  })

  it('"no spend cap": headroom is null and any known price fits while there is node room', () => {
    const b = capacityBudget([priced('ready', 50)], {
      maxActiveNodes: 4,
      spendCapPerHour: null,
      noSpendCap: true
    })
    expect(b.spendCap).toBeNull()
    expect(b.headroomPerHour).toBeNull()
    expect(fitsBudget(b, 100)).toBe(true)
    // The flag wins over a figure a hand-edited file left beside it.
    const both = capacityBudget([], { maxActiveNodes: 4, spendCapPerHour: 2, noSpendCap: true })
    expect(both.headroomPerHour).toBeNull()
  })

  it('a blank cap without the flag rents nothing, never "without limit" (#99 #112)', () => {
    // A settings file from before noSpendCap, or one the keystroke bug wrote.
    const b = capacityBudget([], { maxActiveNodes: 4, spendCapPerHour: null })
    expect(b.spendCap).toBe(0)
    expect(b.headroomPerHour).toBe(0)
    expect(fitsBudget(b, 0.01)).toBe(false)
    const off = capacityBudget([], { maxActiveNodes: 4, spendCapPerHour: null, noSpendCap: false })
    expect(fitsBudget(off, 0.01)).toBe(false)
  })

  it('a cap or max that is not a number refuses every rental instead of none', () => {
    const garbageCap = capacityBudget([], { maxActiveNodes: 4, spendCapPerHour: NaN })
    expect(garbageCap.headroomPerHour).toBe(0)
    expect(fitsBudget(garbageCap, 0.01)).toBe(false)
    const negativeCap = capacityBudget([], { maxActiveNodes: 4, spendCapPerHour: -5 })
    expect(negativeCap.headroomPerHour).toBe(0)
    const garbageMax = capacityBudget([], { maxActiveNodes: NaN, spendCapPerHour: 2 })
    expect(garbageMax.nodeRoom).toBe(0)
    expect(fitsBudget(garbageMax, 0.01)).toBe(false)
  })

  it('an unknown or negative price never fits under a cap', () => {
    const b = capacityBudget([], settings)
    expect(fitsBudget(b, NaN)).toBe(false)
    expect(fitsBudget(b, -1)).toBe(false)
  })

  it('leaves the demand parts to the scheduler', () => {
    const b = capacityBudget([], settings)
    expect(b.exclusiveLanes).toBeNull()
    expect(b.sharedSlots).toBeNull()
  })
})
