import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setup, type World } from '../test/harness'

// reviveFailedChunks, moved out of index.ts's VR_JOB_SPEC driver so plan
// 1.15's job:retryMissing can share it. A resubmitted campaign heals a
// half-done job with it rather than creating a duplicate.

let w: World
beforeEach(async () => {
  w = await setup()
})
afterEach(() => w.dispose())

describe('reviveFailedChunks', () => {
  it("puts a job's failed chunks back to pending with both budgets fresh and no backoff", async () => {
    const app = await w.boot({ start: false })
    const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 8, chunkSize: 4 })
    const [a, b] = w.all<{ id: string }>(
      'SELECT id FROM chunks WHERE job_id = ? ORDER BY frame_start',
      jobId
    )
    w.db
      .prepare(
        `UPDATE chunks SET state = 'failed', node_id = 'node-x', retries = 4, infra_retries = 6,
                not_before = ?, error_kind = 'machine' WHERE id = ?`
      )
      .run(Date.now() + 60_000, a.id)
    w.db.prepare(`UPDATE chunks SET state = 'complete' WHERE id = ?`).run(b.id)

    const { reviveFailedChunks } = await import('./revive')
    expect(reviveFailedChunks(jobId)).toBe(1)

    expect(w.get('SELECT * FROM chunks WHERE id = ?', a.id)).toMatchObject({
      state: 'pending',
      node_id: null,
      retries: 0,
      infra_retries: 0,
      not_before: null,
      // Why it failed last is kept.
      error_kind: 'machine'
    })
    expect(w.get('SELECT state FROM chunks WHERE id = ?', b.id)).toEqual({ state: 'complete' })
    expect(w.eventsOf('chunk:changed')).toContainEqual(
      expect.objectContaining({ chunkId: a.id, state: 'pending', nodeId: null })
    )
  })

  it('a job with nothing failed is left alone', async () => {
    const app = await w.boot({ start: false })
    const jobId = await w.submitJob(app)
    const events = w.events.length
    const { reviveFailedChunks } = await import('./revive')
    expect(reviveFailedChunks(jobId)).toBe(0)
    expect(w.events.length).toBe(events)
  })
})
