import { afterEach, describe, expect, it } from 'vitest'
import { setup, type AgentSpec, type App, type World } from '../test/harness'

// Plan 1.9, restart without paying twice. A restart kills the renders the
// last process started (its nodes' agents are restarted), so each chunk it
// left in flight is sent again: narrowed to the frames this computer still
// lacks, with no retry charged, since nothing about the chunk failed.

let w: World
afterEach(() => w.dispose())

interface ChunkRow {
  id: string
  state: string
  node_id: string | null
  retries: number
  frame_start: number
  frame_end: number
  frames_done: number
}

function chunksOf(jobId: string): ChunkRow[] {
  return w.all<ChunkRow>(
    `SELECT id, state, node_id, retries, frame_start, frame_end, frames_done FROM chunks
      WHERE job_id = ? ORDER BY frame_start`,
    jobId
  )
}

function jobState(jobId: string): string | undefined {
  return w.get<{ state: string }>('SELECT state FROM jobs WHERE id = ?', jobId)?.state
}

function downloaded(jobId: string): number[] {
  return w
    .all<{ frame: number }>(
      "SELECT frame FROM frames WHERE job_id = ? AND state = 'downloaded' ORDER BY frame",
      jobId
    )
    .map((f) => f.frame)
}

/**
 * The state a process that quit mid-render leaves: the job running, `chunkId`
 * out on a node (which the next launch cannot re-attach to).
 */
function leftInFlight(jobId: string, chunkId: string, state = 'rendering', retries = 0): void {
  w.db
    .prepare(
      'UPDATE chunks SET state = ?, node_id = ?, frames_done = 3, retries = ?, assigned_at = ? WHERE id = ?'
    )
    .run(state, 'node-of-the-last-session', retries, Date.now(), chunkId)
  w.db.prepare("UPDATE jobs SET state = 'running' WHERE id = ?").run(jobId)
}

/** index.ts's launch order, on a database a test has already seeded. */
function launch(app: App): void {
  app.nodeManager.init()
  app.scheduler.start()
}

describe('1.9 restart recovery', () => {
  it('narrows a stranded chunk around its downloaded frames, and charges no retry', async () => {
    w = await setup()
    const app = await w.boot({ start: false })
    const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 8, chunkSize: 8 })
    const [chunk] = chunksOf(jobId)
    // A retry already spent before the restart, and frames 1, 2 and 5 on
    // this computer.
    leftInFlight(jobId, chunk.id, 'rendering', 1)
    w.db
      .prepare("UPDATE frames SET state = 'downloaded' WHERE job_id = ? AND frame IN (1, 2, 5)")
      .run(jobId)

    launch(app)

    // Back in the queue for 3-4 and 6-8 only, retries as they were.
    const rest = `${jobId.slice(0, 8)}-6-8-r1`
    expect(chunksOf(jobId)).toEqual([
      { ...chunk, state: 'pending', node_id: null, retries: 1, frame_start: 3, frame_end: 4 },
      {
        id: rest,
        state: 'pending',
        node_id: null,
        retries: 1,
        frame_start: 6,
        frame_end: 8,
        frames_done: 0
      }
    ])
    expect(
      w
        .all<{ chunk_id: string }>(
          'SELECT chunk_id FROM frames WHERE job_id = ? AND frame >= 6 ORDER BY frame',
          jobId
        )
        .map((f) => f.chunk_id)
    ).toEqual([rest, rest, rest])

    // Sent again, the chunks render what is missing and nothing else.
    const nodeId = await w.readyNode(app)
    const machine = w.machineFor(nodeId)
    const specs: AgentSpec[] = []
    machine.onSpec = (spec) => {
      specs.push(spec)
      machine.agent.finish(spec.chunkId)
    }
    app.scheduler.kick()
    await w.until(() => jobState(jobId) === 'complete', 'job complete')
    expect(specs.map((s) => [s.chunkId, s.frameStart, s.frameEnd])).toEqual([
      [chunk.id, 3, 4],
      [rest, 6, 8]
    ])
    expect(downloaded(jobId)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(chunksOf(jobId).map((c) => c.retries)).toEqual([1, 1])
  })

  it('completes a stranded chunk whose every frame had landed', async () => {
    w = await setup({ settings: { maxActiveNodes: 4 } })
    const app = await w.boot({ start: false })
    const jobId = await w.submitJob(app)
    const [chunk] = chunksOf(jobId)
    // Quit in the chunk's final download pass, after its last frame landed.
    leftInFlight(jobId, chunk.id, 'downloading')
    w.db.prepare("UPDATE frames SET state = 'downloaded' WHERE job_id = ?").run(jobId)

    launch(app)

    expect(chunksOf(jobId)[0]).toMatchObject({ state: 'complete', retries: 0 })
    expect(jobState(jobId)).toBe('complete')
  })
})
