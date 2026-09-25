import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ChunkSnapshot, ChunkState, JobDetail } from '../../../../shared/models'
import { JobActions, JobAttentionNote, SceneChangedNote } from './JobActions'

// JobDetail's cancel and "Re-render missing" ask before they act (audit D4,
// plan 1.15): each is a ConfirmButton, whose resting label sits in an
// aria-live span that a plain <button> never had. Clicking needs a DOM,
// which this renderer's tests do not have yet; ConfirmButton's own
// decision logic is tested in confirm.test.ts.

function chunk(state: ChunkState, frameStart = 1, frameEnd = 4): ChunkSnapshot {
  return {
    id: `c-${frameStart}`,
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
    state: 'running',
    framesDone: 2,
    framesTotal: 8,
    framesCancelled: 0,
    startedAt: null,
    finishedAt: null,
    elapsedMs: null,
    remainingMs: null,
    etaAt: null,
    framesPerHour: null,
    timingBasis: 'none',
    timingAt: 0,
    thumbUrl: null,
    queuePos: 1,
    groupId: null,
    hiddenAt: null,
    costSoFar: 0,
    submittedAt: 0,
    outputDir: '/renders/job-1',
    blenderVersion: null,
    shareNode: false,
    chunks: [chunk('rendering', 1, 4), chunk('pending', 5, 8)],
    addonIds: [],
    ...patch
  }
}

const render = (j: JobDetail, note: string | null = null): string =>
  renderToStaticMarkup(
    <JobActions
      job={j}
      onResume={() => Promise.resolve()}
      onRetryMissing={() => Promise.resolve()}
      onCancel={() => Promise.resolve()}
      note={note}
    />
  )

describe('JobActions', () => {
  it('a running job: cancel is a button that asks first', () => {
    const html = render(job({}))
    expect(html).toContain('<span aria-live="polite">cancel</span>')
    expect(html).toMatch(/<button type="button"/)
    expect(html).not.toContain('re-render')
  })

  it('1.15: a partial job offers "Re-render missing (N frames)", asking first, and no cancel', () => {
    const html = render(
      job({ state: 'partial', framesDone: 5, chunks: [chunk('complete'), chunk('failed', 5, 8)] })
    )
    expect(html).toContain('<span aria-live="polite">re-render missing (3 frames)</span>')
    expect(html).not.toContain('>cancel<')
  })

  it('a job failed outright offers neither: main refuses to re-render it', () => {
    const html = render(job({ state: 'failed', chunks: [chunk('failed')] }))
    expect(html).toBe('')
  })

  it('shows what the last re-render did', () => {
    const html = render(job({ state: 'partial', chunks: [chunk('failed')] }), '3 frames queued')
    expect(html).toContain('3 frames queued')
  })
})

describe('1.17: a job the retry breaker held', () => {
  const held = {
    kind: 'repeatedFailure' as const,
    message: 'the same failure on 2 nodes',
    since: 1
  }

  it('offers resume, asking first: cancel and resubmit would bill every finished frame again', () => {
    const html = render(job({ state: 'running', attention: held }))
    expect(html).toContain('<span aria-live="polite">resume</span>')
  })

  it('offers no resume for a job failed outright, or one nothing holds', () => {
    expect(
      render(job({ state: 'failed', attention: { ...held, kind: 'scene' }, chunks: [] }))
    ).not.toContain('>resume<')
    expect(render(job({}))).not.toContain('>resume<')
  })
})

describe('SceneChangedNote (1.12)', () => {
  it('says the scene changed after submit, and nothing otherwise', () => {
    expect(renderToStaticMarkup(<SceneChangedNote job={job({ sceneChanged: true })} />)).toContain(
      'scene changed since submit'
    )
    expect(renderToStaticMarkup(<SceneChangedNote job={job({ sceneChanged: null })} />)).toBe('')
  })
})

describe('JobAttentionNote', () => {
  it('says why a job is held, in the scheduler’s words', () => {
    const html = renderToStaticMarkup(
      <JobAttentionNote
        job={job({
          attention: { kind: 'repeatedFailure', message: 'the same failure on 2 nodes', since: 1 }
        })}
      />
    )
    expect(html).toContain('held: the same failure on 2 nodes')
  })

  it('and why one failed', () => {
    const html = renderToStaticMarkup(
      <JobAttentionNote
        job={job({
          state: 'failed',
          attention: { kind: 'scene', message: 'textures missing', since: 1 }
        })}
      />
    )
    expect(html).toContain('failed: textures missing')
  })

  it('nothing when nothing needs the user', () => {
    expect(renderToStaticMarkup(<JobAttentionNote job={job({})} />)).toBe('')
  })
})
