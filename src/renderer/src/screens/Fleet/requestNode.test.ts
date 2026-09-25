import { describe, expect, it } from 'vitest'
import type { OfferFilters } from '../../../../shared/models'
import { overCapBound, overCapRequest } from './requestNode'

// A confirmed rental past the spend cap is bounded by the price the
// question named (plan 1.5, n3's handoff): the offer filter's, or with no
// price there, the cap itself.

const settings = (
  maxDphTotal: number | null,
  spendCapPerHour: number | null = null,
  noSpendCap = false
): {
  offerFilters: OfferFilters
  spendCapPerHour: number | null
  noSpendCap: boolean
} => ({
  offerFilters: { maxDphTotal } as OfferFilters,
  spendCapPerHour,
  noSpendCap
})

describe('overCapRequest', () => {
  it('sends the confirmation with the offer filter’s price as the bound', () => {
    expect(overCapRequest(settings(2.5, 10))).toEqual({ overSpendCap: true, maxPerHour: 2.5 })
    expect(overCapBound(settings(2.5, 10))).toEqual({ perHour: 2.5, from: 'offerFilter' })
  })

  // Review of 1.5: with no price in the filter the confirmation sent no
  // bound, and a second click could rent the top-ranked offer at any $/hr,
  // far past the cap it had just asked about.
  it('bounds it by the cap itself when the filter sets no price', () => {
    expect(overCapRequest(settings(null, 10))).toEqual({ overSpendCap: true, maxPerHour: 10 })
    expect(overCapBound(settings(null, 10))).toEqual({ perHour: 10, from: 'spendCap' })
  })

  it('sends no bound with neither a filter price nor a cap to bound it', () => {
    expect(overCapRequest(settings(null, null, true))).toEqual({
      overSpendCap: true,
      maxPerHour: null
    })
    // A $0 cap means rent nothing: as a bound it would rent nothing either.
    expect(overCapRequest(settings(null, 0))).toEqual({ overSpendCap: true, maxPerHour: null })
    expect(overCapRequest(undefined)).toEqual({ overSpendCap: true, maxPerHour: null })
  })
})
