import { describe, expect, it } from 'vitest'
import { growStep, type GrowState } from './useGrowPulse'

describe('growStep', () => {
  const start: GrowState = { last: 10, gen: 0, from: 10, to: 10 }

  it('keeps the same state while the value holds', () => {
    expect(growStep(start, 10)).toBe(start)
  })

  it('counts each growth, with where it grew from and to', () => {
    const a = growStep(start, 12)
    expect(a).toEqual({ last: 12, gen: 1, from: 10, to: 12 })
    expect(growStep(a, 13)).toEqual({ last: 13, gen: 2, from: 12, to: 13 })
  })

  it('does not pulse when the value falls', () => {
    expect(growStep(start, 4)).toEqual({ last: 4, gen: 0, from: 4, to: 4 })
  })
})
