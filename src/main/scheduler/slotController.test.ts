import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NodeMetrics } from '../../shared/models'

// slotController reaches SQLite for the learned-per-GPU cache, and db.ts pulls
// in electron. Stub the whole module: these tests are about the control law.
const learned = { row: undefined as { best_slots: number } | undefined }
vi.mock('../db/db', () => ({
  getDb: () => ({
    prepare: () => ({
      get: () => learned.row,
      run: () => undefined
    })
  })
}))

const { decide, hardCap, initialState, SETTLE_MS } = await import('./slotController')
type SlotState = import('./slotController').SlotState
type Decision = import('./slotController').Decision

const metrics = (m: Partial<NodeMetrics> = {}): NodeMetrics => ({
  gpuUtil: 50,
  vramUsedGb: 4,
  vramTotalGb: 24,
  gpuTemp: 60,
  powerW: 200,
  powerLimitW: 400,
  cpuUtil: 40,
  cpuLoad1: 4,
  cpuCores: 32,
  ramUsedGb: 16,
  ramTotalGb: 64,
  updatedAt: 0,
  ...m
})

beforeEach(() => {
  learned.row = undefined
})

describe('hardCap', () => {
  it('takes half the thread count', () => {
    expect(hardCap(metrics({ cpuCores: 32, vramTotalGb: 80, ramTotalGb: 256 }), 0)).toBe(16)
  })

  it('is capped by VRAM at ~1 GB per slot', () => {
    expect(hardCap(metrics({ cpuCores: 64, vramTotalGb: 12, ramTotalGb: 256 }), 0)).toBe(12)
  })

  it('is capped by RAM at ~3 GB per slot', () => {
    expect(hardCap(metrics({ cpuCores: 64, vramTotalGb: 80, ramTotalGb: 24 }), 0)).toBe(8)
  })

  it('never exceeds the agent-side absolute ceiling of 24', () => {
    expect(hardCap(metrics({ cpuCores: 256, vramTotalGb: 80, ramTotalGb: 512 }), 0)).toBe(24)
  })

  it('honours the user cap when set, and ignores it at 0', () => {
    const m = metrics({ cpuCores: 32, vramTotalGb: 80, ramTotalGb: 256 })
    expect(hardCap(m, 3)).toBe(3)
    expect(hardCap(m, 0)).toBe(16)
  })

  it('falls back to a conservative 8 before metrics arrive', () => {
    expect(hardCap(null, 0)).toBe(8)
  })

  it('never returns less than 1', () => {
    expect(hardCap(metrics({ cpuCores: 1, vramTotalGb: 1, ramTotalGb: 1 }), 0)).toBe(1)
  })
})

describe('initialState', () => {
  it('starts at 2 with no history', () => {
    expect(initialState('RTX 4090', 16, 0).target).toBe(2)
  })

  it('starts from the learned optimum for a known GPU', () => {
    learned.row = { best_slots: 9 }
    expect(initialState('RTX 4090', 16, 0).target).toBe(9)
  })

  it('clamps a learned value to the ceiling of this node', () => {
    learned.row = { best_slots: 20 }
    expect(initialState('RTX 4090', 6, 0).target).toBe(6)
  })

  it('leaves the baseline unmeasured so the climb re-verifies', () => {
    learned.row = { best_slots: 9 }
    expect(initialState('RTX 4090', 16, 0).bestThroughput).toBe(0)
  })
})

/** Saturated node, settle period elapsed — the state where a verdict is due. */
const ready = (over: Partial<SlotState> = {}): SlotState => ({
  target: 2,
  bestThroughput: 0,
  bestTarget: 2,
  lastChangeAt: 0,
  converged: false,
  ...over
})

interface StepOverrides {
  metrics?: NodeMetrics | null
  inFlight?: number
  now?: number
  maxNodeSlots?: number
}

const step = (state: SlotState, throughput: number | null, over: StepOverrides = {}): Decision =>
  decide({
    state,
    metrics: over.metrics === undefined ? metrics() : over.metrics,
    inFlight: over.inFlight ?? state.target,
    throughput,
    maxNodeSlots: over.maxNodeSlots ?? 0,
    now: over.now ?? SETTLE_MS + 1
  })

describe('decide — gating', () => {
  it('says nothing while the node is below its target', () => {
    const r = step(ready({ target: 4 }), 10, { inFlight: 2 })
    expect(r.state.target).toBe(4)
    expect(r.settledAt).toBeNull()
  })

  it('says nothing before the settle period elapses', () => {
    const r = step(ready({ bestThroughput: 5 }), 100, { now: SETTLE_MS - 1 })
    expect(r.state.target).toBe(2)
  })

  it('says nothing without a throughput sample', () => {
    const r = step(ready(), null)
    expect(r.state.target).toBe(2)
    expect(r.state.bestThroughput).toBe(0)
  })

  it('stays put once converged', () => {
    const r = step(ready({ converged: true, bestThroughput: 5 }), 500)
    expect(r.state.target).toBe(2)
  })
})

describe('decide — the climb', () => {
  it('takes the first sample as the baseline and probes one higher', () => {
    const r = step(ready(), 4)
    expect(r.state.bestThroughput).toBe(4)
    expect(r.state.bestTarget).toBe(2)
    expect(r.state.target).toBe(3)
    expect(r.state.converged).toBe(false)
  })

  it('keeps climbing while throughput improves by more than 5%', () => {
    const r = step(ready({ target: 3, bestThroughput: 4, bestTarget: 2 }), 6)
    expect(r.state.target).toBe(4)
    expect(r.state.bestThroughput).toBe(6)
    expect(r.state.bestTarget).toBe(3)
  })

  it('steps back to the best target when throughput falls off', () => {
    const r = step(ready({ target: 5, bestThroughput: 10, bestTarget: 4 }), 8)
    expect(r.state.target).toBe(4)
    expect(r.state.converged).toBe(true)
    expect(r.settledAt).not.toBeNull()
  })

  it('settles rather than pay contention for a flat result', () => {
    // Inside the ±5% dead band: measurably no better.
    const r = step(ready({ target: 5, bestThroughput: 10, bestTarget: 4 }), 10.2)
    expect(r.state.target).toBe(4)
    expect(r.state.converged).toBe(true)
  })
})

describe('decide — ceilings stop the climb', () => {
  it('settles at the hardware ceiling', () => {
    const m = metrics({ cpuCores: 8, vramTotalGb: 80, ramTotalGb: 256 }) // hardCap 4
    const r = step(ready({ target: 4, bestThroughput: 4, bestTarget: 3 }), 99, { metrics: m })
    expect(r.state.target).toBe(4)
    expect(r.state.converged).toBe(true)
    expect(r.reason).toMatch(/hardware ceiling/)
  })

  it('settles at the user cap', () => {
    const r = step(ready({ target: 3, bestThroughput: 4, bestTarget: 2 }), 99, { maxNodeSlots: 3 })
    expect(r.state.target).toBe(3)
    expect(r.state.converged).toBe(true)
  })

  it('stops climbing once the GPU is saturated', () => {
    const r = step(ready({ bestThroughput: 4, bestTarget: 2 }), 99, {
      metrics: metrics({ gpuUtil: 98 })
    })
    expect(r.state.target).toBe(2)
    expect(r.state.converged).toBe(true)
    expect(r.reason).toMatch(/GPU saturated/)
  })

  it('stops climbing when memory is already tight', () => {
    const r = step(ready({ bestThroughput: 4, bestTarget: 2 }), 99, {
      metrics: metrics({ vramUsedGb: 21, vramTotalGb: 24 }) // 87.5%
    })
    expect(r.state.target).toBe(2)
    expect(r.state.converged).toBe(true)
  })

  it('clamps a target that the ceiling has dropped below', () => {
    // Metrics arrive late, or the user lowers the cap under a running node.
    const r = step(ready({ target: 12, converged: true }), null, { maxNodeSlots: 4 })
    expect(r.state.target).toBe(4)
  })
})

describe('decide — memory backoff', () => {
  it('drops a slot immediately when VRAM is critical, without waiting to settle', () => {
    const r = step(ready({ target: 6, converged: false }), null, {
      inFlight: 6,
      now: 1, // no settle period elapsed
      metrics: metrics({ vramUsedGb: 23, vramTotalGb: 24 }) // 96%
    })
    expect(r.state.target).toBe(5)
    expect(r.state.converged).toBe(true)
    expect(r.reason).toMatch(/memory/)
  })

  it('backs off on system RAM too', () => {
    const r = step(ready({ target: 6 }), null, {
      inFlight: 6,
      now: 1,
      metrics: metrics({ ramUsedGb: 61, ramTotalGb: 64 })
    })
    expect(r.state.target).toBe(5)
  })

  it('overrides converged — an OOM kill costs the whole chunk', () => {
    const r = step(ready({ target: 6, converged: true }), null, {
      inFlight: 6,
      now: 1,
      metrics: metrics({ vramUsedGb: 23, vramTotalGb: 24 })
    })
    expect(r.state.target).toBe(5)
  })

  it('never backs off below one slot', () => {
    const r = step(ready({ target: 1 }), null, {
      inFlight: 1,
      now: 1,
      metrics: metrics({ vramUsedGb: 23.9, vramTotalGb: 24 })
    })
    expect(r.state.target).toBe(1)
  })

  it('takes ONE step per settle period, not one per tick', () => {
    // Backing off only blocks new admissions — the renders that caused the
    // pressure keep running, so memory stays critical for minutes. Without a
    // cooldown the every-15s tick walked a healthy node from 6 slots to 1.
    const critical = metrics({ vramUsedGb: 23, vramTotalGb: 24 }) // 96%
    let state = ready({ target: 6, converged: false })

    const first = step(state, null, { inFlight: 6, now: 1, metrics: critical })
    expect(first.state.target).toBe(5)
    state = first.state

    // Three more ticks at 15s apart, memory still critical: no further steps.
    for (const now of [15_001, 30_001, 45_001]) {
      const r = step(state, null, { inFlight: 6, now, metrics: critical })
      expect(r.state.target).toBe(5)
      expect(r.settledAt).toBeNull()
      state = r.state
    }

    // Once the backoff has had time to take effect, pressure that persists
    // does justify another step down.
    const later = step(state, null, { inFlight: 5, now: 1 + SETTLE_MS + 1, metrics: critical })
    expect(later.state.target).toBe(4)
  })

  it('discards the throughput sample when backing off, so gpu_slots is not poisoned', () => {
    // bestThroughput was measured at the HIGHER target; pairing it with the
    // reduced target would teach every later node of this GPU model that N-1
    // slots achieve what N did. The caller only persists when it is > 0.
    const r = step(ready({ target: 6, bestThroughput: 12, bestTarget: 6 }), null, {
      inFlight: 6,
      now: 1,
      metrics: metrics({ vramUsedGb: 23, vramTotalGb: 24 })
    })
    expect(r.state.target).toBe(5)
    expect(r.state.bestTarget).toBe(5)
    expect(r.state.bestThroughput).toBe(0)
  })
})
