import { describe, expect, it, vi } from 'vitest'
import type { GpuSample, NodeMetrics } from '../../shared/models'

// gpuLanes → slotController → db.ts (electron). Stub it; the policy is pure.
vi.mock('../db/db', () => ({ getDb: () => ({ prepare: () => ({ get: () => undefined }) }) }))

const {
  planLanes,
  guardLanes,
  guardedLanePlan,
  initialGuard,
  effectiveLanes,
  laneLevels,
  normaliseSlotsPerGpu,
  cardVramFraction,
  perGpuFramesPerHour,
  runsOnGpu,
  dispatchLanePlan
} = await import('./gpuLanes')
type LaneGuard = import('./gpuLanes').LaneGuard
type LaneGuardContext = import('./gpuLanes').LaneGuardContext
const { SETTLE_MS } = await import('./slotController')

const metrics = (m: Partial<NodeMetrics> = {}): NodeMetrics => ({
  gpuUtil: 90,
  vramUsedGb: 10,
  vramTotalGb: 96,
  gpuTemp: 60,
  powerW: 1200,
  powerLimitW: 1800,
  cpuUtil: 40,
  cpuLoad1: 4,
  cpuCores: 64,
  ramUsedGb: 40,
  ramTotalGb: 256,
  updatedAt: 0,
  ...m
})

describe('planLanes', () => {
  it('gives one pinned lane per GPU by default', () => {
    expect(planLanes(4, 1, 24)).toEqual({ lanes: 4, pin: true })
  })

  it('gives two per GPU when asked', () => {
    expect(planLanes(4, 2, 24)).toEqual({ lanes: 8, pin: true })
  })

  it('is the historical single process when switched off', () => {
    expect(planLanes(4, 0, 24)).toEqual({ lanes: 1, pin: false })
  })

  it('does not pin on a single-GPU node, but allows two lanes on it', () => {
    expect(planLanes(1, 1, 24)).toEqual({ lanes: 1, pin: false })
    expect(planLanes(1, 2, 24)).toEqual({ lanes: 2, pin: false })
  })

  it('drops to one per GPU when two per GPU exceed the ceiling', () => {
    expect(planLanes(4, 2, 6)).toEqual({ lanes: 4, pin: true })
  })

  it('falls back to one process when the ceiling cannot give every GPU a lane', () => {
    // Pinning 1 lane on a 4-GPU node would idle three cards.
    expect(planLanes(4, 1, 1)).toEqual({ lanes: 1, pin: false })
    expect(planLanes(4, 1, 3)).toEqual({ lanes: 1, pin: false })
  })

  it('gives EEVEE and Octane one unpinned lane, the whole node (#229, #235)', () => {
    // Pinned EEVEE lanes all landed on card 0: its GL context ignores
    // CUDA_VISIBLE_DEVICES. Octane has one server and licence per node.
    expect(planLanes(4, 1, 24, 'eevee')).toEqual({ lanes: 1, pin: false })
    expect(planLanes(4, 2, 24, 'octane')).toEqual({ lanes: 1, pin: false })
    expect(planLanes(1, 2, 24, 'eevee')).toEqual({ lanes: 1, pin: false })
    expect(planLanes(4, 1, 24, 'cycles')).toEqual({ lanes: 4, pin: true })
    expect(planLanes(4, 1, 24, null)).toEqual({ lanes: 4, pin: true })
  })

  it('treats a missing setting as 1 and clamps silly values', () => {
    expect(normaliseSlotsPerGpu(undefined)).toBe(1)
    expect(normaliseSlotsPerGpu(9)).toBe(2)
    expect(normaliseSlotsPerGpu(-1)).toBe(0)
  })
})

describe('guardLanes', () => {
  it('does nothing below the memory threshold', () => {
    const g = initialGuard()
    expect(guardLanes(g, metrics(), 4, 0).guard).toBe(g)
  })

  it('steps down one lane under memory pressure', () => {
    const { guard, reason } = guardLanes(initialGuard(), metrics({ ramUsedGb: 245 }), 4, 1000)
    expect(guard.limit).toBe(3)
    expect(reason).toMatch(/memory/)
    expect(effectiveLanes({ lanes: 4, pin: true }, guard)).toBe(3)
  })

  it('waits a settle period before stepping again', () => {
    const hot = metrics({ vramUsedGb: 95 })
    const first = guardLanes(initialGuard(), hot, 4, 0).guard
    expect(guardLanes(first, hot, 4, SETTLE_MS - 1).guard.limit).toBe(3)
    expect(guardLanes(first, hot, 3, SETTLE_MS + 1).guard.limit).toBe(2)
  })

  it('never goes below one lane', () => {
    const g = { limit: 1, backoffAt: 0 }
    expect(guardLanes(g, metrics({ ramUsedGb: 255 }), 1, SETTLE_MS * 10).guard.limit).toBe(1)
  })

  it('#222: does not step again while the renders that caused the pressure still run', () => {
    // Lowering the limit stops admissions only: the four renders keep going
    // and keep memory at 92%. The old guard walked 4 → 3 → 2 → 1 anyway.
    const hot = metrics({ vramUsedGb: 88.5 }) // 92% of 96 GB
    let g = initialGuard()
    for (let i = 0; i <= 5; i++) g = guardLanes(g, hot, 4, i * (SETTLE_MS + 1)).guard
    expect(g.limit).toBe(3)
  })
})

/** One sample per card, nvidia-smi order. */
const cards = (used: number[], total = 24): GpuSample[] =>
  used.map((u, index) => ({
    index,
    util: 95,
    vramUsedGb: u,
    vramTotalGb: total,
    temp: 60,
    powerW: 400
  }))

/** A 4×4090 node: 96 GB of VRAM over four cards, 256 GB of RAM. */
const fourCards = (used: number[], ramUsedGb = 40): NodeMetrics =>
  metrics({
    gpus: cards(used),
    vramUsedGb: used.reduce((a, b) => a + b, 0),
    vramTotalGb: 96,
    ramUsedGb,
    ramTotalGb: 256
  })

const ctx = (c: Partial<LaneGuardContext> = {}): LaneGuardContext => ({
  numGpus: 4,
  slotsPerGpu: 1,
  cap: 24,
  ...c
})

/** Run the guard over a sequence of samples, one per scheduler tick (15 s). */
function run(
  g: LaneGuard,
  c: LaneGuardContext,
  samples: Array<{ m: NodeMetrics; inFlight: number; ticks: number }>,
  start = 0
): { guard: LaneGuard; now: number; reasons: string[] } {
  let now = start
  const reasons: string[] = []
  for (const { m, inFlight, ticks } of samples) {
    for (let i = 0; i < ticks; i++) {
      const r = guardLanes(g, m, inFlight, now, c)
      g = r.guard
      if (r.reason) reasons.push(r.reason)
      now += 15_000
    }
  }
  return { guard: g, now, reasons }
}

describe('guardedLanePlan and laneLevels (#222)', () => {
  it('lists the plans a node can move between, highest first', () => {
    expect(laneLevels(4, 2, 24)).toEqual([8, 4, 1])
    expect(laneLevels(4, 1, 24)).toEqual([4, 1])
    expect(laneLevels(1, 2, 24)).toEqual([2, 1])
    expect(laneLevels(4, 2, 6)).toEqual([4, 1])
    expect(laneLevels(4, 1, 24, 'eevee')).toEqual([1])
  })

  it('turns a limit below the GPU count into one unpinned process, never idle cards', () => {
    const g = { limit: 3, backoffAt: 0 }
    expect(guardedLanePlan(4, 1, 24, g)).toEqual({ lanes: 1, pin: false })
    // The deprecated composition pinned three lanes and idled a card.
    expect(effectiveLanes(planLanes(4, 1, 24), g)).toBe(3)
    expect(guardedLanePlan(4, 2, 24, { limit: 7, backoffAt: 0 })).toEqual({ lanes: 4, pin: true })
    expect(guardedLanePlan(4, 1, 24, initialGuard())).toEqual({ lanes: 4, pin: true })
  })
})

describe('guardLanes with the node context (#222)', () => {
  it('keeps every card busy when a heavy scene fills each card at one lane per GPU', () => {
    // The field shape: ~22 of 24 GB on every card of a 4×4090. Each card holds
    // exactly one scene; fewer lanes cannot lower any card's VRAM. The old
    // guard left one pinned lane and three idle paid cards within 3 minutes.
    const heavy = fourCards([22, 22, 22, 22])
    const r = run(initialGuard(), ctx(), [{ m: heavy, inFlight: 4, ticks: 5 * 7 }])
    expect(guardedLanePlan(4, 1, 24, r.guard)).toEqual({ lanes: 4, pin: true })
    expect(r.reasons).toEqual([])
  })

  it('drops the second lane per card when two scenes do not fit one card', () => {
    const r = run(initialGuard(), ctx({ slotsPerGpu: 2 }), [
      { m: fourCards([23, 23, 23, 23]), inFlight: 8, ticks: 1 }
    ])
    expect(guardedLanePlan(4, 2, 24, r.guard)).toEqual({ lanes: 4, pin: true })
    expect(r.reasons[0]).toMatch(/VRAM/)
  })

  it('reads VRAM per card: one full card counts even when the node total looks fine', () => {
    const oneFull = fourCards([23, 8, 8, 8]) // node total 49%
    expect(cardVramFraction(oneFull)).toBeCloseTo(23 / 24)
    const r = run(initialGuard(), ctx({ slotsPerGpu: 2 }), [{ m: oneFull, inFlight: 8, ticks: 1 }])
    expect(r.guard.limit).toBe(4)
    // No per-card breakdown: fall back to the node total.
    expect(cardVramFraction(metrics({ gpus: undefined, vramUsedGb: 48, vramTotalGb: 96 }))).toBe(
      0.5
    )
  })

  it('under RAM pressure falls back to one process across every GPU', () => {
    const r = run(initialGuard(), ctx(), [
      { m: fourCards([10, 10, 10, 10], 240), inFlight: 4, ticks: 1 }
    ])
    expect(guardedLanePlan(4, 1, 24, r.guard)).toEqual({ lanes: 1, pin: false })
    expect(r.reasons[0]).toMatch(/one process across every GPU/)
    expect(r.reasons[0]).toMatch(/RAM at 94%/)
  })

  it('steps again only once the previous step has taken effect', () => {
    const c = ctx({ slotsPerGpu: 2 })
    const hotRam = fourCards([10, 10, 10, 10], 240)
    // 8 → 4, then the eight renders keep running for five settle periods.
    let r = run(initialGuard(), c, [{ m: hotRam, inFlight: 8, ticks: 1 + 5 * 7 }])
    expect(r.guard.limit).toBe(4)
    // Down to four in flight and still hot: the next plan, after a settle.
    r = run(r.guard, c, [{ m: hotRam, inFlight: 4, ticks: 1 }], r.now)
    expect(guardedLanePlan(4, 2, 24, r.guard)).toEqual({ lanes: 1, pin: false })
  })

  it('recovers once a lighter scene leaves room, after a settle period of calm', () => {
    const c = ctx({ slotsPerGpu: 2 })
    let r = run(initialGuard(), c, [{ m: fourCards([23, 23, 23, 23]), inFlight: 8, ticks: 1 }])
    expect(r.guard.limit).toBe(4)
    // A lighter job: one scene is 7 GB, so two per card project to 58%.
    const light = fourCards([7, 7, 7, 7])
    r = run(r.guard, c, [{ m: light, inFlight: 4, ticks: 1 }], r.now + SETTLE_MS)
    expect(r.guard.limit).toBe(4) // one calm sample is not a settle period
    r = run(r.guard, c, [{ m: light, inFlight: 4, ticks: 7 }], r.now)
    expect(guardedLanePlan(4, 2, 24, r.guard)).toEqual({ lanes: 8, pin: true })
    expect(r.guard.limit).toBe(Number.POSITIVE_INFINITY)
    expect(r.reasons.some((x) => /back up to 8/.test(x))).toBe(true)
  })

  it('does not climb back into the pressure it just left', () => {
    // Same heavy scene at one per card: 12 of 24 GB, two per card would be
    // 100%. Staying at four lanes is right however long it stays calm.
    const c = ctx({ slotsPerGpu: 2 })
    let r = run(initialGuard(), c, [{ m: fourCards([23, 23, 23, 23]), inFlight: 8, ticks: 1 }])
    r = run(r.guard, c, [{ m: fourCards([12, 12, 12, 12]), inFlight: 4, ticks: 40 }], r.now)
    expect(r.guard.limit).toBe(4)
  })

  it('a hot sample restarts the calm period', () => {
    const c = ctx({ slotsPerGpu: 2 })
    let r = run(initialGuard(), c, [{ m: fourCards([23, 23, 23, 23]), inFlight: 8, ticks: 1 }])
    const light = fourCards([7, 7, 7, 7])
    r = run(r.guard, c, [{ m: light, inFlight: 4, ticks: 5 }], r.now + SETTLE_MS)
    // A spike to 92% on one card; with four lanes nothing lower helps VRAM,
    // but it is not calm either.
    r = run(r.guard, c, [{ m: fourCards([22, 7, 7, 7]), inFlight: 4, ticks: 1 }], r.now)
    expect(r.guard.calmSince ?? null).toBeNull()
    r = run(r.guard, c, [{ m: light, inFlight: 4, ticks: 5 }], r.now)
    expect(r.guard.limit).toBe(4)
  })

  it('does nothing for EEVEE or Octane, which already run one process', () => {
    const r = run(initialGuard(), ctx({ engine: 'eevee' }), [
      { m: fourCards([23, 23, 23, 23], 250), inFlight: 1, ticks: 20 }
    ])
    expect(r.reasons).toEqual([])
    expect(guardedLanePlan(4, 1, 24, r.guard, 'eevee')).toEqual({ lanes: 1, pin: false })
  })
})

describe('perGpuFramesPerHour (#225)', () => {
  // One 4090 renders 60 frames/hour of this scene on its own.
  it('the last chunk alone on a 4-GPU node teaches the real per-GPU rate, not 25%', () => {
    const r = perGpuFramesPerHour({
      runFramesPerHour: 60,
      gpu: 2,
      meanRunsOnGpu: 1,
      meanRunsOnNode: 1,
      numGpus: 4
    })
    // Old formula: 60 × meanConcurrency(1) ÷ 4 GPUs = 15.
    expect(r).toBe(60)
  })

  it('three pinned lanes of four still teach 60, not 45', () => {
    const r = perGpuFramesPerHour({
      runFramesPerHour: 60,
      gpu: 0,
      meanRunsOnGpu: 1,
      meanRunsOnNode: 3,
      numGpus: 4
    })
    expect(r).toBe(60)
  })

  it('two lanes sharing a card count as that card', () => {
    // Each of two runs on one card gets ~35 frames/hour; the card does 70.
    expect(
      perGpuFramesPerHour({ runFramesPerHour: 35, gpu: 1, meanRunsOnGpu: 2, numGpus: 4 })
    ).toBe(70)
  })

  it('an unpinned run is the node rate over the GPUs it uses', () => {
    // One Cycles process across four cards at 200 frames/hour.
    expect(perGpuFramesPerHour({ runFramesPerHour: 200, gpu: null, numGpus: 4 })).toBe(50)
    // Shared work: three unpinned runs at 40 each on a 1-GPU node.
    expect(
      perGpuFramesPerHour({ runFramesPerHour: 40, gpu: null, meanRunsOnNode: 3, numGpus: 1 })
    ).toBe(120)
    // EEVEE renders on one card whatever the node has.
    expect(
      perGpuFramesPerHour({ runFramesPerHour: 90, gpu: null, numGpus: 4, engine: 'eevee' })
    ).toBe(90)
  })

  it('records nothing for a rate that is not a rate', () => {
    expect(perGpuFramesPerHour({ runFramesPerHour: 0, gpu: 0, numGpus: 4 })).toBeNull()
    expect(perGpuFramesPerHour({ runFramesPerHour: Number.NaN, gpu: null, numGpus: 4 })).toBeNull()
  })

  it('samples how many runs share a card', () => {
    const work = [{ gpu: 0 }, { gpu: 1 }, { gpu: 1 }, { gpu: null }]
    expect(runsOnGpu(work, 1)).toBe(2)
    expect(runsOnGpu(work, 3)).toBe(1)
  })
})

describe('dispatchLanePlan (#224)', () => {
  const pinned4 = { lanes: 4, pin: true }

  it("sends a job's last chunk to an empty node as one process on every card", () => {
    expect(
      dispatchLanePlan({ plan: pinned4, nodeInFlight: 0, freeLanes: 4, pendingExclusive: 1 })
    ).toEqual({ lanes: 1, pin: false })
  })

  it('pins when there is work for every lane', () => {
    expect(
      dispatchLanePlan({ plan: pinned4, nodeInFlight: 0, freeLanes: 4, pendingExclusive: 4 })
    ).toEqual(pinned4)
    expect(
      dispatchLanePlan({ plan: pinned4, nodeInFlight: 0, freeLanes: 4, pendingExclusive: 9 })
    ).toEqual(pinned4)
  })

  it('keeps pinning beside pinned lanes already running', () => {
    expect(
      dispatchLanePlan({ plan: pinned4, nodeInFlight: 2, freeLanes: 2, pendingExclusive: 1 })
    ).toEqual(pinned4)
  })

  it('counts the free lanes the whole queue can reach', () => {
    // Five chunks, two empty 4-GPU nodes: the first node takes one chunk
    // across all its cards; the second then has exactly enough to pin.
    const first = dispatchLanePlan({
      plan: pinned4,
      nodeInFlight: 0,
      freeLanes: 8,
      pendingExclusive: 5
    })
    expect(first).toEqual({ lanes: 1, pin: false })
    const second = dispatchLanePlan({
      plan: pinned4,
      nodeInFlight: 0,
      freeLanes: 4,
      pendingExclusive: 4
    })
    expect(second).toEqual(pinned4)
  })

  it('leaves an unpinned plan alone', () => {
    const one = { lanes: 1, pin: false }
    expect(
      dispatchLanePlan({ plan: one, nodeInFlight: 0, freeLanes: 1, pendingExclusive: 0 })
    ).toBe(one)
  })
})
