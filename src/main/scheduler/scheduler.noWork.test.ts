import { afterEach, describe, expect, it } from 'vitest'
import { setup, type AgentSpec, type App, type FakeMachine, type World } from '../test/harness'

// Plan 1.21, no work no rent (field incident da68b61b, 2026-09-25): every one
// of the job's 1903 frames had been downloaded and verified, yet a leftover
// 1-frame requeue sub-chunk (…-19-19-r1) was dispatched and sat 'assigned' on
// a node at 0% GPU, and eagerFleet rented two more 8×4090s (~$8/h) for it.
// A chunk with nothing left to render is complete; it is never sent to a
// node, and never counted as work to rent for.

let w: World
afterEach(() => w.dispose())

interface ChunkRow {
  id: string
  state: string
  node_id: string | null
  retries: number
  frame_start: number
  frame_end: number
}

function chunkRow(id: string): ChunkRow {
  return w.get<ChunkRow>('SELECT * FROM chunks WHERE id = ?', id)!
}

function chunksOf(jobId: string): ChunkRow[] {
  return w.all<ChunkRow>('SELECT * FROM chunks WHERE job_id = ? ORDER BY frame_start', jobId)
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

/** Every state the renderer heard this chunk move through, in order. */
function chunkStates(chunkId: string): string[] {
  return w
    .eventsOf('chunk:changed')
    .filter((c) => c.chunkId === chunkId)
    .map((c) => c.state)
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => (resolve = res))
  return { promise, resolve }
}

async function oneNode(): Promise<{ app: App; nodeId: string; machine: FakeMachine }> {
  w = await setup({ settings: { maxActiveNodes: 1 } })
  const app = await w.boot()
  const nodeId = await w.readyNode(app)
  return { app, nodeId, machine: w.machineFor(nodeId) }
}

/** The scheduler's MAX_RETRIES: a chunk with this many retries is on its last attempt. */
const MAX_RETRIES = 4

describe('1.21 no work, no rent (job da68b61b)', () => {
  it('a leftover requeue sub-chunk whose frame already landed is never dispatched, and rents nothing', async () => {
    // Buy-ahead on, room for two more nodes, and offers to rent them with.
    w = await setup({ settings: { maxActiveNodes: 3, eagerFleet: true } })
    const app = await w.boot()
    const nodeId = await w.readyNode(app)
    const machine = w.machineFor(nodeId)
    w.vast.addOffer()
    w.vast.addOffer()
    const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 4, chunkSize: 2 })
    const [a, b] = chunksOf(jobId)
    // The job as da68b61b stood: every frame downloaded, the chunks that
    // delivered them complete, and a requeue sub-chunk for the last frame
    // still pending, its frame row pointing at it.
    const leftover = `${jobId.slice(0, 8)}-4-4-r1`
    w.db.prepare("UPDATE chunks SET state = 'complete' WHERE id IN (?, ?)").run(a.id, b.id)
    w.db.prepare('UPDATE chunks SET frame_end = 3 WHERE id = ?').run(b.id)
    w.db
      .prepare(
        `INSERT INTO chunks (id, job_id, frame_start, frame_end, state, frames_done, retries)
         VALUES (?, ?, 4, 4, 'pending', 0, 1)`
      )
      .run(leftover, jobId)
    w.db.prepare("UPDATE frames SET state = 'downloaded' WHERE job_id = ?").run(jobId)
    w.db
      .prepare('UPDATE frames SET chunk_id = ? WHERE job_id = ? AND frame = 4')
      .run(leftover, jobId)
    w.db.prepare("UPDATE jobs SET state = 'running' WHERE id = ?").run(jobId)

    app.scheduler.kick()
    // Four scheduler ticks.
    await w.advance(60_000)

    // Never sent: no spec on the node, never 'assigned'.
    expect(machine.agent.spec(leftover)).toBeNull()
    expect(chunkStates(leftover)).not.toContain('assigned')
    expect(chunkRow(leftover).state).toBe('complete')
    expect(jobState(jobId)).toBe('complete')
    // And nothing rented for it: the one node is still the whole fleet.
    expect(w.vast.count('createInstance')).toBe(1)
    expect(app.scheduler.isLive(leftover)).toBe(false)
    expect(w.alerts('info').join('\n')).toContain(leftover)
  })

  it('a chunk whose last frame lands while its node prepares is not sent', async () => {
    const { app, nodeId, machine } = await oneNode()
    const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 2, chunkSize: 2 })
    const [chunk] = chunksOf(jobId)
    w.db.prepare("UPDATE frames SET state = 'downloaded' WHERE job_id = ? AND frame = 1").run(jobId)
    // Node prep takes minutes (here, a Blender install the test holds open).
    const gate = deferred<string>()
    let inPrep = false
    machine.onExec(/provision\.sh install-blender/, () => {
      inPrep = true
      return gate.promise
    })
    app.scheduler.kick()
    await w.until(() => inPrep, 'dispatch in node prep')
    expect(chunkRow(chunk.id).state).toBe('assigned')

    // Meanwhile the chunk's last frame lands (another run's download of a
    // frame since moved to this chunk), and then prep finishes.
    w.db.prepare("UPDATE frames SET state = 'downloaded' WHERE job_id = ? AND frame = 2").run(jobId)
    gate.resolve('')
    await w.until(() => chunkRow(chunk.id).state !== 'assigned', 'dispatch past node prep', {
      timeoutMs: 60_000
    })
    await w.advance(20_000)

    expect(chunkRow(chunk.id)).toMatchObject({ state: 'complete', retries: 0 })
    expect(machine.agent.spec(chunk.id)).toBeNull()
    expect(machine.agent.inbox()).toEqual([])
    expect(chunkStates(chunk.id)).not.toContain('rendering')
    expect(app.scheduler.isLive(chunk.id)).toBe(false)
    expect(app.nodeManager.get(nodeId)?.state).toBe('idle')
    expect(jobState(jobId)).toBe('complete')
  })

  it('a requeue judges the frames that landed by range, not by frames.chunk_id', async () => {
    const { app, machine } = await oneNode()
    const jobId = await w.submitJob(app)
    const [chunk] = chunksOf(jobId)
    // Frames 1-3 are on this computer, their rows still naming the chunk
    // that last owned them: chunk_id says who last owned a frame, not which
    // chunk's range covers it now.
    w.db
      .prepare(
        "UPDATE frames SET state = 'downloaded', chunk_id = 'another-chunk' WHERE job_id = ? AND frame < 4"
      )
      .run(jobId)
    const specs: AgentSpec[] = []
    machine.onSpec = (spec) => {
      specs.push(spec)
      if (specs.length === 1) machine.agent.fail(spec.chunkId, 'blender exited with code 1')
      else machine.agent.finish(spec.chunkId)
    }
    app.scheduler.kick()

    await w.until(() => ['complete', 'partial'].includes(jobState(jobId) ?? ''), 'job settled')

    // The retry renders frame 4 alone, not all four again.
    expect(specs.map((s) => [s.frameStart, s.frameEnd])).toEqual([
      [1, 4],
      [4, 4]
    ])
    expect(jobState(jobId)).toBe('complete')
    expect(chunkRow(chunk.id).retries).toBe(1)
  })

  it('a chunk on its last retry whose every frame landed is complete, not failed', async () => {
    const { app, machine } = await oneNode()
    const jobId = await w.submitJob(app)
    const [chunk] = chunksOf(jobId)
    w.db.prepare('UPDATE chunks SET retries = ? WHERE id = ?').run(MAX_RETRIES, chunk.id)
    // Blender renders every frame and the attempt then fails after it (the
    // encode, say): the final pass downloads them all.
    machine.onSpec = (spec) => {
      machine.agent.render(spec.chunkId)
      machine.agent.fail(spec.chunkId, 'encode failed (1)')
    }
    app.scheduler.kick()

    await w.until(() => ['complete', 'partial'].includes(jobState(jobId) ?? ''), 'job settled')

    expect(downloaded(jobId)).toEqual([1, 2, 3, 4])
    // Nothing is left to render, so the spent retries do not matter: the
    // job has every frame and says so, rather than 'partial'.
    expect(chunkRow(chunk.id).state).toBe('complete')
    expect(jobState(jobId)).toBe('complete')
  })
})
