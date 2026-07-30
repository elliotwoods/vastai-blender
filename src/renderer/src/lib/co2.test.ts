import { describe, expect, it } from 'vitest'
import { COMPARISONS, compareCo2 } from './co2'
import { fmtCo2 } from './format'

describe('COMPARISONS ladder', () => {
  it('is strictly ascending', () => {
    for (let i = 1; i < COMPARISONS.length; i++) {
      expect(COMPARISONS[i].kg).toBeGreaterThan(COMPARISONS[i - 1].kg)
    }
  })

  it('never leaves a gap wider than one order of magnitude', () => {
    // This spacing is what guarantees a readable multiplier — if an anchor is
    // removed and a 10x gap opens up, compareCo2 starts emitting "8.4 ×".
    for (let i = 1; i < COMPARISONS.length; i++) {
      const ratio = COMPARISONS[i].kg / COMPARISONS[i - 1].kg
      expect(ratio, `gap after "${COMPARISONS[i - 1].label}"`).toBeLessThanOrEqual(4)
    }
  })

  it('spans from grams to tonnes', () => {
    expect(COMPARISONS[0].kg).toBeLessThan(0.01)
    expect(COMPARISONS[COMPARISONS.length - 1].kg).toBeGreaterThan(10_000)
  })

  it('labels read as noun phrases', () => {
    for (const c of COMPARISONS) {
      expect(c.label, c.label).toMatch(/^(a|an) /)
      expect(c.label).not.toMatch(/\.$/)
    }
  })
})

describe('compareCo2', () => {
  it('anchors against a recognisable activity', () => {
    // 2 kg is exactly one bath.
    expect(compareCo2(2000)).toBe('≈ 1.0 × a full hot bath')
    // 1 t is exactly one transatlantic round trip.
    expect(compareCo2(1_000_000)).toBe('≈ 1.0 × a transatlantic round trip')
  })

  it('keeps the multiplier readable across seven orders of magnitude', () => {
    // Sweep 1 g → 50 t. Every result must land in [1, 4) — the ladder's own
    // spacing is what makes this hold, so this test guards the ladder as much
    // as the function.
    for (let g = 1; g < 50_000_000; g *= 1.3) {
      const out = compareCo2(g)
      expect(out, `for ${g} g`).not.toBeNull()
      const n = Number(/≈ ([\d.]+) ×/.exec(out as string)?.[1])
      expect(Number.isFinite(n), `for ${g} g: ${out}`).toBe(true)
      const smallest = COMPARISONS[0].kg * 1000
      const largest = COMPARISONS[COMPARISONS.length - 1].kg * 1000
      if (g >= smallest && g < largest) {
        expect(n, `for ${g} g → ${out}`).toBeGreaterThanOrEqual(1)
        expect(n, `for ${g} g → ${out}`).toBeLessThan(4)
      }
    }
  })

  it('uses a fraction of the smallest anchor below the bottom of the ladder', () => {
    const out = compareCo2(1) as string
    expect(out).toContain('a phone charge')
    expect(Number(/≈ ([\d.]+) ×/.exec(out)?.[1])).toBeLessThan(1)
  })

  it('has nothing to say about zero', () => {
    expect(compareCo2(0)).toBeNull()
    expect(compareCo2(-5)).toBeNull()
    expect(compareCo2(NaN)).toBeNull()
  })
})

describe('fmtCo2', () => {
  it('steps g → kg → t at the right thresholds', () => {
    expect(fmtCo2(0)).toBe('0 g CO₂e')
    expect(fmtCo2(940)).toBe('940 g CO₂e')
    expect(fmtCo2(1000)).toBe('1.00 kg CO₂e')
    expect(fmtCo2(2540)).toBe('2.54 kg CO₂e')
    expect(fmtCo2(999_999)).toBe('1000.00 kg CO₂e')
    expect(fmtCo2(1_000_000)).toBe('1.00 t CO₂e')
    expect(fmtCo2(5_400_000)).toBe('5.40 t CO₂e')
  })
})
