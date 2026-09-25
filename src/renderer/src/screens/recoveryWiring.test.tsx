import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { JobDetail, NodeSnapshot, SettingsPublic } from '../../../shared/models'

// The screens themselves use the asking buttons (audit D4, plan 1.15): the
// Fleet's destroy and reprovision, JobDetail's cancel and "Re-render
// missing". Rendered
// from a seeded query cache, with the IPC bridge stubbed (it is
// window.api, which a test has no window for). A ConfirmButton's resting
// label sits in an aria-live span; the plain buttons these replaced had
// none, and fired on the first click.

vi.mock('../lib/ipc', () => ({
  ipc: { invoke: vi.fn(() => new Promise(() => {})), on: vi.fn(() => () => {}) }
}))
// The Fleet's "show failed" preference; Node's own localStorage wants a file.
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} })

const { qk } = await import('../lib/queries')
const { FleetScreen } = await import('./Fleet/FleetScreen')
const { NodeDetail } = await import('./Fleet/NodeDetail')
const { JobDetailScreen } = await import('./JobDetail/JobDetailScreen')

function withCache(seed: (qc: QueryClient) => void, ui: ReactNode): string {
  const qc = new QueryClient()
  qc.setQueryData(qk.settings, { hasVastApiKey: true, maxActiveNodes: 1 } as SettingsPublic)
  seed(qc)
  return renderToStaticMarkup(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

const node = {
  id: 'node-1-abcdef',
  instanceId: 777,
  state: 'rendering',
  gpuName: 'RTX 4090',
  numGpus: 1,
  dphTotal: 0.4,
  sshHost: '1.2.3.4',
  sshPort: 22,
  startedAt: null,
  accumulatedCost: 0,
  energyWh: 0,
  co2g: 0,
  geolocation: null,
  currentWork: [],
  slotsInUse: 0,
  slotTarget: 1,
  eeveeCapable: null,
  octaneReady: false,
  octaneNeedsManualLogin: false,
  blenderVersions: [],
  lastError: null,
  metrics: null
} satisfies NodeSnapshot

function job(patch: Partial<JobDetail>): JobDetail {
  return {
    id: 'job-1',
    name: 'shot',
    blendPath: '/scenes/shot.blend',
    engine: 'cycles',
    frameStart: 1,
    frameEnd: 8,
    frameStep: 1,
    state: 'running',
    framesDone: 5,
    framesTotal: 8,
    costSoFar: 0,
    submittedAt: 0,
    outputDir: '/renders/job-1',
    blenderVersion: null,
    shareNode: false,
    chunks: [],
    addonIds: [],
    ...patch
  }
}

const chunk = {
  id: 'c1',
  jobId: 'job-1',
  frameStart: 1,
  frameEnd: 8,
  nodeId: null,
  framesDone: 0,
  retries: 0
}

describe('screens ask before they destroy, cancel or re-render', () => {
  it("the Fleet: a node row's destroy", () => {
    const html = withCache((qc) => qc.setQueryData(qk.nodes, [node]), <FleetScreen />)
    expect(html).toContain('<span aria-live="polite">destroy</span>')
  })

  it("1.15: the Fleet's node panel: reprovision", () => {
    const html = withCache(() => {}, <NodeDetail node={node} />)
    expect(html).toContain('<span aria-live="polite">reprovision</span>')
  })

  it("JobDetail: a running job's cancel", () => {
    const html = withCache(
      (qc) => qc.setQueryData(qk.job('job-1'), job({ chunks: [{ ...chunk, state: 'rendering' }] })),
      <JobDetailScreen jobId="job-1" />
    )
    expect(html).toContain('<span aria-live="polite">cancel</span>')
  })

  it('1.15: JobDetail offers a partial job "Re-render missing (N frames)"', () => {
    const html = withCache(
      (qc) =>
        qc.setQueryData(
          qk.job('job-1'),
          job({ state: 'partial', chunks: [{ ...chunk, state: 'failed' }] })
        ),
      <JobDetailScreen jobId="job-1" />
    )
    expect(html).toContain('<span aria-live="polite">re-render missing (3 frames)</span>')
  })
})
