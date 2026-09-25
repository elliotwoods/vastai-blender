import { describe, expect, it } from 'vitest'
import {
  admits,
  BREAKER_NODES,
  breakerKey,
  budgetFor,
  chargeFor,
  chunkBackoffMs,
  exclusiveLanesFor,
  freeExclusiveLanes,
  hasRoom,
  JobBreaker,
  nodeCapacity,
  nodeRestMs,
  PREFETCH,
  RETRY_BACKOFF_BASE_MS,
  RETRY_BACKOFF_MAX_MS,
  NODE_REST_BASE_MS,
  type FailureClass,
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

describe('exclusiveLanesFor — the lanes a node offers one chunk (plan 1.11)', () => {
  const pinned4 = { lanes: 4, pin: true }
  const whole = { lanes: 1, pin: false }
  const running = (lanes: number, inFlight: number): NodeOccupancy =>
    occ({ inFlight, hasExclusive: true, exclusiveLanes: lanes })

  it("is the chunk's own plan on an empty node", () => {
    expect(exclusiveLanesFor(pinned4, [])).toBe(4)
    expect(exclusiveLanesFor(whole, [])).toBe(1)
  })

  it('is the plan beside pinned lanes, so an EEVEE chunk sees them as full (#229)', () => {
    expect(exclusiveLanesFor(pinned4, [pinned4, pinned4])).toBe(4)
    expect(admits(running(exclusiveLanesFor(whole, [pinned4, pinned4]), 2), exclusive)).toBe(false)
  })

  it('is one beside an unpinned run, which has every card (#224, #229)', () => {
    const o = running(exclusiveLanesFor(pinned4, [whole]), 1)
    expect(o.exclusiveLanes).toBe(1)
    expect(admits(o, exclusive)).toBe(false)
    expect(freeExclusiveLanes(o)).toBe(0)
  })
})

describe('retry policy (plan 1.17)', () => {
  const f = (kind: FailureClass['kind'], rule: string): FailureClass => ({ kind, rule })

  describe('budgetFor: whose fault decides what an attempt costs', () => {
    it('charges the render only for the render', () => {
      expect(budgetFor(f('job', 'agent-exit'))).toBe('render')
      expect(budgetFor(f('job', 'unclassified'))).toBe('render')
    })

    it('1d59516c: a node Vast stopped, or the network, is charged to the machines', () => {
      expect(budgetFor(f('machine', 'ssh-unreachable'))).toBe('infra')
      expect(budgetFor(f('machine', 'node-gone'))).toBe('infra')
      expect(budgetFor(f('transient', 'ssh-channels'))).toBe('infra')
      expect(budgetFor(f('account', 'vast-credit'))).toBe('infra')
      expect(budgetFor(f('localFs', 'local-ENOENT'))).toBe('infra')
    })

    it('charges nothing for frames this computer would not take', () => {
      expect(budgetFor(f('localFs', 'local-sink'))).toBe('none')
    })

    it('1.18: charges nothing for an Octane sign-in nobody made; the job waits for it', () => {
      expect(budgetFor(f('transient', 'octane-login'))).toBe('none')
      expect(budgetFor(f('machine', 'octane-unvetted'))).toBe('infra')
    })
  })

  describe('chargeFor: the same render failing on the machine again is the render', () => {
    it('charges a first render that failed on the machine to the machines', () => {
      expect(chargeFor(f('machine', 'agent-oom'), 'render', false)).toBe('infra')
      expect(chargeFor(f('machine', 'agent-stalled'), 'render', false)).toBe('infra')
    })

    it('charges the same failure again to the render, so it is bounded by the render retries', () => {
      expect(chargeFor(f('machine', 'agent-oom'), 'render', true)).toBe('render')
      expect(chargeFor(f('machine', 'agent-killed'), 'render', true)).toBe('render')
    })

    it('1d59516c: a node that cannot be reached, or goes away, never is', () => {
      expect(chargeFor(f('machine', 'ssh-unreachable'), 'dispatch', true)).toBe('infra')
      expect(chargeFor(f('machine', 'node-setup'), 'dispatch', true)).toBe('infra')
      expect(chargeFor(f('machine', 'node-gone'), 'node', true)).toBe('infra')
      expect(chargeFor(f('transient', 'frames-lost'), 'download', true)).toBe('infra')
      expect(chargeFor(f('localFs', 'local-sink'), 'download', true)).toBe('none')
    })
  })

  describe('chunkBackoffMs: only a transient failure waits', () => {
    it('doubles from the base with each infrastructure retry, up to the cap', () => {
      const t = f('transient', 'ssh-channels')
      expect(chunkBackoffMs(t, 1)).toBe(RETRY_BACKOFF_BASE_MS)
      expect(chunkBackoffMs(t, 2)).toBe(2 * RETRY_BACKOFF_BASE_MS)
      expect(chunkBackoffMs(t, 3)).toBe(4 * RETRY_BACKOFF_BASE_MS)
      expect(chunkBackoffMs(t, 50)).toBe(RETRY_BACKOFF_MAX_MS)
    })

    it("sends a machine's failure elsewhere at once, and a render failure again at once", () => {
      expect(chunkBackoffMs(f('machine', 'ssh-unreachable'), 1)).toBe(0)
      expect(chunkBackoffMs(f('job', 'agent-exit'), 1)).toBe(0)
      expect(chunkBackoffMs(f('localFs', 'local-sink'), 1)).toBe(0)
    })
  })

  it('nodeRestMs doubles with each failure in a row, up to the cap', () => {
    expect(nodeRestMs(1)).toBe(NODE_REST_BASE_MS)
    expect(nodeRestMs(2)).toBe(2 * NODE_REST_BASE_MS)
    expect(nodeRestMs(100)).toBe(RETRY_BACKOFF_MAX_MS)
  })

  describe("breakerKey: which failures may be the job's", () => {
    it("counts the render's failures and a node setup that fails", () => {
      expect(breakerKey(f('job', 'agent-exit'))).toBe('job')
      expect(breakerKey(f('job', 'unclassified'))).toBe('job')
      expect(breakerKey(f('machine', 'node-setup'))).toBe('node-setup')
      expect(breakerKey(f('localFs', 'local-ENOENT'))).toBe('localFs')
    })

    it("1d59516c: never a node that is gone or refuses, or the network, or the disk's hold", () => {
      expect(breakerKey(f('machine', 'ssh-unreachable'))).toBeNull()
      expect(breakerKey(f('machine', 'node-gone'))).toBeNull()
      expect(breakerKey(f('machine', 'agent-gpu'))).toBeNull()
      expect(breakerKey(f('transient', 'ssh-channels'))).toBeNull()
      expect(breakerKey(f('localFs', 'local-sink'))).toBeNull()
    })

    it('a render that failed on the machine, by rule, once its chunk failed that way before', () => {
      expect(breakerKey(f('machine', 'agent-oom'), 'render', true)).toBe('render:agent-oom')
      expect(breakerKey(f('machine', 'agent-stalled'), 'render', true)).toBe('render:agent-stalled')
      expect(breakerKey(f('machine', 'agent-killed'), 'render', true)).toBe('render:agent-killed')
      // 1d59516c: the machines failing before anything rendered never are.
      expect(breakerKey(f('machine', 'ssh-unreachable'), 'dispatch', true)).toBeNull()
      expect(breakerKey(f('machine', 'node-gone'), 'node', true)).toBeNull()
      expect(breakerKey(f('transient', 'frames-lost'), 'download', true)).toBeNull()
      // The job's own failures keep their key whatever the stage.
      expect(breakerKey(f('job', 'agent-exit'), 'render')).toBe('job')
    })

    it("not a chunk's first render the machine failed: that is as likely the node's packing", () => {
      // Every lane of a 4-GPU node loads a heavy scene at once, and the
      // kernel kills one; the lane guard steps down after exactly that.
      expect(breakerKey(f('machine', 'agent-killed'), 'render')).toBeNull()
      expect(breakerKey(f('machine', 'agent-oom'), 'render', false)).toBeNull()
      expect(breakerKey(f('machine', 'agent-gpu'), 'render', false)).toBeNull()
    })

    it('not a setup step whose connection went before it exited', () => {
      const setup = (reason: string): FailureClass => ({ ...f('machine', 'node-setup'), reason })
      expect(
        breakerKey(setup('setting up the node failed: install blender 4.2.3 failed (exit 1)'))
      ).toBe('node-setup')
      expect(
        breakerKey(setup('setting up the node failed: install blender 4.2.3 failed (exit null)'))
      ).toBeNull()
    })
  })

  describe('JobBreaker', () => {
    it(`trips on the node that makes it ${BREAKER_NODES}, once`, () => {
      const b = new JobBreaker()
      expect(b.record('job', 'job', 'node-a')).toBe(false)
      // The same node again says nothing more about the job.
      expect(b.record('job', 'job', 'node-a')).toBe(false)
      expect(b.record('job', 'job', 'node-b')).toBe(true)
      expect(b.record('job', 'job', 'node-c')).toBe(false)
      expect(b.nodesFor('job', 'job').sort()).toEqual(['node-a', 'node-b', 'node-c'])
    })

    it('counts each failure, and each job, apart', () => {
      const b = new JobBreaker()
      expect(b.record('job-1', 'job', 'node-a')).toBe(false)
      expect(b.record('job-1', 'node-setup', 'node-b')).toBe(false)
      expect(b.record('job-2', 'job', 'node-b')).toBe(false)
    })

    it('starts again once the job renders a chunk', () => {
      const b = new JobBreaker()
      b.record('job', 'job', 'node-a')
      b.reset('job')
      expect(b.record('job', 'job', 'node-b')).toBe(false)
      expect(b.record('job', 'job', 'node-a')).toBe(true)
    })

    it("takes this computer's failures as the job's on the second, on any node", () => {
      const b = new JobBreaker()
      expect(b.record('job', 'localFs', 'node-a')).toBe(false)
      expect(b.record('job', 'localFs', 'node-a')).toBe(true)
    })
  })
})
