import { describe, expect, it } from 'vitest'
import { expectedCost, jobTimeTotals, type JobProjectionJob } from './jobProjection'

const NOW = 1_700_000_000_000
const MIN = 60_000

function job(over: Partial<JobProjectionJob> = {}): JobProjectionJob {
  return {
    state: 'running',
    elapsedMs: 10 * MIN,
    remainingMs: 30 * MIN,
    etaAt: NOW + 30 * MIN,
    timingAt: NOW,
    timingBasis: 'downloads',
    costSoFar: 1,
    framesDone: 20,
    framesTotal: 100,
    framesCancelled: 0,
    ...over
  }
}

describe('jobTimeTotals', () => {
  it('a live job: taken so far, and taken plus left', () => {
    expect(jobTimeTotals(job(), NOW)).toEqual({ takenMs: 10 * MIN, totalMs: 40 * MIN })
  })
  it('projects forward: taken grows and left shrinks, the total holds', () => {
    expect(jobTimeTotals(job(), NOW + 5 * MIN)).toEqual({ takenMs: 15 * MIN, totalMs: 40 * MIN })
  })
  it('no estimate: no total', () => {
    expect(jobTimeTotals(job({ remainingMs: null }), NOW).totalMs).toBeNull()
  })
  it('queued: nothing taken', () => {
    expect(
      jobTimeTotals(job({ state: 'queued', elapsedMs: null, remainingMs: null }), NOW)
    ).toEqual({ takenMs: null, totalMs: null })
  })
  it('finished: the total is what it took', () => {
    expect(
      jobTimeTotals(job({ state: 'complete', elapsedMs: 50 * MIN, remainingMs: 0 }), NOW)
    ).toEqual({ takenMs: 50 * MIN, totalMs: 50 * MIN })
  })
})

describe('expectedCost', () => {
  it('scales the spend by time when there is an estimate', () => {
    expect(expectedCost(job(), NOW)).toEqual({ cost: 4, basis: 'time' })
  })
  it('falls back to frames without one, leaving cancelled frames out', () => {
    const e = expectedCost(job({ remainingMs: null, framesCancelled: 20 }), NOW)
    expect(e?.basis).toBe('frames')
    expect(e?.cost).toBeCloseTo(4, 9)
  })
  it('nothing spent and nothing done: no projection', () => {
    expect(expectedCost(job({ costSoFar: 0, framesDone: 0 }), NOW)).toBeNull()
  })
  it('a finished job: what it cost', () => {
    expect(expectedCost(job({ state: 'cancelled', costSoFar: 2.5 }), NOW)).toEqual({
      cost: 2.5,
      basis: 'final'
    })
  })
})
