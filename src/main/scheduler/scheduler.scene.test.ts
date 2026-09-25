import { createHash } from 'crypto'
import { readFileSync, writeFileSync } from 'fs'
import { afterEach, describe, expect, it } from 'vitest'
import { REMOTE_ROOT } from '../test/fakeSsh'
import { setup, type AgentStateFile, type App, type FakeMachine, type World } from '../test/harness'

// Plan 1.12 at dispatch: every chunk renders the job's copy of its scene,
// sent to a node as work/scenes/<sha>.blend, once per node. Every dispatch
// used to upload whatever was at blend_path at that moment, so a save over
// the scene mid-render changed what the rest of the job rendered (#53 #148),
// and each one hashed the whole .blend on this computer and again on the
// node, inside the node's prep lock (#188).

let w: World
afterEach(() => w.dispose())

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/** One ready node, and a record of every upload to it (the .part paths fastPut writes). */
async function oneNode(): Promise<{
  app: App
  nodeId: string
  machine: FakeMachine
  puts: string[]
}> {
  w = await setup({ settings: { maxActiveNodes: 1 } })
  const app = await w.boot()
  const nodeId = await w.readyNode(app)
  const machine = w.machineFor(nodeId)
  const puts: string[] = []
  machine.onSftp('fastPut', (path) => {
    puts.push(path)
    return undefined
  })
  return { app, nodeId, machine, puts }
}

/** The job's scene as createJob kept it. */
function sceneOf(jobId: string): { sha: string; path: string } {
  const r = w.get<{ blend_sha256: string; scene_path: string }>(
    'SELECT blend_sha256, scene_path FROM jobs WHERE id = ?',
    jobId
  )!
  return { sha: r.blend_sha256, path: r.scene_path }
}

/** Where the agent looks for a spec's scene. */
function onNode(blendFile: string): string {
  return `${REMOTE_ROOT}/work/scenes/${blendFile}`
}

/** Scene uploads among `puts`. */
function sceneUploads(puts: string[]): string[] {
  return puts.filter((p) => p.startsWith(`${REMOTE_ROOT}/work/scenes/`))
}

/** sha256sum runs over the node's scenes so far. */
function sceneHashes(machine: FakeMachine): number {
  return machine.ran(/^sha256sum '[^']*\/work\/scenes\//).length
}

function jobState(jobId: string): string | undefined {
  return w.get<{ state: string }>('SELECT state FROM jobs WHERE id = ?', jobId)?.state
}

function settled(jobId: string): boolean {
  return ['complete', 'partial', 'failed'].includes(jobState(jobId) ?? '')
}

/**
 * The agent's answer to a spec whose scene is not on the node: noderunner
 * checks before it starts Blender, and fails the chunk as transient.
 */
function failMissingScene(machine: FakeMachine, chunkId: string, blend: string): void {
  const error = `blend file missing: ${blend}`
  machine.agent.fail(chunkId, error)
  machine.agent.writeState(chunkId, {
    status: 'failed',
    error,
    exitCode: null,
    errorKind: 'transient'
  } as Partial<AgentStateFile>)
}

/** Render each spec whose scene is on the node; fail the others as the agent does. */
function renderWhenSceneThere(machine: FakeMachine): void {
  machine.onSpec = (spec) => {
    const blend = onNode(spec.blendFile)
    if (machine.files.has(blend)) machine.agent.finish(spec.chunkId)
    else failMissingScene(machine, spec.chunkId, blend)
  }
}

describe('the scene a chunk renders (plan 1.12)', () => {
  it('1.12 (#53 #148): the scene saved over after submit: every chunk renders it as submitted', async () => {
    const { app, machine } = await oneNode()
    const blend = w.blend('shot.blend')
    const submitted = readFileSync(blend)
    const jobId = await w.submitJob(app, {
      blendPath: blend,
      frameStart: 1,
      frameEnd: 6,
      chunkSize: 2
    })
    const { sha } = sceneOf(jobId)
    // The artist goes on working, and saves before any chunk is sent, and
    // again as each one lands.
    writeFileSync(blend, 'BLENDER-v402 the next revision\n')
    const rendered: Array<{ blendFile: string; scene: Buffer | undefined }> = []
    machine.onSpec = (spec) => {
      rendered.push({ blendFile: spec.blendFile, scene: machine.files.get(onNode(spec.blendFile)) })
      writeFileSync(blend, `BLENDER-v402 revision after ${spec.chunkId}\n`)
      machine.agent.finish(spec.chunkId)
    }
    app.scheduler.kick()
    await w.until(() => jobState(jobId) === 'complete', 'job complete')

    expect(rendered).toHaveLength(3)
    for (const r of rendered) {
      expect(r.blendFile).toBe(`${sha}.blend`)
      expect(r.scene).toEqual(submitted)
    }
    expect(sha).toBe(sha256(submitted))
    // The job page can say the scene has changed since.
    await w.until(
      async () => (await w.invoke('job:get', jobId))?.sceneChanged === true,
      'scene changed since submit'
    )
  })

  it('1.12 (#188): a second chunk on the node, and another job of the same scene, send nothing and hash nothing there', async () => {
    const { app, machine, puts } = await oneNode()
    machine.agent.autoFinish()
    const first = await w.submitJob(app, { frameStart: 1, frameEnd: 6, chunkSize: 2 })
    const { sha } = sceneOf(first)
    const chunks = w.all<{ id: string }>(
      'SELECT id FROM chunks WHERE job_id = ? ORDER BY frame_start',
      first
    )
    app.scheduler.kick()
    await w.until(
      () => w.get('SELECT state FROM chunks WHERE id = ?', chunks[0].id)?.state === 'complete',
      'first chunk complete'
    )
    expect(sceneUploads(puts)).toEqual([`${onNode(`${sha}.blend`)}.part`])
    const hashedForFirst = sceneHashes(machine)

    await w.until(() => jobState(first) === 'complete', 'job complete')
    // The same scene, submitted again: its copy has the same hash.
    const second = await w.submitJob(app, { frameStart: 7, frameEnd: 8, chunkSize: 2 })
    expect(sceneOf(second).sha).toBe(sha)
    app.scheduler.kick()
    await w.until(() => jobState(second) === 'complete', 'second job complete')

    expect(sceneUploads(puts)).toHaveLength(1)
    expect(sceneHashes(machine)).toBe(hashedForFirst)
    // Every chunk of both jobs rendered that one file.
    const all = w.all<{ id: string }>('SELECT id FROM chunks WHERE job_id IN (?, ?)', first, second)
    expect(all).toHaveLength(4)
    for (const c of all) expect(machine.agent.spec(c.id)?.blendFile).toBe(`${sha}.blend`)
  })

  it('1.12: a node that already holds the scene, from an earlier session, is sent nothing', async () => {
    const { app, machine, puts } = await oneNode()
    machine.agent.autoFinish()
    const jobId = await w.submitJob(app)
    const { sha, path } = sceneOf(jobId)
    machine.files.set(onNode(`${sha}.blend`), readFileSync(path))
    app.scheduler.kick()
    await w.until(() => jobState(jobId) === 'complete', 'job complete')

    expect(sceneUploads(puts)).toEqual([])
    expect(sceneHashes(machine)).toBe(1)
  })

  it('1.12: a node that lost its copy of the scene is sent it again for the retry', async () => {
    const { app, machine, puts } = await oneNode()
    const jobId = await w.submitJob(app)
    const { sha } = sceneOf(jobId)
    const [chunk] = w.all<{ id: string }>('SELECT id FROM chunks WHERE job_id = ?', jobId)
    // The first attempt finds the scene gone from the node (a disk cleaned
    // up by hand, say), as the agent reports it.
    machine.onSpec = (spec) => {
      renderWhenSceneThere(machine)
      machine.files.delete(onNode(spec.blendFile))
      failMissingScene(machine, spec.chunkId, onNode(spec.blendFile))
    }
    app.scheduler.kick()
    await w.until(() => settled(jobId), 'job settled', { timeoutMs: 30 * 60_000 })

    expect(jobState(jobId)).toBe('complete')
    expect(sceneUploads(puts)).toEqual([
      `${onNode(`${sha}.blend`)}.part`,
      `${onNode(`${sha}.blend`)}.part`
    ])
    expect(w.get('SELECT retries, infra_retries FROM chunks WHERE id = ?', chunk.id)).toEqual({
      retries: 0,
      infra_retries: 1
    })
  })

  it('1.12: a node the scheduler forgot and got back is asked again for the scenes it holds', async () => {
    const { app, nodeId, machine, puts } = await oneNode()
    renderWhenSceneThere(machine)
    const first = await w.submitJob(app)
    const { sha } = sceneOf(first)
    app.scheduler.kick()
    await w.until(() => jobState(first) === 'complete', 'first job complete')
    // The node went away and came back (recoverUnreachable) without the
    // scene: a container that was restarted from its image, say.
    app.scheduler.forgetNode(nodeId)
    machine.files.delete(onNode(`${sha}.blend`))

    const second = await w.submitJob(app)
    const [chunk] = w.all<{ id: string }>('SELECT id FROM chunks WHERE job_id = ?', second)
    app.scheduler.kick()
    await w.until(() => settled(second), 'second job settled', { timeoutMs: 30 * 60_000 })

    expect(jobState(second)).toBe('complete')
    expect(sceneUploads(puts)).toHaveLength(2)
    // Sent before the render, not after a failed one.
    expect(w.get('SELECT retries, infra_retries FROM chunks WHERE id = ?', chunk.id)).toEqual({
      retries: 0,
      infra_retries: 0
    })
  })

  it("1.12: a job's copy of its scene edited in its folder fails the job, and nothing goes up under its hash", async () => {
    const { app, machine, puts } = await oneNode()
    machine.agent.autoFinish()
    const jobId = await w.submitJob(app)
    const { sha, path } = sceneOf(jobId)
    writeFileSync(path, 'BLENDER-v402 edited in the render folder\n')
    app.scheduler.kick()
    await w.until(() => settled(jobId), 'job settled')

    expect(jobState(jobId)).toBe('failed')
    const job = await w.invoke('job:get', jobId)
    expect(job?.attention).toMatchObject({
      kind: 'scene',
      message: expect.stringContaining('has changed since the job was submitted')
    })
    expect(sceneUploads(puts)).toEqual([])
    expect(machine.files.has(onNode(`${sha}.blend`))).toBe(false)
  })

  it('1.12: a scene check with no answer is the link lost, and nothing is sent over it', async () => {
    const { app, machine, puts } = await oneNode()
    machine.agent.autoFinish()
    const jobId = await w.submitJob(app)
    const [chunk] = w.all<{ id: string }>('SELECT id FROM chunks WHERE job_id = ?', jobId)
    // The connection goes under the first check (ssh2 gives no exit status).
    machine.onExec(/^sha256sum '[^']*\/work\/scenes\//, { code: null, stdout: '' }, 1)
    app.scheduler.kick()
    await w.until(
      () =>
        w.get<{ infra_retries: number }>('SELECT infra_retries FROM chunks WHERE id = ?', chunk.id)!
          .infra_retries === 1,
      'first attempt failed'
    )
    expect(sceneUploads(puts)).toEqual([])
    expect(w.alerts('warn').join('\n')).toMatch(/connection closed under the scene check/)

    await w.until(() => jobState(jobId) === 'complete', 'job complete')
    expect(sceneUploads(puts)).toHaveLength(1)
    expect(w.get('SELECT retries FROM chunks WHERE id = ?', chunk.id)).toEqual({ retries: 0 })
  })

  it('1.12: a job from before snapshots sends its scene file as it is, under its id, as before', async () => {
    const { app, machine } = await oneNode()
    machine.agent.autoFinish()
    const blend = w.blend('legacy.blend')
    const jobId = await w.submitJob(app, { blendPath: blend })
    w.db.prepare('UPDATE jobs SET blend_sha256 = NULL, scene_path = NULL WHERE id = ?').run(jobId)
    const [chunk] = w.all<{ id: string }>('SELECT id FROM chunks WHERE job_id = ?', jobId)
    app.scheduler.kick()
    await w.until(() => jobState(jobId) === 'complete', 'job complete')

    expect(machine.agent.spec(chunk.id)?.blendFile).toBe(`${jobId}.blend`)
    expect(machine.files.get(onNode(`${jobId}.blend`))).toEqual(readFileSync(blend))
  })
})
