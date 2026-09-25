import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FleetCost, NodeMetricsHistory } from '../../../shared/models'

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

// What node:metricsHistory answers, per test.
const history = vi.hoisted(() => ({
  answer: (): Promise<unknown> => new Promise(() => {})
}))

vi.mock('./ipc', () => ({
  ipc: {
    invoke: vi.fn((channel: string) =>
      channel === 'fleet:cost'
        ? Promise.resolve(cost)
        : channel === 'node:metricsHistory'
          ? history.answer()
          : new Promise(() => {})
    ),
    on: vi.fn(() => () => {})
  }
}))

const { fleetCostQuery, watchNodeReadings, SEED_RETRY_MS } = await import('./queries')
const { ipc } = await import('./ipc')
const { useMetricsStore } = await import('./metricsStore')

describe('fleet:cost', () => {
  it('is read when a window opens, not left empty until the next push', async () => {
    expect(await new QueryClient().fetchQuery(fleetCostQuery)).toEqual(cost)
  })
})

// Feature G: a row shows its node's last hour, seeded once from main's
// history. A seed that failed (main busy, a handler not up yet) was asked
// for again only by the next row to mount, and a row stays mounted as long
// as its node is listed: that node showed live samples alone for its whole
// life. It is now asked for again while anything still shows the node.
describe('seeding a node’s hour of GPU use', () => {
  const hour: NodeMetricsHistory = {
    nodeId: 'n1',
    fromMs: 0,
    toMs: 60_000,
    bucketMs: 30_000,
    gpus: [
      {
        index: 0,
        util: [{ ts: 0, mean: 50, min: 50, max: 50 }],
        vramPct: [],
        powerW: [],
        runs: []
      }
    ],
    unpinnedRuns: [],
    cpuUtil: [],
    powerW: []
  }
  const seedCalls = (): number =>
    vi.mocked(ipc.invoke).mock.calls.filter(([c]) => c === 'node:metricsHistory').length

  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(ipc.invoke).mockClear()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    useMetricsStore.setState({ byNode: {}, seeds: {} })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('asks again while the row still shows the node, and takes the hour when it comes', async () => {
    let fail = true
    history.answer = () => (fail ? Promise.reject(new Error('busy')) : Promise.resolve(hour))
    const stop = watchNodeReadings('n1')
    await vi.advanceTimersByTimeAsync(0)
    expect(seedCalls()).toBe(1)
    expect(useMetricsStore.getState().byNode.n1).toBeUndefined()

    fail = false
    await vi.advanceTimersByTimeAsync(SEED_RETRY_MS)
    expect(seedCalls()).toBe(2)
    expect(useMetricsStore.getState().seeds.n1).toBe('done')
    expect(useMetricsStore.getState().byNode.n1).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(10 * SEED_RETRY_MS)
    expect(seedCalls()).toBe(2)
    stop()
  })

  it('stops asking once nothing shows the node', async () => {
    history.answer = () => Promise.reject(new Error('busy'))
    const stop = watchNodeReadings('n1')
    await vi.advanceTimersByTimeAsync(0)
    stop()
    await vi.advanceTimersByTimeAsync(5 * SEED_RETRY_MS)
    expect(seedCalls()).toBe(1)
  })

  it('asks once for a node two rows show, and keeps asking while one still does', async () => {
    history.answer = () => Promise.reject(new Error('busy'))
    const row = watchNodeReadings('n1')
    const detail = watchNodeReadings('n1')
    await vi.advanceTimersByTimeAsync(0)
    expect(seedCalls()).toBe(1)
    detail()
    await vi.advanceTimersByTimeAsync(SEED_RETRY_MS)
    expect(seedCalls()).toBe(2)
    row()
    await vi.advanceTimersByTimeAsync(5 * SEED_RETRY_MS)
    expect(seedCalls()).toBe(2)
  })
})
