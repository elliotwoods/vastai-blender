import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NodeSnapshot, SettingsPublic } from '../../../../shared/models'

// The Fleet as Phase 1 wires it, rendered from a seeded query cache with
// the IPC bridge stubbed (window.api, which a test has no window for), as
// recoveryWiring.test.tsx does:
// - 1.2: a node that may still be billing is always listed, and counted.

vi.mock('../../lib/ipc', () => ({
  ipc: { invoke: vi.fn(() => new Promise(() => {})), on: vi.fn(() => () => {}) }
}))
const stored: Record<string, string> = {}
vi.stubGlobal('localStorage', {
  getItem: (k: string) => stored[k] ?? null,
  setItem: (k: string, v: string) => {
    stored[k] = v
  }
})

const { qk } = await import('../../lib/queries')
const { FleetScreen } = await import('./FleetScreen')
const { AppToolbar } = await import('../../components/AppToolbar')

const settings = {
  hasVastApiKey: true,
  maxActiveNodes: 4,
  spendCapPerHour: 10,
  noSpendCap: false
} as SettingsPublic

function withCache(seed: (qc: QueryClient) => void, ui: ReactNode): string {
  const qc = new QueryClient()
  qc.setQueryData(qk.settings, settings)
  seed(qc)
  return renderToStaticMarkup(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

function node(patch: Partial<NodeSnapshot>): NodeSnapshot {
  return {
    id: 'node-1-abcdef',
    instanceId: 777,
    state: 'rendering',
    gpuName: 'RTX 4090',
    numGpus: 2,
    dphTotal: 0.8,
    sshHost: '1.2.3.4',
    sshPort: 22,
    startedAt: null,
    accumulatedCost: 0,
    energyWh: 0,
    co2g: 0,
    geolocation: null,
    currentWork: [],
    slotsInUse: 0,
    slotTarget: 2,
    eeveeCapable: null,
    octaneReady: false,
    octaneNeedsManualLogin: false,
    blenderVersions: [],
    lastError: null,
    metrics: null,
    destroyedAt: null,
    ...patch
  }
}

beforeEach(() => {
  for (const k of Object.keys(stored)) delete stored[k]
})

describe('1.2: a node that may be billing is never out of sight', () => {
  it('lists a failed node whose destroy is unconfirmed even with "show failed" off', () => {
    stored['vr:fleet:showFailed'] = '0'
    const html = withCache(
      (qc) =>
        qc.setQueryData(qk.nodes, [
          node({ id: 'billing-failed', state: 'failed', gpuName: 'BILLING-GPU' }),
          node({ id: 'settled-failed', state: 'failed', instanceId: null, gpuName: 'GONE-GPU' })
        ]),
      <FleetScreen />
    )
    expect(html).toContain('BILLING-GPU')
    expect(html).not.toContain('GONE-GPU')
    expect(html).toContain('show failed (1)')
  })

  it('lists a destroyed node Vast has not confirmed gone, with its destroy still live', () => {
    const html = withCache(
      (qc) =>
        qc.setQueryData(qk.nodes, [
          node({ id: 'unconfirmed', state: 'destroyed', gpuName: 'UNCONFIRMED-GPU' }),
          node({ id: 'confirmed', state: 'destroyed', destroyedAt: 5, gpuName: 'GONE-FOR-SURE' })
        ]),
      <FleetScreen />
    )
    expect(html).toContain('UNCONFIRMED-GPU')
    expect(html).not.toContain('GONE-FOR-SURE')
    expect(html).toContain('may still be billing: destroy it again')
  })

  it("the toolbar counts it against max nodes, and bills its rate from the nodes' own facts", () => {
    const html = withCache(
      (qc) =>
        qc.setQueryData(qk.nodes, [
          node({ id: 'a', dphTotal: 0.5 }),
          node({ id: 'b', state: 'failed', dphTotal: 0.25 }),
          node({ id: 'c', state: 'destroyed', destroyedAt: 1, dphTotal: 9 })
        ]),
      <AppToolbar />
    )
    expect(html).toContain('>2 / 4<')
    // Before the first fleet:cost push, not $0.000/hr (#96).
    expect(html).toContain('$0.750/hr')
  })
})
