import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { FleetHolds } from '../../../shared/models'

// HoldsBanner as the window shows it, from a seeded query cache with the IPC
// bridge stubbed (window.api, which a test has no window for). holds.test.ts
// pins each row's words; this pins that they reach the screen, with the
// buttons that lift each hold.

vi.mock('../lib/ipc', () => ({
  ipc: { invoke: vi.fn(() => new Promise(() => {})), on: vi.fn(() => () => {}) }
}))

const { qk } = await import('../lib/queries')
const { HoldsBanner } = await import('./HoldsBanner')

function render(holds: FleetHolds): string {
  const qc = new QueryClient()
  qc.setQueryData(qk.holds, holds)
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <HoldsBanner />
    </QueryClientProvider>
  )
}

describe('the holds: why the fleet is not renting', () => {
  it('1.20 (1d59516c): a spent balance says so, with Top up', () => {
    const holds: FleetHolds = {
      account: { reason: 'insufficient_credit', balance: 0, since: Date.UTC(2026, 8, 25, 12) }
    }
    const html = render(holds)
    expect(html).toContain('Renting is paused: insufficient_credit.')
    expect(html).toContain('Vast balance $0.00.')
    expect(html).toContain('Top up')
    expect(html).toContain('Try now')
  })

  it('1.9: recovered work asks before renting, and a finished hold goes away', () => {
    const held = render({ recovery: 2 })
    expect(held).toContain('2 unfinished chunks recovered')
    expect(held).toContain('Resume rendering')
    expect(render({})).toBe('')
  })

  it('1.10: a disk that refuses frames says what is paused', () => {
    const html = render({ localSink: { reason: 'disk full', since: 1 } })
    expect(html).toContain('Downloads and new work are paused: disk full.')
    expect(html).toContain('Check again')
  })
})
