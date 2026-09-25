import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setup, type App, type World } from '../test/harness'

// The job and chunk read models, and the one state rule jobs.ts keeps for the
// scheduler: a job that failed outright stays failed (plans 1.16, 1.17).

let w: World
let app: App
beforeEach(async () => {
  w = await setup()
  app = await w.boot({ start: false })
})
afterEach(() => w.dispose())

describe('refreshJobState', () => {
  it('1.16: keeps a job no node can render failed while its chunks still in flight settle', async () => {
    const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 4, chunkSize: 2 })
    // The scheduler failed the job on its first chunk's scene preflight; the
    // other chunk was already out, and settles after.
    w.db.prepare("UPDATE jobs SET state = 'failed' WHERE id = ?").run(jobId)
    const [first, second] = w.all<{ id: string }>(
      'SELECT id FROM chunks WHERE job_id = ? ORDER BY frame_start',
      jobId
    )
    w.db.prepare("UPDATE chunks SET state = 'failed' WHERE id = ?").run(first.id)
    w.db.prepare("UPDATE chunks SET state = 'rendering' WHERE id = ?").run(second.id)
    app.jobs.refreshJobState(jobId)
    expect(w.get('SELECT state FROM jobs WHERE id = ?', jobId)).toEqual({ state: 'failed' })

    w.db.prepare("UPDATE chunks SET state = 'complete' WHERE id = ?").run(second.id)
    app.jobs.refreshJobState(jobId)
    expect(w.get('SELECT state FROM jobs WHERE id = ?', jobId)).toEqual({ state: 'failed' })
    // Still announced, so the Jobs list hears about the chunk that settled.
    expect(w.eventsOf('job:changed').at(-1)).toMatchObject({ id: jobId, state: 'failed' })
  })
})

describe('the read models (plan 1.17)', () => {
  it("a job's attention reaches the renderer, and so do a chunk's retry counts and why it last failed", async () => {
    const jobId = await w.submitJob(app)
    const [{ id: chunkId }] = w.all<{ id: string }>('SELECT id FROM chunks WHERE job_id = ?', jobId)
    const attention = {
      kind: 'repeatedFailure',
      message: 'the same failure on 2 nodes: render failed: blender exited -11',
      since: 1_700_000_000_000,
      errorClass: 'job'
    }
    w.db.prepare('UPDATE jobs SET attention = ? WHERE id = ?').run(JSON.stringify(attention), jobId)
    w.db
      .prepare(
        `UPDATE chunks SET retries = 1, infra_retries = 2, not_before = ?, error_kind = 'transient'
          WHERE id = ?`
      )
      .run(1_700_000_015_000, chunkId)
    app.jobs.noteChunkError(chunkId, 'SSH channel limit on the node: (SSH) Channel open failure')

    const job = app.jobs.getJob(jobId)!
    expect(job.attention).toEqual(attention)
    expect(app.jobs.listJobs()[0].attention).toEqual(attention)
    expect(job.chunks[0]).toMatchObject({
      retries: 1,
      infraRetries: 2,
      notBefore: 1_700_000_015_000,
      errorClass: 'transient',
      lastError: 'SSH channel limit on the node: (SSH) Channel open failure'
    })
  })

  it('a job with nothing wrong, and a chunk that never failed, say so', async () => {
    const jobId = await w.submitJob(app)
    const job = app.jobs.getJob(jobId)!
    expect(job.attention).toBeNull()
    expect(job.chunks[0]).toMatchObject({
      retries: 0,
      infraRetries: 0,
      notBefore: null,
      errorClass: null,
      lastError: null
    })
  })

  it('an attention that is not the JSON the scheduler writes is shown as written', () => {
    expect(app.jobs.parseAttention('needs a look')).toEqual({
      kind: 'repeatedFailure',
      message: 'needs a look',
      since: 0
    })
    expect(app.jobs.parseAttention('{"kind":"nonsense","message":"x"}')).toMatchObject({
      message: '{"kind":"nonsense","message":"x"}'
    })
    expect(app.jobs.parseAttention(null)).toBeNull()
    expect(app.jobs.parseAttention('  ')).toBeNull()
  })

  it("a class the contract does not know is not passed on as the chunk's", async () => {
    const jobId = await w.submitJob(app)
    w.db.prepare("UPDATE chunks SET error_kind = 'job-deterministic' WHERE job_id = ?").run(jobId)
    expect(app.jobs.getJob(jobId)!.chunks[0].errorClass).toBeNull()
  })
})
