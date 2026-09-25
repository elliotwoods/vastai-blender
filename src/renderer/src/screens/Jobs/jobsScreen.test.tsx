import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { StateCreator, StoreApi, UseBoundStore } from 'zustand'
import type { JobSummary, SettingsPublic } from '../../../../shared/models'

// The Jobs list rendered from a seeded query cache with the IPC bridge
// stubbed, as fleetScreen.test.tsx does: the queue on top with its grips, a
// group as one block, each row's thumbnail and time, and a trash that
// cancels a live job but only unlists a finished one.

// Server rendering reads each zustand store's initial state; use the current.
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
vi.mock('../../components/charts/useWidth', () => ({ useWidth: () => 640 }))
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} })

const { qk } = await import('../../lib/queries')
const { JobsScreen } = await import('./JobsScreen')

const NOW = Date.now()

function job(patch: Partial<JobSummary> & { id: string }): JobSummary {
  return {
    name: patch.id,
    blendPath: `C:/scenes/${patch.id}.blend`,
    engine: 'cycles',
    frameStart: 1,
    frameEnd: 100,
    frameStep: 1,
    state: 'queued',
    framesDone: 0,
    framesTotal: 100,
    framesCancelled: 0,
    costSoFar: 0,
    submittedAt: NOW - 3_600_000,
    outputDir: `C:/renders/${patch.id}`,
    blenderVersion: '4.5.3',
    shareNode: false,
    startedAt: null,
    finishedAt: null,
    elapsedMs: null,
    remainingMs: null,
    etaAt: null,
    framesPerHour: null,
    timingBasis: 'none',
    timingAt: NOW,
    thumbUrl: null,
    queuePos: null,
    groupId: null,
    hiddenAt: null,
    ...patch
  }
}

const jobs: JobSummary[] = [
  job({
    id: 'run-a',
    state: 'running',
    queuePos: 1,
    groupId: 'g1',
    framesDone: 40,
    startedAt: NOW - 1_800_000,
    elapsedMs: 1_800_000,
    remainingMs: 2_700_000,
    etaAt: NOW + 2_700_000,
    framesPerHour: 80,
    timingBasis: 'downloads',
    thumbUrl: 'media://job/run-a/thumb/40.jpg'
  }),
  job({ id: 'run-b', state: 'queued', queuePos: 1, groupId: 'g1' }),
  job({ id: 'wait-c', state: 'queued', queuePos: 2 }),
  job({
    id: 'done-d',
    state: 'complete',
    queuePos: 3,
    framesDone: 100,
    startedAt: NOW - 7_200_000,
    finishedAt: NOW - 3_600_000,
    elapsedMs: 3_600_000,
    remainingMs: 0,
    etaAt: NOW - 3_600_000,
    thumbUrl: 'media://job/done-d/thumb/100.jpg'
  }),
  job({
    id: 'stop-e',
    state: 'cancelled',
    queuePos: 4,
    framesDone: 10,
    framesCancelled: 90,
    startedAt: NOW - 9_000_000,
    finishedAt: NOW - 8_000_000,
    elapsedMs: 1_000_000
  })
]

function render(list: JobSummary[]): string {
  const qc = new QueryClient()
  qc.setQueryData(qk.settings, { hasVastApiKey: true } as SettingsPublic)
  qc.setQueryData(qk.jobs, list)
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <JobsScreen />
    </QueryClientProvider>
  )
}

/** The markup of one job's row, from its opening tag to the next row's. */
function rowOf(html: string, id: string): string {
  const start = html.indexOf(`data-job-row="${id}"`)
  expect(start).toBeGreaterThanOrEqual(0)
  const next = html.indexOf('data-job-row="', start + 1)
  return html.slice(start, next < 0 ? undefined : next)
}

describe('JobsScreen', () => {
  const html = render(jobs)

  it('lists the queue in order, group together, then the finished newest first', () => {
    const order = [...html.matchAll(/data-job-row="([^"]+)"/g)].map((m) => m[1])
    expect(order).toEqual(['run-a', 'run-b', 'wait-c', 'done-d', 'stop-e'])
  })

  it('shows each job’s latest frame as a thumbnail', () => {
    expect(rowOf(html, 'run-a')).toContain('src="media://job/run-a/thumb/40.jpg"')
    expect(rowOf(html, 'done-d')).toContain('src="media://job/done-d/thumb/100.jpg"')
    expect(rowOf(html, 'wait-c')).not.toContain('<img')
  })

  it('says how long a job has run, has left and when it will be done', () => {
    const running = rowOf(html, 'run-a')
    expect(running).toContain('data-timing="running"')
    expect(running).toContain('elapsed')
    expect(running).toContain('left')
    expect(running).toContain('ETA')
    const done = rowOf(html, 'done-d')
    expect(done).toContain('data-timing="finished"')
    expect(done).toContain('took')
    expect(rowOf(html, 'wait-c')).toContain('queued')
  })

  it('draws a group as one block, with an unlink per member', () => {
    const start = html.indexOf('data-group-block="g1"')
    expect(start).toBeGreaterThanOrEqual(0)
    const block = html.slice(start, html.indexOf('data-job-row="wait-c"'))
    expect(block).toContain('shared priority · 2 jobs')
    expect(block).toContain('data-job-row="run-a"')
    expect(block).toContain('data-job-row="run-b"')
    expect(block.match(/out of its group/g)).toHaveLength(2)
    expect(rowOf(html, 'wait-c')).not.toContain('out of its group')
  })

  it('cancels a live job from its trash, but only unlists a finished one', () => {
    expect(rowOf(html, 'wait-c')).toContain('aria-label="cancel job"')
    expect(rowOf(html, 'run-a')).toContain('aria-label="cancel job"')
    const done = rowOf(html, 'done-d')
    expect(done).toContain('aria-label="remove from list"')
    expect(done).toContain('rendered files are kept on disk')
    expect(done).not.toContain('cancel job')
  })

  it('has a grip on queued and running rows only', () => {
    expect(rowOf(html, 'run-a')).toContain('data-grip')
    expect(rowOf(html, 'wait-c')).toContain('data-grip')
    expect(rowOf(html, 'done-d')).not.toContain('data-grip')
    expect(rowOf(html, 'stop-e')).not.toContain('data-grip')
  })

  it('greys a cancelled job’s stopped frames on its bar', () => {
    const stopped = rowOf(html, 'stop-e')
    expect(stopped).toContain('data-state="cancelled"')
    expect(stopped).toContain('data-part="cancelled"')
    expect(stopped).toContain('data-state-chip="cancelled"')
  })

  it('says so when there are no jobs', () => {
    expect(render([])).toContain('No render jobs yet.')
  })
})
