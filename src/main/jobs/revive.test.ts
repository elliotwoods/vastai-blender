import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setup, type World } from '../test/harness'

// reviveFailedChunks (plan 1.15): job:retryMissing's "Re-render missing",
// and how a resubmitted campaign heals a half-done job rather than creating
// a duplicate. What it queues is exactly the frames not yet on disk.

let w: World
beforeEach(async () => {
  w = await setup()
})
afterEach(() => w.dispose())

interface ChunkRow {
  id: string
  frame_start: number
  frame_end: number
  state: string
  node_id: string | null
  retries: number
  infra_retries: number
  not_before: number | null
  error_kind: string | null
}

function chunksOf(jobId: string): ChunkRow[] {
  return w.all<ChunkRow>('SELECT * FROM chunks WHERE job_id = ? ORDER BY frame_start', jobId)
}

function download(jobId: string, ...frames: number[]): void {
  for (const f of frames) {
    w.db
      .prepare(`UPDATE frames SET state = 'downloaded' WHERE job_id = ? AND frame = ?`)
      .run(jobId, f)
  }
}

/** A chunk out of retries, as resplitAroundDownloaded leaves it: its range as it last went out. */
function fail(chunkId: string): void {
  w.db
    .prepare(
      `UPDATE chunks SET state = 'failed', node_id = 'node-x', retries = 4, infra_retries = 6,
              not_before = ?, error_kind = 'machine' WHERE id = ?`
    )
    .run(Date.now() + 60_000, chunkId)
}

function jobState(jobId: string): string | undefined {
  return w.get<{ state: string }>('SELECT state FROM jobs WHERE id = ?', jobId)?.state
}

async function revive(jobId: string): Promise<{ frames: number; chunks: number }> {
  const { reviveFailedChunks } = await import('./revive')
  return reviveFailedChunks(jobId)
}

describe('reviveFailedChunks', () => {
  it('1.15: a failed chunk is narrowed to the frames that never arrived, both budgets fresh', async () => {
    // A chunk that ran out of retries keeps the range of its last attempt,
    // frames that landed during it included, and the spec sends the whole
    // range: revived as it stood, frames 1-3 and 6 were rendered and billed
    // a second time.
    const app = await w.boot({ start: false })
    const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 12, chunkSize: 8 })
    const [a, b] = chunksOf(jobId)
    download(jobId, 1, 2, 3, 6)
    fail(a.id)
    w.db.prepare(`UPDATE chunks SET state = 'complete' WHERE id = ?`).run(b.id)
    download(jobId, 9, 10, 11, 12)
    const split = `${jobId.slice(0, 8)}-7-8-m1`

    expect(await revive(jobId)).toEqual({ frames: 4, chunks: 2 })

    const rows = chunksOf(jobId)
    expect(rows.map((c) => [c.id, c.frame_start, c.frame_end, c.state])).toEqual([
      // The chunk keeps its id for its first run of missing frames...
      [a.id, 4, 5, 'pending'],
      // ...and the rest is a chunk of its own.
      [split, 7, 8, 'pending'],
      [b.id, 9, 12, 'complete']
    ])
    for (const c of rows.filter((r) => r.state === 'pending')) {
      expect(c).toMatchObject({
        node_id: null,
        retries: 0,
        infra_retries: 0,
        not_before: null,
        // Why it failed last is kept.
        error_kind: 'machine'
      })
    }
    // Frames still to render follow the chunk that now covers them; the
    // downloaded ones keep the chunk that delivered them.
    expect(
      w.all('SELECT frame, chunk_id, state FROM frames WHERE job_id = ? AND frame <= 8', jobId)
    ).toEqual([
      { frame: 1, chunk_id: a.id, state: 'downloaded' },
      { frame: 2, chunk_id: a.id, state: 'downloaded' },
      { frame: 3, chunk_id: a.id, state: 'downloaded' },
      { frame: 4, chunk_id: a.id, state: 'pending' },
      { frame: 5, chunk_id: a.id, state: 'pending' },
      { frame: 6, chunk_id: a.id, state: 'downloaded' },
      { frame: 7, chunk_id: split, state: 'pending' },
      { frame: 8, chunk_id: split, state: 'pending' }
    ])
    expect(w.eventsOf('chunk:changed')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ chunkId: a.id, state: 'pending', nodeId: null }),
        expect.objectContaining({ chunkId: split, state: 'pending' })
      ])
    )
    expect(jobState(jobId)).toBe('running')
  })

  it('narrows on the job’s frame step', async () => {
    const app = await w.boot({ start: false })
    const jobId = await w.submitJob(app, {
      frameStart: 1,
      frameEnd: 15,
      frameStep: 2,
      chunkSize: 8
    })
    const [a] = chunksOf(jobId)
    download(jobId, 5, 7)
    fail(a.id)

    expect(await revive(jobId)).toEqual({ frames: 6, chunks: 2 })
    expect(chunksOf(jobId).map((c) => [c.frame_start, c.frame_end])).toEqual([
      [1, 3],
      [9, 15]
    ])
  })

  it('a failed chunk whose every frame landed is complete, and nothing is rendered', async () => {
    // A cancel fails a chunk whose last frame was already on disk.
    const app = await w.boot({ start: false })
    const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 4, chunkSize: 4 })
    const [a] = chunksOf(jobId)
    download(jobId, 1, 2, 3, 4)
    fail(a.id)
    w.db.prepare(`UPDATE jobs SET state = 'partial' WHERE id = ?`).run(jobId)

    expect(await revive(jobId)).toEqual({ frames: 0, chunks: 0 })
    expect(chunksOf(jobId)[0]).toMatchObject({ state: 'complete', frame_start: 1, frame_end: 4 })
    expect(jobState(jobId)).toBe('complete')
  })

  it('a partial job with every chunk complete has its holes reopened', async () => {
    // refreshJobState calls such a job partial, and builds before 0.9
    // completed chunks with frames missing. No chunk failed, so the old
    // revive queued nothing for it.
    const app = await w.boot({ start: false })
    const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 8, chunkSize: 4 })
    const [a, b] = chunksOf(jobId)
    download(jobId, 1, 3, 4, 5, 6, 7, 8)
    w.db.prepare(`UPDATE chunks SET state = 'complete' WHERE job_id = ?`).run(jobId)
    w.db.prepare(`UPDATE jobs SET state = 'partial' WHERE id = ?`).run(jobId)

    expect(await revive(jobId)).toEqual({ frames: 1, chunks: 1 })
    expect(chunksOf(jobId).map((c) => [c.id, c.frame_start, c.frame_end, c.state])).toEqual([
      [a.id, 2, 2, 'pending'],
      [b.id, 5, 8, 'complete']
    ])
    expect(jobState(jobId)).toBe('running')
  })

  it('leaves the frames a live chunk already covers to it', async () => {
    const app = await w.boot({ start: false })
    const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 8, chunkSize: 4 })
    const [a, b] = chunksOf(jobId)
    fail(a.id)
    w.db.prepare(`UPDATE chunks SET state = 'rendering', node_id = 'node-y' WHERE id = ?`).run(b.id)

    expect(await revive(jobId)).toEqual({ frames: 4, chunks: 1 })
    expect(chunksOf(jobId).map((c) => [c.id, c.state, c.node_id])).toEqual([
      [a.id, 'pending', null],
      [b.id, 'rendering', 'node-y']
    ])
  })

  it('a cancelled job has what it is missing queued again, and is no longer cancelled', async () => {
    const app = await w.boot({ start: false })
    const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 8, chunkSize: 4 })
    const [a, b] = chunksOf(jobId)
    download(jobId, 1, 2, 3, 4)
    await app.scheduler.cancelJob(jobId)
    expect(jobState(jobId)).toBe('cancelled')

    expect(await revive(jobId)).toEqual({ frames: 4, chunks: 1 })
    expect(chunksOf(jobId).map((c) => [c.id, c.frame_start, c.frame_end, c.state])).toEqual([
      // Cancelled with its frames all on disk: complete, not sent again.
      [a.id, 1, 4, 'complete'],
      [b.id, 5, 8, 'pending']
    ])
    expect(jobState(jobId)).toBe('running')
  })

  it('refuses a job the scheduler failed outright, writing nothing', async () => {
    // Its scene failed a check no node can pass, and it renders its snapshot:
    // a revive would pay for a node to fail the same way.
    const app = await w.boot({ start: false })
    const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 4, chunkSize: 4 })
    const [a] = chunksOf(jobId)
    fail(a.id)
    w.db
      .prepare(`UPDATE jobs SET state = 'failed', attention = ? WHERE id = ?`)
      .run(JSON.stringify({ kind: 'scene', message: 'textures missing', since: 1 }), jobId)
    const events = w.events.length

    await expect(revive(jobId)).rejects.toThrow(/failed outright.*submit it again/)
    expect(chunksOf(jobId)[0]).toMatchObject({ state: 'failed', retries: 4 })
    expect(jobState(jobId)).toBe('failed')
    expect(w.events.length).toBe(events)
  })

  it('refuses a job whose frame step would never advance, at once and writing nothing', async () => {
    // Only a hand-edited or damaged database holds such a step. Walked
    // before it was checked, the step spun the job's grid for good, inside
    // the main process: destroys, the supervisor and the quit dialog with it.
    const app = await w.boot({ start: false })
    const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 4, chunkSize: 4 })
    const [a] = chunksOf(jobId)
    download(jobId, 1)
    fail(a.id)
    const events = w.events.length

    for (const step of [0, -1]) {
      w.db.prepare(`UPDATE jobs SET frame_step = ? WHERE id = ?`).run(step, jobId)
      await expect(revive(jobId)).rejects.toThrow(/no usable frame step/)
    }
    expect(chunksOf(jobId)[0]).toMatchObject({ state: 'failed', frame_start: 1, frame_end: 4 })
    expect(w.events.length).toBe(events)
  })

  it('refuses a job that does not exist', async () => {
    await w.boot({ start: false })
    await expect(revive('no-such-job')).rejects.toThrow(/no job no-such-job/)
  })

  it('a frame no chunk covers any more gets a chunk of its own', async () => {
    // A chunk row lost to a hand edit, say: its frames are missing too.
    const app = await w.boot({ start: false })
    const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 8, chunkSize: 4 })
    const [a, b] = chunksOf(jobId)
    download(jobId, 1, 2, 3, 4)
    w.db.prepare(`UPDATE chunks SET state = 'complete' WHERE id = ?`).run(a.id)
    w.db.prepare(`DELETE FROM chunks WHERE id = ?`).run(b.id)
    const own = `${jobId.slice(0, 8)}-5-8-m1`

    expect(await revive(jobId)).toEqual({ frames: 4, chunks: 1 })
    expect(chunksOf(jobId).map((c) => [c.id, c.frame_start, c.frame_end, c.state])).toEqual([
      [a.id, 1, 4, 'complete'],
      [own, 5, 8, 'pending']
    ])
    expect(
      w.all('SELECT DISTINCT chunk_id FROM frames WHERE job_id = ? AND frame >= 5', jobId)
    ).toEqual([{ chunk_id: own }])
  })

  it('never reuses a chunk id', async () => {
    const app = await w.boot({ start: false })
    const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 8, chunkSize: 8 })
    const [a] = chunksOf(jobId)
    download(jobId, 3, 4, 5, 6)
    fail(a.id)
    // The same range re-rendered before, and complete since.
    w.db
      .prepare(
        `INSERT INTO chunks (id, job_id, frame_start, frame_end, state) VALUES (?, ?, 9, 9, 'complete')`
      )
      .run(`${jobId.slice(0, 8)}-7-8-m1`, jobId)

    expect(await revive(jobId)).toEqual({ frames: 4, chunks: 2 })
    expect(chunksOf(jobId).map((c) => c.id)).toContain(`${jobId.slice(0, 8)}-7-8-m2`)
  })

  it('a job with nothing missing and nothing failed is left alone', async () => {
    const app = await w.boot({ start: false })
    const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 4, chunkSize: 4 })
    download(jobId, 1, 2, 3, 4)
    const events = w.events.length
    expect(await revive(jobId)).toEqual({ frames: 0, chunks: 0 })
    expect(w.events.length).toBe(events)
  })
})
