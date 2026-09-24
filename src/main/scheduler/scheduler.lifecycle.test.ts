import { createHash } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { REMOTE_ROOT } from '../test/fakeSsh'
import { setup, type AgentSpec, type App, type FakeMachine, type World } from '../test/harness'

// Chunk ownership and completion, end to end on the lifecycle harness: a run
// that has been abandoned must never write to a chunk again, and a chunk (and
// its job) is complete only once its frames are on the local disk.

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

function onlyChunk(jobId: string): ChunkRow {
  const rows = w.all<ChunkRow>('SELECT * FROM chunks WHERE job_id = ?', jobId)
  expect(rows).toHaveLength(1)
  return rows[0]
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

/** A reply the test settles by hand. */
function deferred<T>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: Error) => void
} {
  let resolve!: (v: T) => void
  let reject!: (e: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** `cat` of a file on the machine, as the harness's built-in answers it. */
function cat(machine: FakeMachine, command: string): { code: number; stdout: string } {
  const path = /^cat '([^']+)'/.exec(command)![1]
  const data = machine.files.get(path)
  return data ? { code: 0, stdout: data.toString('utf-8') } : { code: 1, stdout: '' }
}

const manifestRead = /^cat '[^']*\/manifest\.jsonl'/

/** Save a file on the node and list it in the chunk's manifest, as noderunner does. */
function listSaved(machine: FakeMachine, chunkId: string, file: string): void {
  const dir = `${REMOTE_ROOT}/renders/${chunkId}`
  const data = Buffer.from(`fake render ${chunkId} ${file}\n`, 'utf-8')
  machine.files.set(`${dir}/${file}`, data)
  const line = JSON.stringify({
    kind: 'frame',
    file,
    size: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
    mtime: 1
  })
  const prev = machine.files.get(`${dir}/manifest.jsonl`)?.toString('utf-8') ?? ''
  machine.files.set(`${dir}/manifest.jsonl`, Buffer.from(`${prev}${line}\n`, 'utf-8'))
}

async function oneNode(): Promise<{ app: App; nodeId: string; machine: FakeMachine }> {
  w = await setup({ settings: { maxActiveNodes: 1 } })
  const app = await w.boot()
  const nodeId = await w.readyNode(app)
  return { app, nodeId, machine: w.machineFor(nodeId) }
}

describe('stale runs', () => {
  it('a run abandoned during node prep never requeues the chunk its successor now owns', async () => {
    w = await setup({ settings: { maxActiveNodes: 3 } })
    const app = await w.boot()
    const nodeIds = [await w.readyNode(app), await w.readyNode(app), await w.readyNode(app)]
    const machines = nodeIds.map((id) => w.machineFor(id))

    // The first Blender install anywhere hangs — minutes of download, in real
    // life. Any later one (the successor's prep) goes straight through.
    let held: FakeMachine | null = null
    for (const m of machines) {
      m.onExec(/provision\.sh install-blender/, (_cmd, _match, machine) => {
        if (held) return ''
        held = machine
        return deferred<string>().promise
      })
    }
    const jobId = await w.submitJob(app)
    const chunk = onlyChunk(jobId)
    app.scheduler.kick()
    await w.until(() => held !== null, 'first dispatch in node prep')
    const first = chunkRow(chunk.id).node_id!
    expect(held).toBe(w.machineFor(first))

    // The node goes away mid-prep, the way recoverUnreachable handles it:
    // state first, then the scheduler releases its work, then the connection
    // closes. forgetNode requeues the chunk and dispatches it straight to a
    // surviving node.
    const dying = app.nodeManager.get(first)!
    dying.setState('failed', 'unreachable')
    app.scheduler.forgetNode(first)
    const second = chunkRow(chunk.id).node_id!
    expect(second).not.toBe(first)
    await w.until(() => chunkRow(chunk.id).state === 'rendering', 'successor rendering')

    // Only now does the abandoned prep fail, on its closed connection.
    dying.closeSsh()
    // Past the next scheduler tick, which would pick up a requeued chunk.
    await w.advance(20_000)

    // Exactly one live dispatch: the successor, still owning its chunk.
    const withSpec = machines.filter((m) => m.agent.spec(chunk.id) !== null)
    expect(withSpec).toEqual([w.machineFor(second)])
    expect(chunkRow(chunk.id)).toMatchObject({ state: 'rendering', node_id: second, retries: 1 })
    expect(app.scheduler.isLive(chunk.id)).toBe(true)
    expect(chunkStates(chunk.id).filter((s) => s === 'assigned')).toHaveLength(2)
    expect(w.alerts('error').filter((a) => a.includes('dispatch'))).toEqual([])

    w.machineFor(second).agent.finish(chunk.id)
    await w.until(() => jobState(jobId) === 'complete', 'job complete')
    expect(downloaded(jobId)).toEqual([1, 2, 3, 4])
    expect(chunkRow(chunk.id).retries).toBe(1)
  })

  it('cancelling a job announces it, and a run caught mid-drain does not resurrect its chunk', async () => {
    const { app, machine } = await oneNode()
    const jobId = await w.submitJob(app)
    const chunk = onlyChunk(jobId)
    app.scheduler.kick()
    await w.until(() => chunkRow(chunk.id).state === 'rendering', 'chunk rendering')

    // Every manifest read from here on hangs until the test lets it go, so the
    // run sits in its final download pass while the job is cancelled.
    const gate = deferred<string>()
    machine.onExec(manifestRead, () => gate.promise)
    const progressBefore = w.eventsOf('chunk:progress').length
    machine.agent.fail(chunk.id, 'blender exited with code 1')
    // The run has read the 'failed' state (it reports progress as it does)
    // and gone straight into drain().
    await w.until(() => w.eventsOf('chunk:progress').length > progressBefore, 'run in drain')
    const jobEventsBefore = w.eventsOf('job:changed').length

    await w.invoke('job:cancel', jobId)

    // The renderer hears the cancel: the Jobs list reads the job from job:changed.
    const announced = w.eventsOf('job:changed').slice(jobEventsBefore)
    expect(announced.filter((j) => j.id === jobId).map((j) => j.state)).toContain('cancelled')
    expect(chunkRow(chunk.id).state).toBe('failed')

    // The drain's read now fails; the aborted run wakes up with nothing left to own.
    gate.reject(new Error('(SSH) Channel open failure'))
    await w.advance(2 * 60_000)

    expect(jobState(jobId)).toBe('cancelled')
    expect(chunkRow(chunk.id)).toMatchObject({ state: 'failed', retries: 0 })
    expect(chunkStates(chunk.id).at(-1)).toBe('failed')
    // Dispatched once, and never again.
    expect(chunkStates(chunk.id).filter((s) => s === 'assigned')).toHaveLength(1)
  })

  it('a run whose node goes away mid-drain never writes over the chunk its successor now owns', async () => {
    w = await setup({ settings: { maxActiveNodes: 2 } })
    const app = await w.boot()
    const nodeIds = [await w.readyNode(app), await w.readyNode(app)]
    const jobId = await w.submitJob(app)
    const chunk = onlyChunk(jobId)
    app.scheduler.kick()
    await w.until(() => chunkRow(chunk.id).state === 'rendering', 'chunk rendering')
    const first = chunkRow(chunk.id).node_id!
    const second = nodeIds.find((id) => id !== first)!

    // The agent finishes, and every manifest read on the first node hangs
    // until the test lets it go: the run sits in its final download pass.
    const gate = deferred<string>()
    w.machineFor(first).onExec(manifestRead, () => gate.promise)
    w.machineFor(first).agent.finish(chunk.id)
    await w.until(() => chunkRow(chunk.id).state === 'downloading', 'run in its final pass')

    // The node goes away. forgetNode requeues the chunk, and the second node
    // takes it.
    app.nodeManager.get(first)!.setState('failed', 'unreachable')
    app.scheduler.forgetNode(first)
    await w.until(
      () => chunkRow(chunk.id).state === 'rendering' && chunkRow(chunk.id).node_id === second,
      'successor rendering'
    )

    // Only now does the stale run's final pass end, its manifest read failed.
    // Finishing anyway wrote 'failed' over the successor's row and requeued
    // it again, and the next tick dispatched the chunk a third time.
    gate.reject(new Error('(SSH) Channel open failure'))
    await w.advance(20_000)

    expect(chunkRow(chunk.id)).toMatchObject({ state: 'rendering', node_id: second, retries: 1 })
    expect(app.scheduler.isLive(chunk.id)).toBe(true)
    expect(chunkStates(chunk.id).filter((s) => s === 'assigned')).toHaveLength(2)
    expect(w.machineFor(second).agent.inbox()).toEqual([chunk.id])

    w.machineFor(second).agent.finish(chunk.id)
    await w.until(() => jobState(jobId) === 'complete', 'job complete')
    expect(downloaded(jobId)).toEqual([1, 2, 3, 4])
    expect(chunkRow(chunk.id).retries).toBe(1)
  })
})

// requeue() throws on a range or step missingRanges cannot walk. Its callers
// must carry on regardless: a throw there once skipped destroying an instance,
// or kept a run registered so its node never went idle.
describe('bookkeeping that throws', () => {
  /** A range no writer produces, which missingRanges refuses (inside requeue). */
  function invertRange(chunkId: string): void {
    w.db.prepare('UPDATE chunks SET frame_start = 4, frame_end = 1 WHERE id = ?').run(chunkId)
  }

  it('destroyNode still destroys the instance when requeueing its chunk throws', async () => {
    const { app, nodeId } = await oneNode()
    const jobId = await w.submitJob(app)
    const chunk = onlyChunk(jobId)
    app.scheduler.kick()
    await w.until(() => chunkRow(chunk.id).state === 'rendering', 'chunk rendering')
    const instanceId = w.get<{ instance_id: number }>(
      'SELECT instance_id FROM nodes WHERE id = ?',
      nodeId
    )!.instance_id
    invertRange(chunk.id)

    let outcome: string | null = null
    app.nodeManager.destroyNode(nodeId).then(
      () => (outcome = 'destroyed'),
      (e: Error) => (outcome = e.message)
    )
    await w.until(() => outcome !== null, 'destroyNode settled')

    expect(outcome).toBe('destroyed')
    expect(w.vast.live()).not.toContain(instanceId)
    expect(app.nodeManager.get(nodeId)?.state).toBe('destroyed')
    expect(app.scheduler.isLive(chunk.id)).toBe(false)
    // Failed, and said so, rather than left 'rendering' against a dead node.
    expect(chunkRow(chunk.id).state).toBe('failed')
    expect(w.alerts('error').join('\n')).toMatch(/could not be requeued.*ends before it starts/)
  })

  it('a dispatch that fails lets go of its node even when the requeue throws', async () => {
    const { app, nodeId, machine } = await oneNode()
    const jobId = await w.submitJob(app)
    const chunk = onlyChunk(jobId)
    // The range goes bad while the chunk is out being dispatched, and the
    // dispatch then fails.
    machine.onExec(/provision\.sh install-blender/, () => {
      invertRange(chunk.id)
      return { code: 1, stdout: '', stderr: 'no space left on device' }
    })
    app.scheduler.kick()
    await w.until(
      () => w.alerts('error').some((a) => a.includes(`dispatch ${chunk.id} failed`)),
      'dispatch failed'
    )
    await w.advance(1_000)

    expect(app.scheduler.isLive(chunk.id)).toBe(false)
    expect(app.nodeManager.get(nodeId)?.state).toBe('idle')
    expect(chunkRow(chunk.id).state).toBe('failed')
    expect(w.alerts('error').join('\n')).toMatch(/could not be requeued/)
  })

  it('a run that throws while settling its chunk still lets go of its node', async () => {
    const { app, nodeId, machine } = await oneNode()
    const jobId = await w.submitJob(app)
    const chunk = onlyChunk(jobId)
    // The write of 'complete' fails, as a full disk would fail it. finish()
    // has already stopped the run by then, and onChunkFinished never runs.
    w.db.exec(
      `CREATE TRIGGER harness_complete_fails BEFORE UPDATE OF state ON chunks
       WHEN NEW.state = 'complete' BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`
    )
    machine.agent.autoFinish()
    app.scheduler.kick()
    await w.until(() => downloaded(jobId).length === 4, 'frames downloaded')
    await w.advance(20_000)

    expect(app.scheduler.isLive(chunk.id)).toBe(false)
    expect(app.nodeManager.get(nodeId)?.state).toBe('idle')
    expect(w.alerts('error').join('\n')).toContain(`chunk ${chunk.id} failed as it finished`)
  })
})

describe('completion means downloaded', () => {
  it('a chunk whose final manifest read fails is not complete; the retry renders only what is missing', async () => {
    const { app, machine } = await oneNode()
    const jobId = await w.submitJob(app)
    const chunk = onlyChunk(jobId)
    const specs: AgentSpec[] = []
    machine.onSpec = (spec) => void specs.push(spec)
    app.scheduler.kick()
    await w.until(() => chunkRow(chunk.id).state === 'rendering', 'chunk rendering')

    // Frames 1-2 land and the background poll fetches them.
    machine.agent.render(chunk.id, [1, 2])
    machine.agent.progress(chunk.id, 2)
    await w.until(() => downloaded(jobId).length === 2, 'frames 1-2 downloaded')

    // Then the node's session cap bites: every manifest read fails, and the
    // agent manifests 3-4 and reports done in that window.
    let manifestDown = true
    machine.onExec(manifestRead, (cmd, _match, m) =>
      manifestDown ? Promise.reject(new Error('(SSH) Channel open failure')) : cat(m, cmd)
    )
    machine.agent.finish(chunk.id, { frames: [3, 4] })
    await w.until(
      () => chunkRow(chunk.id).state === 'complete' || chunkRow(chunk.id).retries > 0,
      'chunk settled after its final pass'
    )

    // Not complete: 3 and 4 were never fetched. Requeued (and at once
    // re-dispatched), narrowed to just them.
    expect(chunkRow(chunk.id).state).not.toBe('complete')
    expect(chunkRow(chunk.id)).toMatchObject({ retries: 1, frame_start: 3, frame_end: 4 })
    expect(chunkStates(chunk.id)).toContain('failed')
    expect(downloaded(jobId)).toEqual([1, 2])
    expect(jobState(jobId)).not.toBe('complete')
    expect(w.alerts('warn').join('\n')).toContain('manifest')

    manifestDown = false
    await w.until(() => specs.length === 2, 'retry dispatched')
    expect(specs[1]).toMatchObject({ chunkId: chunk.id, frameStart: 3, frameEnd: 4 })
    machine.agent.finish(chunk.id)
    await w.until(() => jobState(jobId) === 'complete', 'job complete')
    expect(downloaded(jobId)).toEqual([1, 2, 3, 4])
    const states = chunkStates(chunk.id)
    expect(states.filter((s) => s === 'complete')).toHaveLength(1)
    expect(states.at(-1)).toBe('complete')
  })

  it("an agent's 'done' with a frame it never manifested is not complete", async () => {
    const { app, machine } = await oneNode()
    const jobId = await w.submitJob(app)
    const chunk = onlyChunk(jobId)
    const specs: AgentSpec[] = []
    // Blender exits 0 having written frames 1-3 of 1-4; the retry writes all.
    machine.onSpec = (spec) => {
      specs.push(spec)
      machine.agent.finish(spec.chunkId, specs.length === 1 ? { frames: [1, 2, 3] } : {})
    }
    app.scheduler.kick()

    await w.until(() => ['complete', 'partial'].includes(jobState(jobId) ?? ''), 'job settled')

    expect(jobState(jobId)).toBe('complete')
    expect(downloaded(jobId)).toEqual([1, 2, 3, 4])
    expect(chunkRow(chunk.id).retries).toBe(1)
    expect(specs.map((s) => [s.frameStart, s.frameEnd])).toEqual([
      [1, 4],
      [4, 4]
    ])
    expect(w.alerts('warn').join('\n')).toContain('never arrived')
    const states = chunkStates(chunk.id)
    expect(states.filter((s) => s === 'complete')).toHaveLength(1)
    expect(states.at(-1)).toBe('complete')
  })

  it('a job whose chunks all say complete is only complete once every frame is downloaded', async () => {
    w = await setup()
    const app = await w.boot({ start: false })
    const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 4, chunkSize: 2 })
    // Every chunk complete, frame 4 never landed: how a job read before this
    // backstop, and how any future path to 'complete' that skips the
    // scheduler's own check would leave it.
    w.db.prepare("UPDATE chunks SET state = 'complete' WHERE job_id = ?").run(jobId)
    w.db.prepare("UPDATE frames SET state = 'downloaded' WHERE job_id = ? AND frame < 4").run(jobId)

    app.jobs.refreshJobState(jobId)
    expect(jobState(jobId)).toBe('partial')

    w.db.prepare("UPDATE frames SET state = 'downloaded' WHERE job_id = ?").run(jobId)
    app.jobs.refreshJobState(jobId)
    expect(jobState(jobId)).toBe('complete')
    expect(w.eventsOf('job:changed').at(-1)).toMatchObject({ id: jobId, state: 'complete' })
  })
})

describe('what Blender saves', () => {
  it('a stereo scene saving each view to its own file completes, with no refusal and no retry', async () => {
    // Views Format 'Individual': Blender saves 0001_L.png and 0001_R.png, and
    // the agent lists both. Refusing them failed every chunk, and each retry
    // rendered the whole chunk again.
    const { app, machine } = await oneNode()
    machine.onSpec = (spec) => {
      for (let f = spec.frameStart; f <= spec.frameEnd; f += spec.frameStep) {
        for (const view of ['_L', '_R']) {
          listSaved(machine, spec.chunkId, `frames/${String(f).padStart(4, '0')}${view}.png`)
        }
      }
      machine.agent.finish(spec.chunkId, { frames: [] })
    }
    const jobId = await w.submitJob(app)
    const chunk = onlyChunk(jobId)
    app.scheduler.kick()

    await w.until(() => ['complete', 'partial'].includes(jobState(jobId) ?? ''), 'job settled')

    expect(jobState(jobId)).toBe('complete')
    expect(downloaded(jobId)).toEqual([1, 2, 3, 4])
    expect(chunkRow(chunk.id).retries).toBe(0)
    expect(w.alerts('error')).toEqual([])
  })
})

describe('frames outside the chunk', () => {
  it("a manifest line for another chunk's frame never touches that frame", async () => {
    const { app, machine } = await oneNode()
    const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 4, chunkSize: 2 })
    const [a, b] = w.all<ChunkRow>(
      'SELECT * FROM chunks WHERE job_id = ? ORDER BY frame_start',
      jobId
    )
    const specs: AgentSpec[] = []
    machine.onSpec = (spec) => {
      specs.push(spec)
      if (spec.chunkId !== a.id) return
      // Chunk a's node also lists a frame 3, which is chunk b's to render.
      listSaved(machine, a.id, 'frames/0003.png')
      machine.agent.finish(a.id)
    }
    app.scheduler.kick()
    await w.until(
      () => chunkRow(a.id).state === 'complete' && specs.length === 2,
      'a complete, b dispatched'
    )

    // Not fetched, so nothing landed on frame 3's file, and its row still
    // waits for chunk b. Not counted as lost either: a completed first time.
    const frame3 = join(w.settings.projectRoot, 'renders', jobId, 'frames', '0003.png')
    expect(downloaded(jobId)).toEqual([1, 2])
    expect(existsSync(frame3)).toBe(false)
    expect(chunkRow(a.id).retries).toBe(0)
    expect(w.alerts('error')).toEqual([])

    machine.agent.finish(b.id)
    await w.until(() => jobState(jobId) === 'complete', 'job complete')
    expect(downloaded(jobId)).toEqual([1, 2, 3, 4])
    expect(readFileSync(frame3, 'utf-8')).toBe(`fake render ${b.id} frame 3\n`)
  })
})
