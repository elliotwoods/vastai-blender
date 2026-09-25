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

describe('job timing (elapsed, ETA)', () => {
  const MIN = 60_000

  it('stamps finished_at when the job ends, and clears it when a revive queues it again', async () => {
    const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 4, chunkSize: 2 })
    const row = (): { state: string; started_at: number | null; finished_at: number | null } =>
      w.get('SELECT state, started_at, finished_at FROM jobs WHERE id = ?', jobId)!
    expect(row()).toMatchObject({ started_at: null, finished_at: null })

    await app.scheduler.cancelJob(jobId)
    const cancelledAt = row().finished_at
    expect(cancelledAt).toBe(Date.now())
    // Announced again later, it keeps the moment it ended.
    await w.advance(MIN)
    app.jobs.refreshJobState(jobId)
    expect(row().finished_at).toBe(cancelledAt)

    const { reviveFailedChunks } = await import('./revive')
    reviveFailedChunks(jobId)
    expect(row()).toMatchObject({ state: 'queued', finished_at: null })
  })

  it('estimates from the frames landing, and names the latest preview', async () => {
    const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 40, chunkSize: 10 })
    const now = Date.now()
    w.db
      .prepare("UPDATE jobs SET state = 'running', started_at = ? WHERE id = ?")
      .run(now - 30 * MIN, jobId)
    // Ten frames, one every 30 s up to now: 120 an hour, 30 to go.
    const land = w.db.prepare(
      "UPDATE frames SET state = 'downloaded', downloaded_at = ? WHERE job_id = ? AND frame = ?"
    )
    for (let f = 1; f <= 10; f++) land.run(now - (10 - f) * 30_000, jobId, f)
    const outputDir = w.get<{ output_dir: string }>(
      'SELECT output_dir FROM jobs WHERE id = ?',
      jobId
    )!.output_dir
    w.db
      .prepare('UPDATE frames SET thumb_path = ? WHERE job_id = ? AND frame = ?')
      .run(`${outputDir}/thumbs/0003.jpg`, jobId, 3)
    w.db
      .prepare('UPDATE frames SET thumb_path = ? WHERE job_id = ? AND frame = ?')
      .run(`${outputDir}/thumbs/0009.jpg`, jobId, 9)

    const summary = app.jobs.listJobs().find((j) => j.id === jobId)!
    expect(summary).toMatchObject({
      framesDone: 10,
      framesTotal: 40,
      startedAt: now - 30 * MIN,
      finishedAt: null,
      elapsedMs: 30 * MIN,
      remainingMs: 15 * MIN,
      etaAt: now + 15 * MIN,
      timingBasis: 'downloads',
      timingAt: now,
      thumbUrl: `media://job/${jobId}/thumbs/0009.jpg`
    })
    expect(summary.framesPerHour).toBeCloseTo(120)
    // One job's read (job:changed, job:get) says the same as the list.
    expect(app.jobs.getJob(jobId)).toMatchObject({
      remainingMs: 15 * MIN,
      thumbUrl: summary.thumbUrl
    })
  })

  it("falls back to the runs' rates, then to the scene's measured seconds per frame", async () => {
    const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 40, chunkSize: 10 })
    w.db
      .prepare("UPDATE jobs SET state = 'running', started_at = ? WHERE id = ?")
      .run(Date.now(), jobId)
    const sha = w.get<{ blend_sha256: string }>(
      'SELECT blend_sha256 FROM jobs WHERE id = ?',
      jobId
    )!.blend_sha256
    w.db
      .prepare(
        `INSERT INTO scene_perf (scene_sha, gpu_name, loads, load_s, frames, eval_s, sync_s, sample_s, save_s, updated_at)
         VALUES (?, 'RTX 4090', 2, 40, 20, 20, 40, 1100, 40, ?)`
      )
      .run(sha, Date.now())
    const rate = { framesPerSec: 0.01 as number | null, lanes: 2 }
    app.jobs.setJobRateProvider(() => rate)
    const summary = (): ReturnType<typeof app.jobs.listJobs>[number] =>
      app.jobs.listJobs().find((j) => j.id === jobId)!
    expect(summary()).toMatchObject({ timingBasis: 'live', remainingMs: 4_000_000 })
    // No rate measured yet: (40 s of loads + 1200 s of frames) / 20 frames
    // = 62 s a frame, on two renders.
    rate.framesPerSec = null
    expect(summary()).toMatchObject({ timingBasis: 'scenePerf', remainingMs: 40 * 31_000 })
    rate.lanes = 0
    expect(summary()).toMatchObject({ timingBasis: 'none', remainingMs: null, etaAt: null })
  })
})
