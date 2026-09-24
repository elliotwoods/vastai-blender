import { describe, expect, it } from 'vitest'
import { capHeadroom, MAX_REQUESTS_PER_TICK, nodesToRequest, type ScaleInput } from './scaling'

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
