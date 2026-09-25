import { describe, expect, it } from 'vitest'
import type { OfferFilters } from '../../../../shared/models'
import { overCapRequest } from './requestNode'

// A confirmed rental past the spend cap is bounded by the price the
// question named (plan 1.5, n3's handoff): the offer filter's.

const filters = (maxDphTotal: number | null): { offerFilters: OfferFilters } => ({
  offerFilters: { maxDphTotal } as OfferFilters
})

describe('overCapRequest', () => {
  it('sends the confirmation with the offer filter’s price as the bound', () => {
    expect(overCapRequest(filters(2.5))).toEqual({ overSpendCap: true, maxPerHour: 2.5 })
  })

  it('sends no bound when the filter sets no price', () => {
    expect(overCapRequest(filters(null))).toEqual({ overSpendCap: true, maxPerHour: null })
    expect(overCapRequest(undefined)).toEqual({ overSpendCap: true, maxPerHour: null })
  })
})
