import { describe, expect, it } from 'vitest'
import {
  co2Grams,
  GRID_INTENSITY,
  intensityFor,
  normaliseCountry,
  WORLD_AVERAGE
} from './intensity'

describe('normaliseCountry', () => {
  it('reads the trailing country code in vast.ai’s observed shapes', () => {
    expect(normaliseCountry('Poland, PL')).toBe('PL')
    expect(normaliseCountry('US')).toBe('US')
    expect(normaliseCountry('Quebec, CA')).toBe('CA')
    expect(normaliseCountry('Frankfurt, Hessen, DE')).toBe('DE')
  })

  it('resolves the strings real rented nodes actually reported', () => {
    // Captured from live vast.ai instances (2026-07-30) — the wire format is
    // "<region>, <ISO2>", and these two are the empirical proof of it.
    expect(normaliseCountry('South Carolina, US')).toBe('US')
    expect(normaliseCountry('Japan, JP')).toBe('JP')
    expect(intensityFor('South Carolina, US').known).toBe(true)
    expect(intensityFor('Japan, JP').known).toBe(true)
  })

  it('is forgiving about case and whitespace', () => {
    expect(normaliseCountry('  se ')).toBe('SE')
    expect(normaliseCountry('poland, pl')).toBe('PL')
    expect(normaliseCountry(' Quebec ,  ca ')).toBe('CA')
  })

  it('falls back to a spelled-out country name', () => {
    expect(normaliseCountry('Norway')).toBe('NO')
    expect(normaliseCountry('United States')).toBe('US')
    expect(normaliseCountry('Czech Republic')).toBe('CZ')
    // Name first, unrecognised trailing token.
    expect(normaliseCountry('Netherlands, Amsterdam')).toBe('NL')
  })

  it('returns null rather than guessing', () => {
    expect(normaliseCountry(null)).toBeNull()
    expect(normaliseCountry(undefined)).toBeNull()
    expect(normaliseCountry('')).toBeNull()
    expect(normaliseCountry('   ')).toBeNull()
    expect(normaliseCountry('Somewhere, XX')).toBeNull()
    expect(normaliseCountry('undisclosed')).toBeNull()
  })
})

describe('intensityFor', () => {
  it('uses the country’s own grid when it is known', () => {
    expect(intensityFor('Norway, NO')).toEqual({
      gPerKwh: GRID_INTENSITY.NO,
      country: 'NO',
      known: true
    })
    expect(intensityFor('Poland, PL').gPerKwh).toBe(GRID_INTENSITY.PL)
  })

  it('falls back to the world average and says so', () => {
    for (const geo of [null, 'Somewhere, XX', '']) {
      expect(intensityFor(geo)).toEqual({
        gPerKwh: WORLD_AVERAGE,
        country: null,
        known: false
      })
    }
  })

  it('keeps a wide spread between the cleanest and dirtiest grids', () => {
    // If this collapses, the per-country work has stopped earning its keep.
    const values = Object.values(GRID_INTENSITY)
    expect(Math.max(...values) / Math.min(...values)).toBeGreaterThan(10)
  })

  it('has plausible values for every entry', () => {
    for (const [code, g] of Object.entries(GRID_INTENSITY)) {
      expect(code, `${code} should be an ISO alpha-2 code`).toMatch(/^[A-Z]{2}$/)
      expect(g, `${code} intensity out of range`).toBeGreaterThan(0)
      expect(g, `${code} intensity out of range`).toBeLessThan(1000)
    }
  })
})

describe('co2Grams', () => {
  it('converts Wh at the country’s intensity', () => {
    // 1 kWh in Poland at overhead 1 = exactly the table value.
    expect(co2Grams(1000, 'Poland, PL', 1)).toBeCloseTo(GRID_INTENSITY.PL, 6)
    expect(co2Grams(2000, 'NO', 1)).toBeCloseTo(GRID_INTENSITY.NO * 2, 6)
  })

  it('applies the overhead factor linearly', () => {
    const base = co2Grams(1000, 'DE', 1)
    expect(co2Grams(1000, 'DE', 1.6)).toBeCloseTo(base * 1.6, 6)
    expect(co2Grams(1000, 'DE', 2)).toBeCloseTo(base * 2, 6)
  })

  it('costs an unknown location at the world average', () => {
    expect(co2Grams(1000, null, 1)).toBeCloseTo(WORLD_AVERAGE, 6)
  })

  it('is zero for zero or nonsense energy', () => {
    expect(co2Grams(0, 'DE', 1.6)).toBe(0)
    expect(co2Grams(-5, 'DE', 1.6)).toBe(0)
    expect(co2Grams(NaN, 'DE', 1.6)).toBe(0)
  })

  it('makes the same render in Norway vastly cheaper than in Poland', () => {
    const clean = co2Grams(10_000, 'Norway, NO', 1.6)
    const dirty = co2Grams(10_000, 'Poland, PL', 1.6)
    expect(dirty / clean).toBeGreaterThan(15)
  })
})
