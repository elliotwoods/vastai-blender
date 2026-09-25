import { beforeEach, describe, expect, it } from 'vitest'
import type { ChunkProgressEvent } from '../../../shared/models'
import { NO_PROGRESS, useProgressStore } from './progressStore'

const sample = (over: Partial<ChunkProgressEvent> = {}): ChunkProgressEvent => ({
  chunkId: 'c1',
  jobId: 'j1',
  nodeId: 'n1',
  currentFrame: 12,
  framesDone: 2,
  framesTotal: 10,
  status: 'rendering',
  lastLine: 'Fra:12 Mem:512M | Sample 32/256',
  renderStatus: {
    frame: 12,
    memMb: 512,
    peakMemMb: null,
    elapsedS: null,
    remainingS: null,
    deviceMemMb: null,
    devicePeakMemMb: null,
    sample: 32,
    samples: 256,
    phase: 'Sample 32/256'
  },
  lastProgressAt: 1000,
  ...over
})

const state = (): ReturnType<typeof useProgressStore.getState> => useProgressStore.getState()

describe('progressStore', () => {
  beforeEach(() => useProgressStore.setState({ byChunk: {}, byJob: {} }))

  it('keeps the same record for a sample that says nothing new', () => {
    state().record(sample())
    const before = state()
    state().record(sample({ renderStatus: { ...sample().renderStatus! } }))
    expect(state().byChunk).toBe(before.byChunk)
    expect(state().byJob).toBe(before.byJob)
  })

  it('takes a new status line, render status, agent status or progress time', () => {
    state().record(sample())
    const changes: Array<Partial<ChunkProgressEvent>> = [
      { lastLine: 'Fra:12 Mem:512M | Sample 64/256' },
      { renderStatus: { ...sample().renderStatus!, sample: 64 } },
      { status: 'encoding' },
      { lastProgressAt: 2000 }
    ]
    for (const c of changes) {
      const before = state().byChunk.c1
      state().record(sample(c))
      expect(state().byChunk.c1).not.toBe(before)
      expect(state().byChunk.c1).toMatchObject(c)
    }
  })

  it('indexes records by job, and a job’s index only changes with its own chunks', () => {
    state().record(sample())
    state().record(sample({ chunkId: 'c2' }))
    state().record(sample({ chunkId: 'k1', jobId: 'j2' }))
    const j1 = state().byJob.j1
    expect(Object.keys(j1).sort()).toEqual(['c1', 'c2'])
    expect(j1.c1).toBe(state().byChunk.c1)

    state().record(sample({ chunkId: 'k1', jobId: 'j2', framesDone: 5 }))
    expect(state().byJob.j1).toBe(j1)

    state().forget('c1')
    expect(Object.keys(state().byJob.j1)).toEqual(['c2'])
    state().forget('c2')
    expect(state().byJob.j1).toBeUndefined()
    expect(state().byJob.j2.k1.framesDone).toBe(5)
    expect(NO_PROGRESS).toEqual({})
  })
})
