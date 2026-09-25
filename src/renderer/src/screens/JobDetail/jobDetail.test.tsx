import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { StateCreator, StoreApi, UseBoundStore } from 'zustand'
import type {
  ChunkSnapshot,
  ChunkState,
  JobDetail,
  JobSummary,
  NodeSnapshot,
  RenderStatus
} from '../../../../shared/models'

// The job detail view (TODO "Job detail view"), rendered from a seeded query
// cache and progress store with the IPC bridge stubbed, as the Fleet
// screen's test does: the node sharing switch says what on and off mean and
// when a change applies; the live panel shows Blender's own line; failed and
// cancelled chunks read apart; the jobs sidebar only on a wide window.

// A server render reads each zustand store's server snapshot, its initial
// state. These renders stand for the window, which reads a store as it is
// now, so the stores are made with the current state as both snapshots.
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
vi.mock('../../components/charts/useWidth', () => ({ useWidth: () => 900 }))
const media = vi.hoisted(() => ({ wide: false }))
vi.mock('../../lib/useMediaQuery', () => ({ useMediaQuery: () => media.wide }))

const { qk } = await import('../../lib/queries')
const { useProgressStore } = await import('../../lib/progressStore')
const { JobDetailScreen } = await import('./JobDetailScreen')
const { JobSettingsPanel } = await import('./JobSettingsPanel')
const { ChunkGrid } = await import('./ChunkGrid')
const model = await import('./jobDetailModel')

function chunk(
  id: string,
  state: ChunkState,
  frameStart: number,
  frameEnd: number,
  patch: Partial<ChunkSnapshot> = {}
): ChunkSnapshot {
  return {
    id,
    jobId: 'job-1',
    frameStart,
    frameEnd,
    state,
    nodeId: null,
    framesDone: 0,
    retries: 0,
    ...patch
  }
}

function summary(patch: Partial<JobSummary>): JobSummary {
  return {
    id: 'job-1',
    name: 'hero_shot',
    blendPath: '/scenes/hero_shot.blend',
    engine: 'cycles',
    frameStart: 1,
    frameEnd: 40,
    frameStep: 1,
    state: 'running',
    framesDone: 10,
    framesTotal: 40,
    framesCancelled: 0,
    costSoFar: 1.5,
    submittedAt: 1_000,
    outputDir: '/renders/job-1',
    blenderVersion: '4.5.3',
    shareNode: false,
    startedAt: 2_000,
    finishedAt: null,
    elapsedMs: 60_000,
    remainingMs: 120_000,
    etaAt: Date.now() + 120_000,
    framesPerHour: 600,
    timingBasis: 'live',
    timingAt: Date.now(),
    thumbUrl: null,
    queuePos: 1,
    groupId: null,
    hiddenAt: null,
    ...patch
  }
}

function detail(patch: Partial<JobDetail> = {}): JobDetail {
  return {
    ...summary({}),
    chunks: [
      chunk('c-1', 'complete', 1, 10, { framesDone: 10 }),
      chunk('c-2', 'rendering', 11, 20, { nodeId: 'node-a', framesDone: 2 }),
      chunk('c-3', 'pending', 21, 30),
      chunk('c-4', 'pending', 31, 40)
    ],
    addonIds: [],
    ...patch
  }
}

const node = {
  id: 'node-a',
  instanceId: 4242,
  gpuName: 'RTX 4090',
  currentWork: [{ chunkId: 'c-2', jobId: 'job-1', gpu: 1 }]
} as unknown as NodeSnapshot

function withCache(seed: (qc: QueryClient) => void, ui: ReactNode): string {
  const qc = new QueryClient()
  seed(qc)
  return renderToStaticMarkup(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

function screen(job: JobDetail, jobs: JobSummary[] = [job]): string {
  return withCache(
    (qc) => {
      qc.setQueryData(qk.job(job.id), job)
      qc.setQueryData(qk.jobs, jobs)
      qc.setQueryData(qk.nodes, [node])
    },
    <JobDetailScreen jobId={job.id} />
  )
}

const status: RenderStatus = {
  frame: 13,
  memMb: 1234,
  peakMemMb: 1400,
  elapsedS: 5,
  remainingS: 35,
  deviceMemMb: 8120,
  devicePeakMemMb: 8512,
  sample: 32,
  samples: 256,
  phase: 'Sample 32/256'
}
const LINE =
  'Fra:13 Mem:1234.00M (Peak 1400.00M) | Time:00:05.00 | Remaining:00:35.00 | Sample 32/256'

describe('node sharing, in the settings', () => {
  it('is a labelled switch saying what off and on mean, and that it applies to chunks not yet started', () => {
    const html = renderToStaticMarkup(
      <JobSettingsPanel job={detail()} onShareChange={() => {}} onUngroup={() => {}} />
    )
    expect(html).toContain('role="switch"')
    expect(html).toContain('aria-checked="false"')
    expect(html).toContain(`aria-label="${model.SHARE_COPY.label}"`)
    expect(html).toContain('Off: each chunk has its node to itself')
    expect(html).toContain('On: chunks may render side by side')
    expect(html).toContain('Applies to chunks not yet started')
    expect(html).toContain('Chunks already rendering keep their placement')
  })

  it('shows the switch on for a sharing job', () => {
    const html = renderToStaticMarkup(
      <JobSettingsPanel
        job={detail({ shareNode: true })}
        onShareChange={() => {}}
        onUngroup={() => {}}
      />
    )
    expect(html).toContain('aria-checked="true"')
  })

  it('lists the job’s setup, and its group with an ungroup button while it is queued', () => {
    const job = detail({ groupId: 'g1', frameStep: 2 })
    const html = renderToStaticMarkup(
      <JobSettingsPanel
        job={job}
        jobs={[job, summary({ id: 'job-2', name: 'crowd_b', groupId: 'g1' })]}
        queue={[{ position: 3, groupId: 'g1', jobIds: ['job-1', 'job-2'] }]}
        onShareChange={() => {}}
        onUngroup={() => {}}
      />
    )
    expect(html).toContain('cycles')
    expect(html).toContain('4.5.3')
    expect(html).toContain('hero_shot.blend')
    expect(html).toContain('/renders/job-1')
    expect(html).toContain('#3')
    expect(html).toContain('grouped with crowd_b')
    expect(html).toContain('ungroup')
    // chunk size: the largest chunk, at the job's step
    expect(html).toContain('5 frames')
  })
})

describe('the live panel', () => {
  it('shows Blender’s last line and its parsed status for a rendering chunk', () => {
    useProgressStore.getState().record({
      chunkId: 'c-2',
      jobId: 'job-1',
      nodeId: 'node-a',
      currentFrame: 13,
      framesDone: 2,
      framesTotal: 10,
      status: 'rendering',
      lastLine: LINE,
      renderStatus: status,
      lastProgressAt: Date.now() - 2_000,
      avgFrameS: 40
    })
    const html = screen(detail())
    expect(html).toContain('1 node working · 1 chunk active')
    expect(html).toContain(LINE.replace(/'/g, '&#x27;'))
    expect(html).toContain('sample')
    expect(html).toContain('32/256')
    expect(html).toContain('RTX 4090 #4242')
    expect(html).toContain('GPU 1')
    expect(html).not.toContain('data-stale')
    useProgressStore.getState().forget('c-2')
  })

  it('marks a chunk stale once its node has said nothing new for 30 s', () => {
    useProgressStore.getState().record({
      chunkId: 'c-2',
      jobId: 'job-1',
      nodeId: 'node-a',
      currentFrame: 13,
      framesDone: 2,
      framesTotal: 10,
      lastLine: LINE,
      renderStatus: status,
      lastProgressAt: Date.now() - 47_000
    })
    const html = screen(detail())
    expect(html).toContain('data-stale="true"')
    expect(html).toContain('no progress for 47s')
    useProgressStore.getState().forget('c-2')
  })

  it('is not there once nothing is rendering', () => {
    const html = screen(
      detail({
        state: 'complete',
        chunks: [chunk('c-1', 'complete', 1, 40, { framesDone: 40 })]
      })
    )
    expect(html).not.toContain('rendering now')
    expect(html).not.toContain('chunks active')
  })
})

describe('failed and cancelled chunks', () => {
  const chunks = [
    chunk('c-1', 'complete', 1, 10, { framesDone: 10 }),
    chunk('c-2', 'failed', 11, 20, {
      framesDone: 3,
      retries: 4,
      errorClass: 'job',
      lastError: 'blender exited with code 1 (out of GPU memory)'
    }),
    chunk('c-3', 'cancelled', 21, 30, { framesDone: 2 })
  ]

  it('read apart: failed marked "!", cancelled "–", each named', () => {
    const full = renderToStaticMarkup(<ChunkGrid chunks={chunks} step={1} />)
    // the cells, without the legend under them
    const html = full.slice(0, full.indexOf('aria-label="chunk states"'))
    const cell = (state: string): string => {
      const at = html.indexOf(`data-chunk-state="${state}"`)
      expect(at).toBeGreaterThan(-1)
      const next = html.indexOf('data-chunk-state=', at + 1)
      return html.slice(at, next < 0 ? undefined : next)
    }
    expect(cell('failed')).toContain('>!<')
    expect(cell('failed')).toContain('failed · retry 4')
    expect(cell('cancelled')).toContain('>–<')
    expect(cell('cancelled')).toContain('vr-progress-hatch')
    expect(cell('cancelled')).not.toContain('>!<')
  })

  it('carry the last error and its kind in the tooltip', () => {
    const html = renderToStaticMarkup(<ChunkGrid chunks={chunks} step={1} />)
    expect(html).toContain(
      'last error (the scene or Blender): blender exited with code 1 (out of GPU memory)'
    )
    expect(html).toContain('Stopped by a cancel before it finished')
  })

  it('are explained by a legend under the grid', () => {
    const html = renderToStaticMarkup(<ChunkGrid chunks={chunks} step={1} />)
    expect(html).toContain('aria-label="chunk states"')
    for (const word of ['queued', 'rendering', 'complete', 'failed', 'cancelled']) {
      expect(html).toContain(word)
    }
  })

  it('are counted apart in the summary', () => {
    const html = screen(detail({ state: 'cancelled', chunks }))
    expect(html).toMatch(/data-count="complete"[^>]*>.*?>1</)
    expect(html).toMatch(/data-count="failed"[^>]*>.*?>1</)
    expect(html).toMatch(/data-count="cancelled"[^>]*>.*?>1</)
  })
})

describe('the jobs sidebar', () => {
  const jobs = [
    summary({ id: 'job-1', name: 'hero_shot' }),
    summary({ id: 'job-2', name: 'crowd_b', queuePos: 2 })
  ]

  it('is hidden when the window is narrower than 1280 px', () => {
    media.wide = false
    const html = screen(detail(), jobs)
    expect(html).not.toContain('aria-label="jobs"')
    expect(html).not.toContain('crowd_b')
  })

  it('lists every job on a wide window, the current one marked', () => {
    media.wide = true
    const html = screen(detail(), jobs)
    media.wide = false
    expect(html).toContain('aria-label="jobs"')
    expect(html).toContain('crowd_b')
    expect(html).toMatch(/aria-current="page"[^>]*title="hero_shot · running"/)
  })
})

describe('jobDetailModel', () => {
  it('orders the sidebar as the queue, then finished jobs newest first', () => {
    const order = model.sidebarOrder([
      summary({ id: 'done-old', state: 'complete', finishedAt: 10 }),
      summary({ id: 'q2', state: 'queued', queuePos: 2 }),
      summary({ id: 'done-new', state: 'cancelled', finishedAt: 20 }),
      summary({ id: 'q1', state: 'running', queuePos: 1 }),
      summary({ id: 'hidden', state: 'complete', finishedAt: 30, hiddenAt: 5 })
    ])
    expect(order.map((j) => j.id)).toEqual(['q1', 'q2', 'done-new', 'done-old'])
  })

  it('hops to the neighbouring job, and nowhere past either end', () => {
    const order = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    expect(model.neighbourJob(order, 'b', 1)).toBe('c')
    expect(model.neighbourJob(order, 'b', -1)).toBe('a')
    expect(model.neighbourJob(order, 'c', 1)).toBeNull()
    expect(model.neighbourJob(order, 'a', -1)).toBeNull()
  })

  it('calls a chunk stale after 30 s without progress, never when it never said', () => {
    expect(model.isStale(1_000, 1_000 + 30_001)).toBe(true)
    expect(model.isStale(1_000, 1_000 + 29_000)).toBe(false)
    expect(model.isStale(null, 1e12)).toBe(false)
  })

  it('reads Blender’s status as short pairs', () => {
    expect(model.statusParts(status)).toEqual([
      ['sample', '32/256'],
      ['VRAM', '7.9 GB (peak 8.3 GB)'],
      ['mem', '1.2 GB (peak 1.4 GB)'],
      ['frame time', '0:05'],
      ['left on frame', '0:35']
    ])
    expect(model.phaseOf(status)).toBe('sampling')
    expect(model.statusParts(null)).toEqual([])
  })

  it('remembers a flag, and survives storage that throws', () => {
    const stored: Record<string, string> = {}
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => stored[k] ?? null,
      setItem: (k: string, v: string) => {
        stored[k] = v
      }
    })
    expect(model.readFlag(model.SIDEBAR_KEY, true)).toBe(true)
    model.writeFlag(model.SIDEBAR_KEY, false)
    expect(model.readFlag(model.SIDEBAR_KEY, true)).toBe(false)
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      }
    })
    expect(model.readFlag(model.SIDEBAR_KEY, true)).toBe(true)
    expect(() => model.writeFlag(model.SIDEBAR_KEY, true)).not.toThrow()
    vi.unstubAllGlobals()
  })
})
