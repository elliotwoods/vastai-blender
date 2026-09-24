import { describe, expect, it, vi } from 'vitest'
import type { NodeMetrics } from '../../shared/models'

// gpuLanes → slotController → db.ts (electron). Stub it; the policy is pure.
vi.mock('../db/db', () => ({ getDb: () => ({ prepare: () => ({ get: () => undefined }) }) }))

const { planLanes, guardLanes, initialGuard, effectiveLanes, normaliseSlotsPerGpu } =
  await import('./gpuLanes')
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
})
