import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StateCreator, StoreApi, UseBoundStore } from 'zustand'
import type {
  FleetGpuHistory,
  NodeSnapshot,
  SettingsPublic,
  UnclaimedInstance
} from '../../../../shared/models'

// The Fleet as Phase 1 wires it, rendered from a seeded query cache and
// metrics store with the IPC bridge stubbed (window.api, which a test has no
// window for), as recoveryWiring.test.tsx does:
// - 1.2: a node that may still be billing is always listed, and counted;
// - 1.3: instances nobody here holds are listed with their rate, destroy asks;
// - 1.20: the toolbar's balance turns amber and red by runway, not at $5;
// - 1.5: "+ request node" at the spend cap asks before going past it;
// - 1.18: a node waiting for an Octane sign-in offers the VNC login;
// - Feature G: the GPU strip, each row's sparkline, NodeDetail's charts.

// A server render reads each zustand store's server snapshot, its initial
// state: empty. These renders stand for the window, which reads a store as
// it is now, the metrics seeded below. So the app's stores are made here
// with the current state as both snapshots.
vi.mock('zustand', async (importOriginal) => {
  const zustand = await importOriginal<typeof import('zustand')>()
  const { createStore } = await import('zustand/vanilla')
  const { useSyncExternalStore } = await import('react')
  function create<T>(init: StateCreator<T, [], []>): UseBoundStore<StoreApi<T>> {
    const api = createStore<T>()(init)
    function useBoundStore<U>(selector: (s: T) => U = (s) => s as unknown as U): U {
      return useSyncExternalStore(
        api.subscribe,
        () => selector(api.getState()),
        () => selector(api.getState())
      )
    }
    return Object.assign(useBoundStore, api) as UseBoundStore<StoreApi<T>>
  }
  return { ...zustand, create }
})
vi.mock('../../lib/ipc', () => ({
  ipc: { invoke: vi.fn(() => new Promise(() => {})), on: vi.fn(() => () => {}) }
}))
// Server rendering never runs the ResizeObserver; give the charts a width.
vi.mock('../../components/charts/useWidth', () => ({ useWidth: () => 640 }))
const stored: Record<string, string> = {}
vi.stubGlobal('localStorage', {
  getItem: (k: string) => stored[k] ?? null,
  setItem: (k: string, v: string) => {
    stored[k] = v
  }
})

const { qk } = await import('../../lib/queries')
const { useMetricsStore } = await import('../../lib/metricsStore')
type MetricsReading = import('../../lib/metricsStore').MetricsReading
const { FleetScreen } = await import('./FleetScreen')
const { NodeDetail } = await import('./NodeDetail')
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

const unclaimed = (patch: Partial<UnclaimedInstance>): UnclaimedInstance => ({
  instanceId: 4242,
  label: 'vastai-blender deadbeef:12345678',
  owner: 'otherVastRender',
  gpuName: 'RTX 3090',
  numGpus: 1,
  dphTotal: 0.25,
  status: 'running',
  startedAt: null,
  firstSeenAt: 0,
  destroyError: null,
  ...patch
})

const seedStore = (state: Partial<ReturnType<typeof useMetricsStore.getState>>): void =>
  useMetricsStore.setState(state)

beforeEach(() => {
  for (const k of Object.keys(stored)) delete stored[k]
  useMetricsStore.setState({ byNode: {}, seeds: {} })
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

describe('1.3: unclaimed instances', () => {
  it('lists each with its rate and a destroy that asks, and what they bill together', () => {
    const html = withCache(
      (qc) => {
        qc.setQueryData(qk.nodes, [])
        qc.setQueryData(qk.unclaimed, [
          unclaimed({}),
          unclaimed({
            instanceId: 99,
            owner: 'unlabelled',
            label: null,
            dphTotal: 1.5,
            status: 'exited'
          })
        ])
      },
      <FleetScreen />
    )
    expect(html).toContain('unclaimed instances')
    expect(html).toContain('#4242')
    expect(html).toContain('another Vast Render')
    expect(html).toContain('not Vast Render')
    // The exited one bills its storage only.
    expect(html).toContain('billing <span')
    expect(html).toContain('$0.250/hr</span>')
    expect(html.match(/<span aria-live="polite">destroy<\/span>/g)).toHaveLength(2)
  })

  it('shows nothing when every instance is held', () => {
    const html = withCache(
      (qc) => {
        qc.setQueryData(qk.nodes, [])
        qc.setQueryData(qk.unclaimed, [])
      },
      <FleetScreen />
    )
    expect(html).not.toContain('unclaimed instances')
  })
})

describe('1.20: the balance reads as a runway, not against a fixed $5', () => {
  const balance = (html: string): string | undefined =>
    html.match(/balance<\/span><span style="[^"]*color:([^;"]+)[^"]*">\$/)?.[1]

  it('warns where main holds renting: $1 at $8/hr is under 10 minutes', () => {
    const html = withCache(
      (qc) => {
        qc.setQueryData(qk.nodes, [node({ dphTotal: 8 })])
        qc.setQueryData(qk.fleetCost, {
          perHour: 8,
          sessionTotal: 0,
          sessionWh: 0,
          sessionCo2g: 0,
          balance: 1
        })
      },
      <AppToolbar />
    )
    expect(balance(html)).toBe('var(--danger)')
  })

  it('counts the other instances on the account: $3 lasts 20 minutes, not 45', () => {
    const html = withCache(
      (qc) => {
        qc.setQueryData(qk.nodes, [node({ dphTotal: 4 })])
        qc.setQueryData(qk.unclaimed, [unclaimed({ dphTotal: 5 })])
        qc.setQueryData(qk.fleetCost, {
          perHour: 4,
          sessionTotal: 0,
          sessionWh: 0,
          sessionCo2g: 0,
          balance: 3
        })
      },
      <AppToolbar />
    )
    expect(balance(html)).toBe('var(--warn)')
  })

  it('stays quiet for a small balance that lasts: $4 with nothing billing', () => {
    const html = withCache(
      (qc) => {
        qc.setQueryData(qk.nodes, [])
        qc.setQueryData(qk.fleetCost, {
          perHour: 0,
          sessionTotal: 0,
          sessionWh: 0,
          sessionCo2g: 0,
          balance: 4
        })
      },
      <AppToolbar />
    )
    expect(balance(html)).toBe('var(--text)')
  })
})

describe('1.5: a manual rental at the spend cap asks first', () => {
  it('asks, naming the cap, once the fleet bills all of it', () => {
    const html = withCache(
      (qc) => qc.setQueryData(qk.nodes, [node({ dphTotal: 10 })]),
      <FleetScreen />
    )
    expect(html).toContain('<span aria-live="polite">+ request node</span>')
    expect(html).toContain('bills $10.000/hr of its $10.000/hr spend cap')
  })

  it('rents at one click under the cap', () => {
    const html = withCache((qc) => qc.setQueryData(qk.nodes, [node({})]), <FleetScreen />)
    expect(html).toContain('>+ request node</button>')
    expect(html).not.toContain('<span aria-live="polite">+ request node</span>')
  })
})

describe('1.18: Octane sign-in by hand', () => {
  it('offers the VNC login on a node waiting for a sign-in', () => {
    const html = withCache(() => {}, <NodeDetail node={node({ octaneState: 'needsLogin' })} />)
    expect(html).toContain('Open VNC login')
    expect(html).toContain('octane sign-in needed')
  })

  it('offers nothing on a licensed node, and never opens a tunnel by itself', async () => {
    const { ipc } = await import('../../lib/ipc')
    const html = withCache(() => {}, <NodeDetail node={node({ octaneState: 'licensed' })} />)
    expect(html).not.toContain('Open VNC login')
    expect(vi.mocked(ipc.invoke).mock.calls.some(([c]) => c === 'node:openVncTunnel')).toBe(false)
  })
})

describe('Feature G: GPU use over time', () => {
  const now = Date.now()
  const reading = (ts: number, utils: number[], runs: number[]): MetricsReading => ({
    ts,
    gpus: utils.map((util, index) => ({ index, util, vramPct: 40, runs: runs[index] })),
    powerW: 600
  })

  it("each row has its node's 30-minute GPU sparkline beside the meter", () => {
    seedStore({
      byNode: {
        'node-1-abcdef': [
          reading(now - 60_000, [90, 10], [1, 1]),
          reading(now - 45_000, [80, 20], [1, 1])
        ]
      },
      seeds: { 'node-1-abcdef': 'done' }
    })
    const html = withCache((qc) => qc.setQueryData(qk.nodes, [node({})]), <FleetScreen />)
    expect(html).toContain('aria-label="GPU util, 30 min: mean 50%, low 10%, high 90%"')
  })

  it('the fleet strip plots GPUs busy against rented, with the latest figures', () => {
    const history: FleetGpuHistory = {
      fromMs: now - 3_600_000,
      toMs: now,
      bucketMs: 30_000,
      points: [
        { ts: now - 90_000, gpusRented: 24, gpusBusy: 20, meanUtil: 70, idlePerHour: 1.1 },
        { ts: now - 60_000, gpusRented: 24, gpusBusy: 17, meanUtil: 61, idlePerHour: 2.4 }
      ]
    }
    const html = withCache(
      (qc) => {
        qc.setQueryData(qk.nodes, [node({})])
        qc.setQueryData(qk.fleetGpuHistory('1h'), history)
      },
      <FleetScreen />
    )
    expect(html).toContain('gpu use')
    expect(html).toContain('17 / 24')
    expect(html).toContain('61%')
    expect(html).toContain('$2.400/hr')
    expect(html).toContain('rented')
    expect(html).toContain('busy')
  })

  it("NodeDetail draws each GPU's line and shades one idle with work assigned (81fe2875)", () => {
    seedStore({
      byNode: {
        'node-1-abcdef': [
          reading(now - 60_000, [95, 2], [1, 1]),
          reading(now - 45_000, [96, 3], [1, 1]),
          reading(now - 30_000, [97, 1], [1, 1])
        ]
      },
      seeds: { 'node-1-abcdef': 'done' }
    })
    const html = withCache(() => {}, <NodeDetail node={node({})} />)
    expect(html).toContain('gpu utilisation %')
    expect(html).toContain('GPU 0')
    expect(html).toContain('GPU 1')
    expect(html).toContain('idle with work assigned')
    expect(html).toContain('vram used %')
    expect(html).toContain('gpu power, all cards')
  })
})
