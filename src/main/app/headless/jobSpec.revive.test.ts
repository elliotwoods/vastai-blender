import { writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setup, type World } from '../../test/harness'

// A resubmitted VR_JOB_SPEC campaign heals a half-done job instead of
// duplicating it, through the same revive as "Re-render missing" (plan
// 1.15, jobs/revive.ts).

let w: World
beforeEach(async () => {
  w = await setup()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(async () => {
  vi.restoreAllMocks()
  await w.dispose()
})

function specFor(blend: string): string {
  const path = join(w.dir, 'spec.json')
  writeFileSync(
    path,
    JSON.stringify({ blends: [blend], engine: 'cycles', frameStart: 1, frameEnd: 8 })
  )
  return path
}

describe('runJobSpec on a campaign already submitted', () => {
  it('1.15: queues only the frames a half-done job is missing, and submits no duplicate', async () => {
    const app = await w.boot({ start: false })
    const blend = w.blend()
    const jobId = await w.submitJob(app, {
      blendPath: blend,
      frameStart: 1,
      frameEnd: 8,
      chunkSize: 8
    })
    w.db
      .prepare(`UPDATE frames SET state = 'downloaded' WHERE job_id = ? AND frame <= 5`)
      .run(jobId)
    w.db.prepare(`UPDATE chunks SET state = 'failed', retries = 4 WHERE job_id = ?`).run(jobId)
    w.db.prepare(`UPDATE jobs SET state = 'partial' WHERE id = ?`).run(jobId)

    const { runJobSpec } = await import('./jobSpec')
    const unsubmitted: string[] = []
    const kick = vi.fn()
    await runJobSpec(specFor(blend), { kick, unsubmitted })

    expect(w.all('SELECT id FROM jobs')).toEqual([{ id: jobId }])
    expect(
      w.all('SELECT frame_start, frame_end, state, retries FROM chunks WHERE job_id = ?', jobId)
    ).toEqual([{ frame_start: 6, frame_end: 8, state: 'pending', retries: 0 }])
    expect(unsubmitted).toEqual([])
    expect(kick).toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('3 missing frame(s) queued again in 1 chunk(s)')
    )
  })

  it('a job it cannot revive is named as a part of the campaign not submitted', async () => {
    // A row missingRanges refuses (an inverted range). The revive used to be
    // one UPDATE that could not fail; now it narrows, and a refusal must not
    // end the driver before the rest of the campaign is submitted.
    const app = await w.boot({ start: false })
    const blend = w.blend()
    const jobId = await w.submitJob(app, {
      blendPath: blend,
      frameStart: 1,
      frameEnd: 8,
      chunkSize: 8
    })
    w.db
      .prepare(
        `UPDATE chunks SET state = 'failed', frame_start = 8, frame_end = 5 WHERE job_id = ?`
      )
      .run(jobId)
    w.db.prepare(`UPDATE jobs SET state = 'partial' WHERE id = ?`).run(jobId)

    const { runJobSpec } = await import('./jobSpec')
    const unsubmitted: string[] = []
    const kick = vi.fn()
    await runJobSpec(specFor(blend), { kick, unsubmitted })

    expect(unsubmitted).toEqual([
      `${blend}: revive failed: frame range ends before it starts (8–5)`
    ])
    expect(kick).toHaveBeenCalled()
  })
})
