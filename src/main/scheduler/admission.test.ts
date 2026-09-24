import { describe, expect, it } from 'vitest'
import {
  admits,
  freeExclusiveLanes,
  hasRoom,
  nodeCapacity,
  PREFETCH,
  type NodeOccupancy
} from './admission'

const occ = (o: Partial<NodeOccupancy> = {}): NodeOccupancy => ({
  inFlight: 0,
  hasExclusive: false,
  reservedFor: null,
  slotTarget: 1,
  ...o
})

const shared = { id: 'c-shared', sharesNode: true }
const exclusive = { id: 'c-excl', sharesNode: false }

describe('nodeCapacity', () => {
  it('is 1 at a target of 1 — no prefetch on a single-slot node', () => {
    expect(nodeCapacity(1)).toBe(1)
  })

  it('adds the prefetch tail above one slot', () => {
    expect(nodeCapacity(4)).toBe(4 + PREFETCH)
  })
})

describe('admits — exclusive chunks', () => {
  it('takes an empty node', () => {
    expect(admits(occ(), exclusive)).toBe(true)
  })

  it('is refused by a node already running something', () => {
    expect(admits(occ({ inFlight: 1, slotTarget: 6 }), exclusive)).toBe(false)
  })

  it('is refused however much slot headroom the node reports', () => {
    expect(admits(occ({ inFlight: 1, slotTarget: 24 }), exclusive)).toBe(false)
  })
})

describe('admits — a node holding an exclusive chunk', () => {
  const locked = occ({ inFlight: 1, hasExclusive: true, slotTarget: 8 })

  it('takes no shared work', () => {
    expect(admits(locked, shared)).toBe(false)
  })

  it('takes no further exclusive work', () => {
    expect(admits(locked, exclusive)).toBe(false)
  })

  it('reports no room at all', () => {
    expect(hasRoom(locked)).toBe(false)
  })
})

describe('admits — shared chunks', () => {
  it('packs up to the target plus prefetch', () => {
    const target = 4
    for (let inFlight = 0; inFlight < target + PREFETCH; inFlight++) {
      expect(admits(occ({ inFlight, slotTarget: target }), shared)).toBe(true)
    }
    expect(admits(occ({ inFlight: target + PREFETCH, slotTarget: target }), shared)).toBe(false)
  })

  it('is held to one chunk while the target is still 1', () => {
    expect(admits(occ({ inFlight: 0, slotTarget: 1 }), shared)).toBe(true)
    expect(admits(occ({ inFlight: 1, slotTarget: 1 }), shared)).toBe(false)
  })
})

describe('admits — reservations', () => {
  // A node held empty for a waiting exclusive chunk must not be refilled with
  // shared work, or the chunk it is draining for would never get its turn.
  const draining = occ({ inFlight: 2, reservedFor: 'c-excl', slotTarget: 8 })

  it('refuses shared work while draining', () => {
    expect(admits(draining, shared)).toBe(false)
  })

  it('refuses other exclusive chunks while draining', () => {
    expect(admits(draining, { id: 'c-other', sharesNode: false })).toBe(false)
  })

  it('admits the reserved chunk once the node is empty', () => {
    const drained = occ({ inFlight: 0, reservedFor: 'c-excl', slotTarget: 8 })
    expect(admits(drained, exclusive)).toBe(true)
  })

  it('still refuses the reserved chunk while runs remain', () => {
    expect(admits(draining, exclusive)).toBe(false)
  })

  it('reports room only when drained', () => {
    expect(hasRoom(draining)).toBe(false)
    expect(hasRoom(occ({ inFlight: 0, reservedFor: 'c-excl' }))).toBe(true)
  })
})

describe('GPU lanes — exclusive chunks on a multi-GPU node', () => {
  const lanes4 = (o: Partial<NodeOccupancy> = {}): NodeOccupancy =>
    occ({ exclusiveLanes: 4, slotTarget: 4, ...o })

  it('runs one exclusive chunk per lane', () => {
    for (let inFlight = 0; inFlight < 4; inFlight++) {
      const o = lanes4({ inFlight, hasExclusive: inFlight > 0 })
      expect(admits(o, exclusive)).toBe(true)
      expect(hasRoom(o)).toBe(true)
    }
    const full = lanes4({ inFlight: 4, hasExclusive: true })
    expect(admits(full, exclusive)).toBe(false)
    expect(hasRoom(full)).toBe(false)
  })

  it('still never mixes exclusive and shared work', () => {
    expect(admits(lanes4({ inFlight: 1, hasExclusive: true }), shared)).toBe(false)
    expect(admits(lanes4({ inFlight: 1, hasExclusive: false }), exclusive)).toBe(false)
  })

  it('admits the reserved chunk into a freed lane, and nothing else', () => {
    const o = lanes4({ inFlight: 3, hasExclusive: true, reservedFor: 'c-excl' })
    expect(admits(o, exclusive)).toBe(true)
    expect(admits(o, { id: 'c-other', sharesNode: false })).toBe(false)
  })

  it('counts free lanes for scale-up', () => {
    expect(freeExclusiveLanes(lanes4())).toBe(4)
    expect(freeExclusiveLanes(lanes4({ inFlight: 1, hasExclusive: true }))).toBe(3)
    expect(freeExclusiveLanes(lanes4({ inFlight: 1, hasExclusive: false }))).toBe(0)
    expect(freeExclusiveLanes(occ())).toBe(1)
  })
})
