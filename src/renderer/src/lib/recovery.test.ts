import { describe, expect, it } from 'vitest'
import type { ChunkSnapshot, ChunkState, JobDetail } from '../../../shared/models'
import {
  canDestroy,
  canReprovision,
  canResume,
  describeResume,
  describeReprovision,
  describeRetry,
  ipcErrorText,
  retryMissingOffer
} from './recovery'

// When the recovery actions (plan 1.15) are offered, and what they say:
// never for something main refuses, and the count is what main queues.

function chunk(state: ChunkState, frameStart = 1, frameEnd = 4): ChunkSnapshot {
  return {
    id: `c-${frameStart}-${frameEnd}`,
    jobId: 'job-1',
    frameStart,
    frameEnd,
    state,
    nodeId: null,
    framesDone: 0,
    retries: 0
  }
}

function job(patch: Partial<JobDetail>): JobDetail {
  return {
    id: 'job-1',
    name: 'shot',
    blendPath: '/scenes/shot.blend',
    engine: 'cycles',
    frameStart: 1,
    frameEnd: 8,
    frameStep: 1,
    state: 'partial',
    framesDone: 5,
    framesTotal: 8,
    costSoFar: 0,
    submittedAt: 0,
    outputDir: '/renders/job-1',
    blenderVersion: null,
    shareNode: false,
    chunks: [chunk('complete', 1, 4), chunk('failed', 5, 8)],
    addonIds: [],
    ...patch
  }
}

describe('retryMissingOffer', () => {
  it('1.15: a partial job offers its missing frames, counted', () => {
    expect(retryMissingOffer(job({}))).toMatchObject({
      label: 're-render missing (3 frames)',
      confirmLabel: 're-render and pay for it?'
    })
    expect(retryMissingOffer(job({ framesDone: 7 }))?.label).toBe('re-render missing (1 frame)')
  })

  it('a job whose chunks are all complete but with frames missing offers them too', () => {
    // refreshJobState calls it partial; main reopens those chunks.
    const j = job({ chunks: [chunk('complete', 1, 4), chunk('complete', 5, 8)], framesDone: 6 })
    expect(retryMissingOffer(j)?.label).toBe('re-render missing (2 frames)')
  })

  it('a cancelled job offers what it is missing', () => {
    const j = job({ state: 'cancelled', chunks: [chunk('failed', 1, 8)], framesDone: 2 })
    expect(retryMissingOffer(j)?.label).toBe('re-render missing (6 frames)')
  })

  it('a running job with failed chunks counts the chunks: which frames the live ones cover is main’s', () => {
    const j = job({
      state: 'running',
      chunks: [chunk('failed', 1, 4), chunk('rendering', 5, 8), chunk('failed', 9, 12)]
    })
    expect(retryMissingOffer(j)?.label).toBe('re-render missing (2 failed chunks)')
  })

  it('nothing to offer: complete, only live work, or failed outright (main refuses it)', () => {
    expect(retryMissingOffer(job({ state: 'complete', framesDone: 8 }))).toBeNull()
    expect(
      retryMissingOffer(job({ state: 'running', chunks: [chunk('rendering'), chunk('pending')] }))
    ).toBeNull()
    expect(retryMissingOffer(job({ state: 'failed' }))).toBeNull()
  })

  it('a held job says the re-render releases the hold', () => {
    const offer = retryMissingOffer(
      job({
        state: 'running',
        chunks: [chunk('failed'), chunk('pending', 5, 8)],
        attention: { kind: 'repeatedFailure', message: 'the same failure on 2 nodes', since: 1 }
      })
    )
    expect(offer?.confirmLabel).toBe('resume the held job and re-render?')
    expect(offer?.title).toMatch(/releases the hold/)
  })
})

describe('describeRetry', () => {
  it('says what was queued', () => {
    expect(describeRetry({ frames: 5, chunks: 2 })).toBe('5 frames queued again in 2 chunks')
    expect(describeRetry({ frames: 1, chunks: 1 })).toBe('1 frame queued again in 1 chunk')
    expect(describeRetry({ frames: 0, chunks: 0 })).toBe('nothing was missing')
    // The contract still allows the old stub's void.
    expect(describeRetry(undefined)).toBe('nothing was missing')
  })
})

describe('node actions', () => {
  it('reprovision only a node that is up and reachable, as main does', () => {
    for (const state of ['ready', 'idle', 'rendering', 'encoding'] as const) {
      expect(canReprovision({ state, sshHost: '1.2.3.4' }), state).toBe(true)
    }
    for (const state of [
      'requested',
      'provisioning',
      'unreachable',
      'failed',
      'destroying'
    ] as const) {
      expect(canReprovision({ state, sshHost: '1.2.3.4' }), state).toBe(false)
    }
    expect(canReprovision({ state: 'ready', sshHost: null })).toBe(false)
  })

  it('no second destroy while one is under way (#113)', () => {
    expect(canDestroy({ state: 'rendering' })).toBe(true)
    expect(canDestroy({ state: 'failed' })).toBe(true)
    expect(canDestroy({ state: 'destroying' })).toBe(false)
  })

  it('offers destroy for a destroyed row Vast has not confirmed gone, which the Fleet lists as billing', () => {
    // A DELETE can answer 200 and leave the instance running (#140): until
    // destroyedAt is stamped the row may be billing, and main destroys it
    // again on request.
    expect(canDestroy({ state: 'destroyed', instanceId: 42, destroyedAt: null })).toBe(true)
    expect(canDestroy({ state: 'destroyed', instanceId: 42, destroyedAt: 1_000 })).toBe(false)
    // Destroyed while its create was out with no answer: whatever it made may bill.
    expect(canDestroy({ state: 'destroyed', instanceId: null, createUnknownSince: 5 })).toBe(true)
    expect(canDestroy({ state: 'destroyed', instanceId: null })).toBe(false)
  })

  it('1.17: offers resume only for a job the breaker held and that is still live', () => {
    const held = { kind: 'repeatedFailure' as const, message: 'm', since: 1 }
    expect(canResume({ state: 'running', attention: held })).toBe(true)
    expect(canResume({ state: 'queued', attention: held })).toBe(true)
    expect(canResume({ state: 'failed', attention: { ...held, kind: 'engine' } })).toBe(false)
    expect(canResume({ state: 'cancelled', attention: held })).toBe(false)
    expect(canResume({ state: 'running', attention: null })).toBe(false)
    expect(describeResume(true)).toBe('resumed: its chunks go out again')
    expect(describeResume(false)).toBe('the job was not held')
  })

  it('describes a reprovision', () => {
    expect(describeReprovision({ requeued: 2 })).toBe('agent restarted; 2 chunks back in the queue')
    expect(describeReprovision({ requeued: 0 })).toBe('agent restarted')
  })
})

describe('ipcErrorText', () => {
  it("drops Electron's prefix, keeping main's words", () => {
    expect(
      ipcErrorText(
        new Error(
          "Error invoking remote method 'job:retryMissing': NotRevivable: job shot failed outright"
        )
      )
    ).toBe('job shot failed outright')
    expect(
      ipcErrorText(new Error("Error invoking remote method 'node:reprovision': Error: no node x"))
    ).toBe('no node x')
    expect(ipcErrorText('plain')).toBe('plain')
  })
})
