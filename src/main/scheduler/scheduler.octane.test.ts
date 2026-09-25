import { afterEach, describe, expect, it } from 'vitest'
import type { JobAttention } from '../../shared/models'
import { fakeOctane } from '../test/fakeOctane'
import { setup, type AgentSpec, type World } from '../test/harness'

// Plan 1.18 in the scheduler, as the Octane track handed it over (n5): a
// sign-in nobody makes holds the job rather than spending its retries, an
// Octane chunk goes only to a node that can take it, and no node is rented
// from an image that has no OctaneBlender.

let w: World
afterEach(() => w.dispose())

const MIN = 60_000

function attentionOf(jobId: string): JobAttention | null {
  const row = w.get<{ attention: string | null }>('SELECT attention FROM jobs WHERE id = ?', jobId)
  return row?.attention ? (JSON.parse(row.attention) as JobAttention) : null
}

describe('Octane in the scheduler (plan 1.18)', () => {
  it('1.18 (A1): a sign-in nobody makes holds the job, charging nothing; a node signed in later releases it', async () => {
    // Unclassified, OctaneLoginNeededError read as the job's own failure:
    // each attempt spent a render retry and counted toward the breaker,
    // and the chunk went back out to wait on nobody again.
    w = await setup({ settings: { maxActiveNodes: 1, idleTimeoutMinutes: 120 } })
    const app = await w.boot()
    const nodeId = await w.readyNode(app)
    const machine = w.machineFor(nodeId)
    const octane = fakeOctane(machine, { signIn: 'byHand' })
    const specs: AgentSpec[] = []
    machine.onSpec = (spec) => {
      specs.push(spec)
      machine.agent.finish(spec.chunkId)
    }
    const jobId = await w.submitJob(app, { engine: 'octane' })
    app.scheduler.kick()

    await w.until(() => attentionOf(jobId) != null, 'the job held for a sign-in', {
      timeoutMs: 20 * MIN,
      stepMs: 5_000
    })
    expect(attentionOf(jobId)).toMatchObject({ kind: 'engine', errorClass: 'transient' })
    expect(attentionOf(jobId)?.message).toMatch(/sign in/i)
    expect(
      w.all('SELECT retries, infra_retries, state FROM chunks WHERE job_id = ?', jobId)
    ).toEqual([{ retries: 0, infra_retries: 0, state: 'pending' }])
    await w.advance(10 * MIN, 5_000)
    expect(specs).toEqual([])

    // The user signs in on the node's desktop: the licence poll reads it,
    // and the job goes out again by itself.
    octane.state = 'licensed'
    await w.until(
      () =>
        w.get<{ state: string }>('SELECT state FROM jobs WHERE id = ?', jobId)?.state ===
        'complete',
      'job complete',
      { timeoutMs: 10 * MIN, stepMs: 5_000 }
    )
    expect(specs.map((s) => s.engine)).toEqual(['octane'])
    expect(attentionOf(jobId)).toBeNull()
  })

  it("integration review: a headless campaign's resume lifts the job's hold, never the sign-in's", async () => {
    // resumeJob released the sign-in hold for any Octane job, and a headless
    // re-run naming one did so with nobody at a desktop: every Octane rental
    // waited out its ten minutes for a sign-in again (the A1 shape).
    w = await setup({ settings: { maxActiveNodes: 1, idleTimeoutMinutes: 120 } })
    const app = await w.boot()
    const nodeId = await w.readyNode(app)
    fakeOctane(w.machineFor(nodeId), { signIn: 'byHand' })
    const jobId = await w.submitJob(app, { engine: 'octane' })
    app.scheduler.kick()
    await w.until(() => attentionOf(jobId) != null, 'the job held for a sign-in', {
      timeoutMs: 20 * MIN,
      stepMs: 5_000
    })
    expect(app.scheduler.fleetHolds().octaneSignIn).toBeDefined()

    expect(app.scheduler.resumeJob(jobId, { octaneSignIn: false })).toBe(true)
    expect(attentionOf(jobId)).toBeNull()
    expect(app.scheduler.fleetHolds().octaneSignIn).toBeDefined()
  })

  it('1.18: an Octane chunk is not sent to a node scale-up rented for another engine, and does not keep it alive', async () => {
    w = await setup({ settings: { maxActiveNodes: 1, idleTimeoutMinutes: 5 } })
    const app = await w.boot()
    w.vast.addOffer()
    const [nodeId] = await app.nodeManager.requestNodes(1, { engine: 'cycles' })
    await w.until(() => app.nodeManager.get(nodeId)?.state === 'ready', 'ready')
    const specs: AgentSpec[] = []
    w.machineFor(nodeId).onSpec = (spec) => specs.push(spec)
    await w.submitJob(app, { engine: 'octane' })
    app.scheduler.kick()
    // An image with no OctaneBlender: the chunk would fail there. And a
    // queue it cannot take kept an idle node billing for good.
    await w.until(() => app.nodeManager.get(nodeId)?.state === 'destroyed', 'the node let go', {
      timeoutMs: 15 * MIN,
      stepMs: 5_000
    })
    expect(specs).toEqual([])
    expect(w.machineFor(nodeId).ran(/setup_octane\.sh (install|start)/)).toEqual([])
  })

  it('1.18: Octane work queued with no Octane image holds back no node from the Cycles job behind it', async () => {
    // The Octane chunk at the head of the queue reserved the only node, one
    // scale-up rented for Cycles, which it is never sent (takesEngine). The
    // node drained, then sat empty for good: the Cycles job behind it was
    // refused as not the chunk it was held for, and scale-down spared it as
    // reserved. Six hours of fake time billed with nothing rendered.
    w = await setup({ settings: { maxActiveNodes: 1, spendCapPerHour: 10, idleTimeoutMinutes: 5 } })
    const app = await w.boot()
    w.vast.addOffer()
    const [nodeId] = await app.nodeManager.requestNodes(1, { engine: 'cycles' })
    await w.until(() => app.nodeManager.get(nodeId)?.state === 'ready', 'ready')
    const machine = w.machineFor(nodeId)
    const specs: AgentSpec[] = []
    machine.onSpec = (spec) => {
      specs.push(spec)
      // The first holds the node busy while the Octane chunk is at the head.
      if (specs.length > 1) machine.agent.finish(spec.chunkId)
    }
    const octaneJob = await w.submitJob(app, {
      engine: 'octane',
      frameStart: 1,
      frameEnd: 1,
      chunkSize: 1
    })
    await w.advance(1_000)
    const cyclesJob = await w.submitJob(app, {
      engine: 'cycles',
      frameStart: 1,
      frameEnd: 4,
      chunkSize: 1
    })
    app.scheduler.kick()
    await w.advance(90_000, 1_000)
    expect(specs).toHaveLength(1)
    machine.agent.finish(specs[0].chunkId)

    await w.until(
      () =>
        w.get<{ state: string }>('SELECT state FROM jobs WHERE id = ?', cyclesJob)?.state ===
        'complete',
      'the Cycles job complete',
      { timeoutMs: 10 * MIN, stepMs: 1_000 }
    )
    expect(specs.map((s) => s.engine)).toEqual(['cycles', 'cycles', 'cycles', 'cycles'])
    // Nothing here may take the Octane chunk, so the idle node is let go.
    await w.until(() => app.nodeManager.get(nodeId)?.state === 'destroyed', 'the node let go', {
      timeoutMs: 15 * MIN,
      stepMs: 5_000
    })
    expect(w.all('SELECT state FROM chunks WHERE job_id = ?', octaneJob)).toEqual([
      { state: 'pending' }
    ])
    expect(w.vast.count('createInstance')).toBe(1)
  })

  it('1.18: an Octane chunk goes back to the Octane node it failed on, not to wait on an idle Cycles node', async () => {
    // anotherTakes counted the idle Cycles node as one that could take the
    // chunk, so the node it failed on passed it over; the Cycles node never
    // may. Both billed, nothing rendered, until the idle one timed out.
    w = await setup({
      settings: { maxActiveNodes: 2, spendCapPerHour: 10, idleTimeoutMinutes: 60 }
    })
    const app = await w.boot()
    // Rented by hand, for no engine in particular: it may try Octane.
    const octaneNode = await w.readyNode(app)
    w.vast.addOffer()
    const [cyclesNode] = await app.nodeManager.requestNodes(1, { engine: 'cycles' })
    await w.until(() => app.nodeManager.get(cyclesNode)?.state === 'ready', 'ready')
    const machine = w.machineFor(octaneNode)
    fakeOctane(machine)
    const specs: AgentSpec[] = []
    machine.onSpec = (spec) => {
      specs.push(spec)
      if (specs.length > 1) return machine.agent.finish(spec.chunkId)
      // The machine's failure, not the scene's: the chunk goes back to this
      // node only when no other node may be sent it (pickChunk).
      machine.agent.fail(spec.chunkId, 'out of GPU memory on GPU 0 (exit -15)', -15)
      machine.agent.writeState(spec.chunkId, {
        status: 'failed',
        framesDone: 0,
        error: 'out of GPU memory on GPU 0 (exit -15)',
        exitCode: -15,
        errorKind: 'machine',
        oom: true
      })
    }
    const cyclesSpecs: AgentSpec[] = []
    w.machineFor(cyclesNode).onSpec = (spec) => cyclesSpecs.push(spec)
    const jobId = await w.submitJob(app, {
      engine: 'octane',
      frameStart: 1,
      frameEnd: 1,
      chunkSize: 1
    })
    app.scheduler.kick()

    await w.until(
      () =>
        w.get<{ state: string }>('SELECT state FROM jobs WHERE id = ?', jobId)?.state ===
        'complete',
      'the Octane job complete',
      { timeoutMs: 10 * MIN, stepMs: 1_000 }
    )
    expect(specs).toHaveLength(2)
    expect(cyclesSpecs).toEqual([])
    expect(w.all('SELECT infra_retries FROM chunks WHERE job_id = ?', jobId)).toEqual([
      { infra_retries: 1 }
    ])
  })

  it('1.18: Octane work with no Octane image set rents nothing, and says why once', async () => {
    w = await setup({ settings: { maxActiveNodes: 2, spendCapPerHour: 10 } })
    w.vast.addOffer()
    const app = await w.boot()
    await w.submitJob(app, { engine: 'octane' })
    app.scheduler.kick()
    await w.advance(3 * MIN, 1_000)
    expect(w.vast.count('createInstance')).toBe(0)
    expect(w.vast.count('searchOffers')).toBe(0)
    const said = w.alerts('warn').filter((m) => /Octane work is queued/.test(m))
    expect(said).toHaveLength(1)
    expect(said[0]).toMatch(/no docker image is set for Octane nodes/)
    // No scale-up failure piled up for it either.
    expect(w.alerts('warn').filter((m) => m.startsWith('scale-up failed'))).toEqual([])
  })
})
