import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { JobTiming } from './JobTiming'
import { jobTimingView, type JobTimingJob } from './jobTimingView'

// Local-time moments, so the clock times hold in any time zone.
const now = new Date(2026, 8, 22, 13, 30).getTime()
const MIN = 60_000
const HOUR = 60 * MIN

const running: JobTimingJob = {
  state: 'running',
  startedAt: now - 62 * MIN,
  finishedAt: null,
  elapsedMs: 62 * MIN,
  remainingMs: 62 * MIN,
  etaAt: new Date(2026, 8, 22, 14, 32).getTime(),
  framesPerHour: 1240,
  timingBasis: 'downloads',
  timingAt: now
}

const text = (job: JobTimingJob, compact = false, at = now): string =>
  jobTimingView(job, at, compact)
    .parts.map((p) => [p.label, p.value, p.after].filter(Boolean).join(' '))
    .join(' · ')

describe('jobTimingView', () => {
  it('a running job: elapsed, time left and the ETA', () => {
    expect(text(running)).toBe('elapsed 1h 02m · 1h 02m left · ETA 14:32')
    expect(jobTimingView(running, now).title).toContain('1,240 frames/h')
  })

  it('projects the figures forward between updates', () => {
    expect(text(running, false, now + 90_000)).toBe('elapsed 1h 03m · 1h 00m left · ETA 14:32')
  })

  it('compact: the time left and the ETA, or the elapsed time with no estimate', () => {
    expect(text(running, true)).toBe('1h 02m left · ETA 14:32')
    expect(text({ ...running, remainingMs: null, etaAt: null, timingBasis: 'none' }, true)).toBe(
      'elapsed 1h 02m'
    )
  })

  it('says when there is no estimate yet, and when the ETA has passed', () => {
    expect(text({ ...running, remainingMs: null, etaAt: null })).toBe(
      'elapsed 1h 02m · estimating…'
    )
    expect(text({ ...running, remainingMs: 1000 }, false, now + 5000)).toBe(
      'elapsed 1h 02m · finishing'
    )
  })

  it('marks a first guess from the scene’s timing as rough', () => {
    expect(text({ ...running, remainingMs: 14 * MIN, timingBasis: 'scenePerf' }, true)).toBe(
      '~14m 00s left · ETA 14:32'
    )
  })

  it('a queued job that has not started is just queued', () => {
    const queued: JobTimingJob = {
      ...running,
      state: 'queued',
      startedAt: null,
      elapsedMs: null,
      remainingMs: null,
      etaAt: null
    }
    expect(jobTimingView(queued, now).kind).toBe('queued')
    expect(text(queued)).toBe('queued')
  })

  it('a finished job: how long it took and when it finished', () => {
    const done: JobTimingJob = {
      ...running,
      state: 'complete',
      finishedAt: new Date(2026, 8, 22, 12, 5).getTime(),
      elapsedMs: 3 * HOUR + 4 * MIN,
      remainingMs: 0
    }
    expect(text(done)).toBe('took 3h 04m · finished 12:05')
    expect(text(done, true)).toBe('took 3h 04m')
    // a finished job's clock does not run on
    expect(text(done, false, now + HOUR)).toBe('took 3h 04m · finished 12:05')
  })

  it('a stopped job says how it ended', () => {
    const cancelled: JobTimingJob = {
      ...running,
      state: 'cancelled',
      finishedAt: new Date(2026, 8, 21, 9, 0).getTime(),
      elapsedMs: 20 * MIN,
      remainingMs: null,
      etaAt: null
    }
    expect(text(cancelled)).toBe('ran 20m 00s · cancelled Mon 09:00')
    expect(jobTimingView(cancelled, now).kind).toBe('stopped')
  })

  it('says nothing for a finished job with nothing recorded', () => {
    const blank: JobTimingJob = {
      ...running,
      state: 'failed',
      startedAt: null,
      finishedAt: null,
      elapsedMs: null
    }
    expect(jobTimingView(blank, now)).toEqual({ kind: 'none', parts: [], title: '' })
  })
})

describe('JobTiming', () => {
  // The component reads the real clock; keep the job's figures about now.
  const live = (): JobTimingJob => ({ ...running, timingAt: Date.now(), etaAt: Date.now() + HOUR })

  it('sets the figures in mono and the words in the sans face', () => {
    const html = renderToStaticMarkup(<JobTiming job={live()} />)
    expect(html).toContain('data-timing="running"')
    expect(html).toMatch(/<span style="color:var\(--text-faint\)">elapsed<\/span>/)
    expect(html).toMatch(/font-family:var\(--font-mono\)[^>]*>1h 0\dm</)
    expect(html).toContain('>ETA<')
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('title="elapsed')
  })

  it('renders nothing when there is nothing to say', () => {
    const html = renderToStaticMarkup(
      <JobTiming
        job={{ ...running, state: 'failed', startedAt: null, finishedAt: null, elapsedMs: null }}
      />
    )
    expect(html).toBe('')
  })

  it('is smaller when compact', () => {
    const html = renderToStaticMarkup(<JobTiming job={live()} compact />)
    expect(html).toContain('font-size:var(--text-xs)')
    expect(html).not.toContain('>elapsed<')
  })
})
