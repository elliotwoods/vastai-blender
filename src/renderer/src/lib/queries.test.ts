import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import type { FleetCost } from '../../../shared/models'

// The toolbar's totals and balance come from main's fleet:cost, pushed by
// its cost timer once a minute. A window that only listened showed $0.00
// and no balance for up to a minute after launch or a reopen (Phase 0
// follow-up for 1.1/1.20); it now asks when it opens.

const cost: FleetCost = {
  perHour: 3.2,
  sessionTotal: 12.5,
  sessionWh: 900,
  sessionCo2g: 300,
  balance: 41.2
}

vi.mock('./ipc', () => ({
  ipc: {
    invoke: vi.fn((channel: string) =>
      channel === 'fleet:cost' ? Promise.resolve(cost) : new Promise(() => {})
    ),
    on: vi.fn(() => () => {})
  }
}))

const { fleetCostQuery } = await import('./queries')

describe('fleet:cost', () => {
  it('is read when a window opens, not left empty until the next push', async () => {
    expect(await new QueryClient().fetchQuery(fleetCostQuery)).toEqual(cost)
  })
})
