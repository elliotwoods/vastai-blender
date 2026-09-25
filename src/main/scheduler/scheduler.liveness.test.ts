import { afterEach, describe, expect, it, vi } from 'vitest'
import { HANG, REMOTE_ROOT } from '../test/fakeSsh'
import {
  setup,
  type AgentSpec,
  type AgentStateFile,
  type App,
  type FakeMachine,
  type SetupOptions,
  type World
} from '../test/harness'

// A run that has lost its render must let go of its chunk and its lane
// (plan 1.7, the run's side of it), end to end on the lifecycle harness.
// Before, a run polled every 5 s for as long as the app ran whenever the
// agent's state file never appeared or could not be read: the chunk stayed
// 'rendering', its lane stayed taken, and its node never went idle.

let w: World
afterEach(() => w.dispose())

interface ChunkRow {
  id: string
  state: string
  node_id: string | null
  retries: number
  infra_retries: number
}

function chunksOf(jobId: string): ChunkRow[] {
  return w.all<ChunkRow>('SELECT * FROM chunks WHERE job_id = ? ORDER BY frame_start', jobId)
}

function jobState(jobId: string): string | undefined {
  return w.get<{ state: string }>('SELECT state FROM jobs WHERE id = ?', jobId)?.state
}

function nodeState(nodeId: string): string | undefined {
  return w.get<{ state: string }>('SELECT state FROM nodes WHERE id = ?', nodeId)?.state
}

/** Chunks dispatched to a node: every 'assigned' the renderer heard with its id. */
function assignedTo(nodeId: string): number {
  return w.eventsOf('chunk:changed').filter((c) => c.state === 'assigned' && c.nodeId === nodeId)
    .length
}

async function fleet(
  n: number,
  offer: { num_gpus?: number } = {},
  settings: SetupOptions['settings'] = {}
): Promise<{ app: App; ids: string[] }> {
  w = await setup({ settings: { maxActiveNodes: n, ...settings } })
  const app = await w.boot()
  const ids: string[] = []
  for (let i = 0; i < n; i++) ids.push(await w.readyNode(app, offer))
  return { app, ids }
}

/** What provision.sh base did to a node the second launch re-provisioned: its inbox emptied. */
function emptyInbox(machine: FakeMachine): string[] {
  const gone = machine.agent.inbox()
  for (const id of gone) machine.files.delete(`${REMOTE_ROOT}/jobs/inbox/${id}.json`)
  return gone
}

/** lastProgressAt (epoch s) and framesDone as an agent's render reports them at a moment. */
type Progress = () => { at: number; frames: number }

/** Write the state an agent's heartbeat writes while Blender lives, as `progressAt()` says now. */
function beat(machine: FakeMachine, chunkId: string, progressAt: Progress): void {
  const p = progressAt()
  machine.agent.writeState(chunkId, {
    status: 'rendering',
    framesDone: p.frames,
    currentFrame: p.frames + 1,
    lastProgressAt: p.at
  } as Partial<AgentStateFile>)
}

/**
 * An agent whose render runs as scripted: the state rewritten every 60 s,
 * as the agent's heartbeat does while Blender lives, with lastProgressAt
 * wherever the last frame left it, as `progressAt()` says at each beat.
 */
function heartbeat(machine: FakeMachine, chunkId: string, progressAt: Progress): () => void {
  beat(machine, chunkId, progressAt)
  const timer = setInterval(() => beat(machine, chunkId, progressAt), 60_000)
  return () => clearInterval(timer)
}

/** lastProgressAt and framesDone for frames saved at `savedMin` minutes after `start` (epoch s). */
function savedAt(start: number, savedMin: number[]): Progress {
  const saved = savedMin.map((m) => start + m * 60)
  return () => {
    const now = Date.now() / 1000
    const done = saved.filter((t) => t <= now)
    return { at: done.length ? done[done.length - 1] : start, frames: done.length }
  }
}

describe('1.7 field incident 81fe2875: phantom runs', () => {
  it('specs a second launch deleted from the inbox are requeued, and the lanes they held are used again', async () => {
    // One 4-GPU node, four lanes, four specs waiting in its inbox when a
    // second copy of the app re-provisioned it: `rm jobs/inbox/*.json`.
    const { app, ids } = await fleet(1, { num_gpus: 4 })
    const machine = w.machineFor(ids[0])
    const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 8, chunkSize: 1 })
    app.scheduler.kick()
    await w.until(() => machine.agent.inbox().length === 4, 'four specs queued')
    const lost = emptyInbox(machine)
    // The node renders whatever it is sent from here on.
    machine.agent.autoFinish()

    await w.until(() => jobState(jobId) === 'complete', 'job complete', {
      timeoutMs: 30 * 60_000,
      stepMs: 5_000
    })
    // Each lost chunk went back in the queue, charged to the machines, not
    // to the render, and was rendered on the lanes it had held.
    for (const id of lost) {
      expect(chunksOf(jobId).find((c) => c.id === id)).toMatchObject({
        state: 'complete',
        retries: 0,
        infra_retries: 1
      })
    }
    expect(w.alerts('warn').join('\n')).toMatch(/spec left the node's inbox with no render started/)
    expect(app.scheduler.activeWorkForNode(ids[0])).toEqual([])
  })

  it('a spec waiting its turn behind a render of ours, in the inbox of a live agent, is left alone', async () => {
    // Two lanes planned, and an agent that runs one render at a time (it
    // counts its lanes otherwise, as its memory ceiling may): the second
    // spec waits in its inbox for the first render to end.
    const { app, ids } = await fleet(1, { num_gpus: 2 })
    const machine = w.machineFor(ids[0])
    let first: string | null = null
    let stop = (): void => {}
    machine.onSpec = (spec) => {
      if (first != null) return
      first = spec.chunkId
      stop = heartbeat(machine, spec.chunkId, savedAt(Date.now() / 1000, []))
    }
    const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 2, chunkSize: 1 })
    app.scheduler.kick()
    await w.until(() => machine.agent.inbox().length === 2, 'both specs queued')
    // Behind a render of ours for half an hour: no state, the agent alive.
    await w.advance(30 * 60_000, 5_000)
    const waiting = chunksOf(jobId).find((c) => c.id !== first)!
    expect(waiting).toMatchObject({ state: 'rendering', infra_retries: 0 })
    expect(assignedTo(ids[0])).toBe(2)
    stop()
    machine.agent.finish(first!)
    machine.agent.finish(waiting.id)
    await w.until(() => jobState(jobId) === 'complete', 'job complete')
    expect(chunksOf(jobId).map((c) => c.infra_retries)).toEqual([0, 0])
  })

  it('a spec a live agent leaves in its inbox with nothing of ours rendering there: withdrawn, sent elsewhere, and the node let go', async () => {
    // Review round 2: something the app does not watch holds the agent's
    // lanes, as an EEVEE render the app had stopped and requeued does once
    // noderunner relaunches it on OpenGL. The next spec to the node waited
    // behind it with no bound, while the node billed for nothing we used.
    // The other node idles until the chunk comes to it, and must still be there.
    w = await setup({ settings: { maxActiveNodes: 2, idleTimeoutMinutes: 30 } })
    const app = await w.boot()
    const held = await w.readyNode(app)
    // Its agent is alive and takes nothing: its one lane is busy.
    const jobId = await w.submitJob(app)
    const [chunk] = chunksOf(jobId)
    app.scheduler.kick()
    await w.until(() => w.machineFor(held).agent.inbox().length === 1, 'spec queued')
    const queuedAt = Date.now()
    const other = await w.readyNode(app)
    w.machineFor(other).agent.autoFinish()

    await w.until(() => jobState(jobId) === 'complete', 'job complete', {
      timeoutMs: 60 * 60_000,
      stepMs: 5_000
    })
    // Given up on after its 15 minutes alone there, and charged to the machines.
    expect(Date.now() - queuedAt).toBeLessThan(25 * 60_000)
    expect(chunksOf(jobId)[0]).toMatchObject({ node_id: other, retries: 0, infra_retries: 1 })
    expect(w.machineFor(held).agent.inbox()).toEqual([])
    expect(
      w.machineFor(held).ran(new RegExp(`jobs/inbox/${chunk.id}\\.json'; pkill`))
    ).toHaveLength(1)
    expect(app.scheduler.nodeUnfit(held)).toMatch(
      /left a chunk in its inbox for 15 min with nothing of this app's rendering there/
    )
    expect(w.alerts('error').join('\n')).toMatch(
      /something else holds its GPUs.*Nothing more is sent/
    )
    // Sent nothing more, it is let go of.
    await w.until(() => nodeState(held) === 'destroyed', 'the held node let go', {
      timeoutMs: 45 * 60_000,
      stepMs: 5_000
    })
    expect(assignedTo(held)).toBe(1)
  })

  it('a node whose agent is dead: the spec is withdrawn, the chunk moves on, and the node is let go', async () => {
    const { app, ids } = await fleet(2, {}, { idleTimeoutMinutes: 5 })
    const [dead, live] = ids
    w.machineFor(dead).agent.alive = false
    // The live node renders each chunk in two minutes: work stays queued
    // while the dead one should be let go.
    const liveMachine = w.machineFor(live)
    liveMachine.onSpec = (spec) =>
      setTimeout(() => liveMachine.agent.finish(spec.chunkId), 2 * 60_000)
    const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 10, chunkSize: 1 })
    app.scheduler.kick()
    await w.until(() => assignedTo(dead) === 1, 'a chunk sent to the dead node')
    const stranded = w
      .eventsOf('chunk:changed')
      .find((c) => c.state === 'assigned' && c.nodeId === dead)!.chunkId

    await w.until(() => nodeState(dead) === 'destroyed', 'the dead node let go', {
      timeoutMs: 20 * 60_000,
      stepMs: 5_000
    })
    // Before the queue ran out: nothing but the dead agent kept it from work.
    expect(chunksOf(jobId).some((c) => c.state === 'pending')).toBe(true)
    // Sent one chunk, never another, and that one withdrawn from its inbox.
    expect(assignedTo(dead)).toBe(1)
    expect(
      w.machineFor(dead).ran(new RegExp(`jobs/inbox/${stranded}\\.json'; pkill`))
    ).toHaveLength(1)
    expect(w.alerts('error').join('\n')).toMatch(/agent is not running.*Nothing more is sent to it/)

    await w.until(() => jobState(jobId) === 'complete', 'job complete', {
      timeoutMs: 60 * 60_000,
      stepMs: 5_000
    })
    expect(chunksOf(jobId).find((c) => c.id === stranded)).toMatchObject({
      state: 'complete',
      node_id: live,
      retries: 0,
      infra_retries: 1
    })
  })

  it('an agent seen dead once and alive a minute later is not condemned: the chunk renders there', async () => {
    // A restart-agent (a second launch re-provisioning the node, or the node
    // supervisor) leaves the heartbeat stale for up to about 40 s. One stale
    // read condemned the node for the rest of its rental.
    const { app, ids } = await fleet(1, {}, { idleTimeoutMinutes: 60 })
    const machine = w.machineFor(ids[0])
    let restarting = false
    let seenDeadAt: number | null = null
    machine.onExec(/^python3 -c .*state\/heartbeat/, () => {
      if (!restarting) return 'alive\n'
      seenDeadAt ??= Date.now()
      return 'dead\n'
    })
    const landed: number[] = []
    machine.onSpec = (spec) => {
      landed.push(Date.now())
      if (landed.length > 1) return machine.agent.finish(spec.chunkId)
      // The first spec is lost to the restart, which is over in 3.5 min.
      restarting = true
      setTimeout(() => (restarting = false), 3.5 * 60_000)
    }
    const jobId = await w.submitJob(app)
    app.scheduler.kick()
    await w.until(() => jobState(jobId) === 'complete', 'job complete', {
      timeoutMs: 20 * 60_000,
      stepMs: 5_000
    })
    expect(landed).toHaveLength(2)
    expect(chunksOf(jobId)[0]).toMatchObject({ node_id: ids[0], retries: 0, infra_retries: 1 })
    expect(w.alerts('error').join('\n')).not.toMatch(/agent is not running/)
    expect(app.scheduler.nodeUnfit(ids[0])).toBeNull()
    // Sent nothing until the second look.
    expect(landed[1] - seenDeadAt!).toBeGreaterThanOrEqual(60_000)
  })

  it("the second look is taken on the node's connection as it is then, not on the run's", async () => {
    // Review round 2: the recheck used the connection the run had. Replaced
    // within the minute (the node reconnected), that one was closed, the
    // check could not run, and a node whose agent was back was condemned for
    // the rest of its rental.
    const { app, ids } = await fleet(1, {}, { idleTimeoutMinutes: 60 })
    const machine = w.machineFor(ids[0])
    let restarting = true
    machine.onExec(/^python3 -c .*state\/heartbeat/, () => (restarting ? 'dead\n' : 'alive\n'))
    const landed: AgentSpec[] = []
    machine.onSpec = (spec) => {
      landed.push(spec)
      if (landed.length > 1) machine.agent.finish(spec.chunkId)
    }
    const jobId = await w.submitJob(app)
    app.scheduler.kick()
    await w.until(() => chunksOf(jobId)[0].infra_retries === 1, 'the chunk given back')
    // Reconnected, and its agent back, before the second look.
    const node = app.nodeManager.get(ids[0])!
    node.closeSsh()
    await node.connectSsh()
    restarting = false

    await w.until(() => jobState(jobId) === 'complete', 'job complete', {
      timeoutMs: 20 * 60_000,
      stepMs: 5_000
    })
    expect(landed).toHaveLength(2)
    expect(chunksOf(jobId)[0]).toMatchObject({ node_id: ids[0], retries: 0, infra_retries: 1 })
    expect(w.alerts('error').join('\n')).not.toMatch(/agent is not running/)
    expect(app.scheduler.nodeUnfit(ids[0])).toBeNull()
  })

  it('a second look that cannot tell is no verdict: the node is asked again, and takes work once its agent answers', async () => {
    // Review round 2: a check that did not answer condemned the node for its
    // rental, as a dead agent does.
    const { app, ids } = await fleet(1, {}, { idleTimeoutMinutes: 60 })
    const machine = w.machineFor(ids[0])
    let checks = 0
    machine.onExec(/^python3 -c .*state\/heartbeat/, () => {
      checks += 1
      // Dead to the run; no answer to the second look; alive to the third.
      return checks === 1 ? 'dead\n' : checks === 2 ? HANG : 'alive\n'
    })
    const landed: AgentSpec[] = []
    machine.onSpec = (spec) => {
      landed.push(spec)
      if (landed.length > 1) machine.agent.finish(spec.chunkId)
    }
    const jobId = await w.submitJob(app)
    app.scheduler.kick()
    await w.until(() => jobState(jobId) === 'complete', 'job complete', {
      timeoutMs: 20 * 60_000,
      stepMs: 5_000
    })
    expect(checks).toBe(3)
    expect(landed).toHaveLength(2)
    expect(w.alerts('error').join('\n')).not.toMatch(/agent is not running/)
    expect(app.scheduler.nodeUnfit(ids[0])).toBeNull()
  })

  it('a node whose agent is dead is not counted as room for the queue', async () => {
    // Kept past the test, so only scale-up can make room.
    const { app, ids } = await fleet(2, {}, { maxActiveNodes: 3, idleTimeoutMinutes: 120 })
    const [dead, live] = ids
    w.machineFor(dead).agent.alive = false
    const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 2, chunkSize: 1 })
    app.scheduler.kick()
    await w.until(() => assignedTo(dead) === 1 && assignedTo(live) === 1, 'one chunk each')
    // The live node is busy with its chunk for a long while.
    w.vast.addOffer()
    await w.until(
      () => w.alerts('error').some((a) => /agent is not running/.test(a)),
      'the dead agent found'
    )
    // Its free lane read as room for the chunk it gave back: covered, so
    // nothing was rented, and the chunk waited for the live node's.
    await w.until(() => w.vast.count('createInstance') === 3, 'a node rented for it')
    expect(nodeState(dead)).not.toBe('destroyed')
    expect(chunksOf(jobId).filter((c) => c.state === 'pending')).toHaveLength(1)
  })

  it('a node that stops answering: the run gives its chunk back, and it renders elsewhere', async () => {
    // The other node idles through the ten minutes, and must still be there.
    const { app, ids } = await fleet(2, {}, { idleTimeoutMinutes: 60 })
    const jobId = await w.submitJob(app)
    const [chunk] = chunksOf(jobId)
    app.scheduler.kick()
    await w.until(() => chunksOf(jobId)[0].state === 'rendering', 'rendering')
    const silent = chunksOf(jobId)[0].node_id!
    const other = ids.find((id) => id !== silent)!
    w.machineFor(silent).agent.progress(chunk.id, 1)
    await w.advance(10_000)
    // Every read of the state fails from here on, as on a wedged link.
    w.machineFor(silent).onExec(/^cat \S*\/state\//, () =>
      Promise.reject(new Error('(SSH) Channel open failure'))
    )
    w.machineFor(other).agent.autoFinish()

    await w.until(() => jobState(jobId) === 'complete', 'job complete', {
      timeoutMs: 30 * 60_000,
      stepMs: 5_000
    })
    expect(chunksOf(jobId)[0]).toMatchObject({ node_id: other, retries: 0, infra_retries: 1 })
    expect(w.alerts('warn').join('\n')).toMatch(
      /has not answered for 10 min \(.*Channel open failure.*requeued without charging the render/
    )
    // Withdrawn on the silent node, in case it answers again.
    expect(w.machineFor(silent).ran(new RegExp(`pkill -f '${chunk.id}'`))).not.toEqual([])
  })
})

describe('1.7: a hung Blender', () => {
  it('frames saved at ten and twenty minutes, then none for 45: stopped, and only its missing frames render again', async () => {
    const { app, ids } = await fleet(1)
    const machine = w.machineFor(ids[0])
    const specs: AgentSpec[] = []
    let stop = (): void => {}
    machine.onSpec = (spec) => {
      specs.push(spec)
      if (specs.length > 1) return machine.agent.finish(spec.chunkId)
      // Frames 1 and 2 land ten minutes apart, then Blender hangs on
      // frame 3, alive.
      setTimeout(() => machine.agent.render(spec.chunkId, [1]), 10 * 60_000)
      setTimeout(() => machine.agent.render(spec.chunkId, [2]), 20 * 60_000)
      stop = heartbeat(machine, spec.chunkId, savedAt(Date.now() / 1000, [10, 20]))
    }
    // The heartbeat goes once Blender is killed, as the real one does.
    machine.onExec(/pkill -f/, () => {
      stop()
      return ''
    })
    const jobId = await w.submitJob(app)
    const [chunk] = chunksOf(jobId)
    const startedAt = Date.now()
    app.scheduler.kick()

    await w.until(() => jobState(jobId) === 'complete', 'job complete', {
      timeoutMs: 120 * 60_000,
      stepMs: 5_000
    })
    stop()
    // The node's failure the first time: charged to the machines, and the
    // retry leaves out the frames that had already landed.
    expect(chunksOf(jobId)[0]).toMatchObject({ retries: 0, infra_retries: 1 })
    expect(specs.map((s) => [s.frameStart, s.frameEnd])).toEqual([
      [1, 4],
      [3, 4]
    ])
    expect(machine.ran(new RegExp(`pkill -f '${chunk.id}'`))).not.toEqual([])
    expect(w.alerts('warn').join('\n')).toMatch(
      /Blender made no progress \(no frame started or saved\) for 4\d min while it kept running, where this job's frames have taken up to 10 min on this hardware/
    )
    // Twenty minutes of frames and 45 without one, not three times ten.
    expect(Date.now() - startedAt).toBeLessThan(75 * 60_000)
    // What its frames took goes with the job, rather than for the session.
    const kept = (app.scheduler as unknown as { frameTimes: Map<string, unknown> }).frameTimes
    expect(kept.has(jobId)).toBe(false)
  }, 20_000)

  it('a first frame of fifty minutes, then frames of twenty, is not taken for a hang', async () => {
    // The review's case: a chunk's first frame was judged against 45 min
    // alone, since the run had timed nothing yet, and killed on every attempt.
    const { app, ids } = await fleet(1)
    const machine = w.machineFor(ids[0])
    const specs: AgentSpec[] = []
    let stop = (): void => {}
    machine.onSpec = (spec) => {
      specs.push(spec)
      stop = heartbeat(machine, spec.chunkId, savedAt(Date.now() / 1000, [50, 70, 90, 110]))
      setTimeout(() => {
        stop()
        machine.agent.finish(spec.chunkId)
      }, 110 * 60_000)
    }
    const jobId = await w.submitJob(app)
    app.scheduler.kick()
    await w.until(() => jobState(jobId) === 'complete', 'job complete', {
      timeoutMs: 150 * 60_000,
      stepMs: 5_000
    })
    stop()
    expect(specs).toHaveLength(1)
    expect(chunksOf(jobId)[0]).toMatchObject({ retries: 0, infra_retries: 0 })
    expect(w.alerts().join('\n')).not.toMatch(/no progress/)
  }, 20_000)

  it("a Blender hung on the job's very first frame is stopped at three hours, not left for good", async () => {
    const { app, ids } = await fleet(1)
    const machine = w.machineFor(ids[0])
    const specs: AgentSpec[] = []
    let stop = (): void => {}
    machine.onSpec = (spec) => {
      specs.push(spec)
      if (specs.length > 1) return machine.agent.finish(spec.chunkId)
      // Started, and never a frame.
      stop = heartbeat(machine, spec.chunkId, savedAt(Date.now() / 1000, []))
    }
    machine.onExec(/pkill -f/, () => {
      stop()
      return ''
    })
    const jobId = await w.submitJob(app)
    app.scheduler.kick()
    await w.until(() => specs.length === 1, 'dispatched')
    await w.advance(175 * 60_000, 10_000)
    // Nothing is known of what the job's frames take: not yet.
    expect(specs).toHaveLength(1)
    expect(chunksOf(jobId)[0]).toMatchObject({ state: 'rendering', infra_retries: 0 })

    await w.until(() => jobState(jobId) === 'complete', 'job complete', {
      timeoutMs: 30 * 60_000,
      stepMs: 5_000
    })
    stop()
    expect(specs).toHaveLength(2)
    expect(chunksOf(jobId)[0]).toMatchObject({ retries: 0, infra_retries: 1 })
    expect(w.alerts('warn').join('\n')).toMatch(
      /no progress \(no frame started or saved\) for 18\d min while it kept running, where no frame of this job had finished on this hardware yet/
    )
  }, 30_000)

  it("what a frame takes on one GPU model does not judge another's first frame", async () => {
    w = await setup({ settings: { maxActiveNodes: 2 } })
    const app = await w.boot()
    const fast = await w.readyNode(app, { gpu_name: 'RTX 4090' })
    const slow = await w.readyNode(app, { gpu_name: 'RTX 3060' })
    const specs = new Map<string, AgentSpec[]>([
      [fast, []],
      [slow, []]
    ])
    const stops: Array<() => void> = []
    // A frame takes ten minutes on the 4090 and an hour on the 3060.
    for (const [nodeId, minutes] of [
      [fast, 10],
      [slow, 60]
    ] as const) {
      const machine = w.machineFor(nodeId)
      machine.onSpec = (spec) => {
        specs.get(nodeId)!.push(spec)
        const stop = heartbeat(machine, spec.chunkId, savedAt(Date.now() / 1000, [minutes]))
        stops.push(stop)
        setTimeout(
          () => {
            stop()
            machine.agent.finish(spec.chunkId)
          },
          (minutes + 1) * 60_000
        )
      }
    }
    const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 2, chunkSize: 1 })
    app.scheduler.kick()
    await w.until(() => jobState(jobId) === 'complete', 'job complete', {
      timeoutMs: 120 * 60_000,
      stepMs: 5_000
    })
    for (const stop of stops) stop()
    expect(specs.get(fast)).toHaveLength(1)
    expect(specs.get(slow)).toHaveLength(1)
    expect(chunksOf(jobId).map((c) => [c.retries, c.infra_retries])).toEqual([
      [0, 0],
      [0, 0]
    ])
    expect(w.alerts().join('\n')).not.toMatch(/no progress/)
  }, 20_000)

  it('frames that take twenty minutes each, and one that takes fifty, are not taken for a hang', async () => {
    const { app, ids } = await fleet(1)
    const machine = w.machineFor(ids[0])
    const specs: AgentSpec[] = []
    let stop = (): void => {}
    machine.onSpec = (spec) => {
      specs.push(spec)
      // Saved at 20, 40, 90 and 95 minutes.
      stop = heartbeat(machine, spec.chunkId, savedAt(Date.now() / 1000, [20, 40, 90, 95]))
      setTimeout(() => {
        stop()
        machine.agent.finish(spec.chunkId)
      }, 95 * 60_000)
    }
    const jobId = await w.submitJob(app)
    app.scheduler.kick()
    await w.until(() => jobState(jobId) === 'complete', 'job complete', {
      timeoutMs: 120 * 60_000,
      stepMs: 5_000
    })
    stop()
    expect(specs).toHaveLength(1)
    expect(chunksOf(jobId)[0]).toMatchObject({ retries: 0, infra_retries: 0 })
    expect(w.alerts().join('\n')).not.toMatch(/no progress/)
  }, 20_000)

  it('a light range does not judge a heavy one on the same cards: frames of ten minutes, then of an hour', async () => {
    // Review round 2: a run that had timed no frame of its own was held to
    // three times the longest frame any run of its job had shown on its
    // hardware. The light ranges save first, so a heavy range's first frame
    // was stopped at 46 min, on every attempt, and never finished: nothing
    // longer than the limit is ever saved to raise it.
    const { app, ids } = await fleet(1, { num_gpus: 2 })
    const machine = w.machineFor(ids[0])
    const specs: AgentSpec[] = []
    const stops = new Map<string, () => void>()
    machine.onSpec = (spec) => {
      specs.push(spec)
      // Frame 1 takes ten minutes, frames 2 to 5 an hour each.
      const minutes = spec.frameStart === 1 ? 10 : 60
      const stop = heartbeat(machine, spec.chunkId, savedAt(Date.now() / 1000, [minutes]))
      stops.set(spec.chunkId, stop)
      setTimeout(
        () => {
          stop()
          if (machine.agent.spec(spec.chunkId)) machine.agent.finish(spec.chunkId)
        },
        minutes * 60_000 + 30_000
      )
    }
    machine.onExec(/pkill -f '(\S+)'/, (_command, match) => {
      stops.get(match[1])?.()
      return ''
    })
    const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 5, chunkSize: 1 })
    app.scheduler.kick()
    await w.until(() => jobState(jobId) === 'complete', 'job complete', {
      timeoutMs: 4 * 60 * 60_000,
      stepMs: 5_000
    })
    for (const stop of stops.values()) stop()
    expect(specs).toHaveLength(5)
    expect(chunksOf(jobId).map((c) => [c.retries, c.infra_retries])).toEqual(
      Array.from({ length: 5 }, () => [0, 0])
    )
    expect(w.alerts().join('\n')).not.toMatch(/no progress/)
  }, 60_000)

  it('this computer asleep for three hours while frames landed: a hang after it is still stopped at 45 min', async () => {
    // Review round 2: the gap between the last read before a sleep and the
    // first after it was taken for one frame's time, eighteen frames' worth,
    // and every later run of the job on that hardware got three times that:
    // nine hours before a hung Blender was stopped.
    const { app, ids } = await fleet(1)
    const machine = w.machineFor(ids[0])
    const specs: AgentSpec[] = []
    let progress: Progress = () => ({ at: 0, frames: 0 })
    let stop = (): void => {}
    machine.onSpec = (spec) => {
      specs.push(spec)
      if (specs.length > 1) return machine.agent.finish(spec.chunkId)
      // A frame every ten minutes, 22 of them; then Blender hangs, alive.
      const saves = Array.from({ length: 22 }, (_, i) => (i + 1) * 10)
      progress = savedAt(Date.now() / 1000, saves)
      stop = heartbeat(machine, spec.chunkId, progress)
    }
    machine.onExec(/pkill -f/, () => {
      stop()
      return ''
    })
    const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 30, chunkSize: 30 })
    app.scheduler.kick()
    await w.until(() => specs.length === 1, 'dispatched')
    const dispatchedAt = Date.now()
    // Two frames seen saved, ten minutes apart.
    await w.advance(25 * 60_000, 5_000)
    // Asleep for three hours: this computer's timers stand still, while the
    // node renders on and its agent keeps its state fresh.
    vi.setSystemTime(Date.now() + 3 * 60 * 60_000)
    beat(machine, specs[0].chunkId, progress)

    await w.until(() => specs.length === 2, 'the hung render stopped and sent again', {
      timeoutMs: 3 * 60 * 60_000,
      stepMs: 5_000
    })
    stop()
    // The last frame was saved at 220 min: stopped 45 min on, not 9 h.
    const minutes = (Date.now() - dispatchedAt) / 60_000
    expect(minutes).toBeGreaterThan(265)
    expect(minutes).toBeLessThan(272)
    expect(chunksOf(jobId)[0]).toMatchObject({ retries: 0, infra_retries: 1 })
    expect(w.alerts('warn').join('\n')).toMatch(
      /no progress \(no frame started or saved\) for 4\d min while it kept running, where this job's frames have taken up to 10 min on this hardware/
    )
  }, 30_000)

  it('a render the app stopped is stopped again once the agent could have relaunched it, but not once it is sent there again', async () => {
    // Review round 2: noderunner takes the kill of an EEVEE render that saved
    // no frame for a Vulkan failure and relaunches it on OpenGL, for a chunk
    // the app has already given back, on a lane it counts as free.
    const { app, ids } = await fleet(1)
    const machine = w.machineFor(ids[0])
    const kills: Array<{ command: string; at: number }> = []
    machine.onExec(/pkill -f/, (command) => {
      kills.push({ command, at: Date.now() })
      return ''
    })
    // The first spec write's rename lands with its answer lost (#245): the
    // spec is withdrawn and its render, if the agent had started one, killed.
    machine.onSftp(
      'rename',
      (from, m) => {
        if (!from.endsWith('.tmp.json')) return undefined
        m.files.set(from.replace(/\.tmp\.json$/, '.json'), m.files.get(from)!)
        m.files.delete(from)
        return HANG
      },
      1
    )
    const jobId = await w.submitJob(app, { engine: 'eevee' })
    const [chunk] = chunksOf(jobId)
    app.scheduler.kick()
    await w.until(() => kills.length === 1, 'the spec withdrawn')
    await w.advance(40_000, 1_000)
    expect(kills.map((k) => k.command)).toEqual([
      `rm -f '${REMOTE_ROOT}/jobs/inbox/${chunk.id}.json'; pkill -f '${chunk.id}' || true`,
      `pkill -f '${chunk.id}' || true`
    ])
    expect(kills[1].at - kills[0].at).toBeGreaterThanOrEqual(30_000)

    // Sent to the node again: its own render is left alone.
    machine.onSpec = (spec) => machine.agent.progress(spec.chunkId, 0)
    await w.until(() => chunksOf(jobId)[0].state === 'rendering', 'sent again')
    app.scheduler.stopRelaunch(ids[0], chunk.id)
    await w.advance(60_000, 1_000)
    expect(kills).toHaveLength(2)
    machine.agent.finish(chunk.id)
    await w.until(() => jobState(jobId) === 'complete', 'job complete')
  })
})

describe('1.7 s3 review: the relaunch kill after a retract', () => {
  it('is still sent when the retracting run is still draining its frames 30 s later', async () => {
    // The run that retracts its spec awaits its downloader's final pass. A
    // manifest read that keeps failing held it registered past the 30 s,
    // where stopRelaunch took it for a new dispatch queueing the chunk and
    // spared the render the agent had relaunched.
    w = await setup({ settings: { maxActiveNodes: 1, idleTimeoutMinutes: 60 } })
    const app = await w.boot()
    const held = await w.readyNode(app)
    const machine = w.machineFor(held)
    const kills: number[] = []
    machine.onExec(/pkill -f '[^/]/, () => {
      kills.push(Date.now())
      return ''
    })
    const jobId = await w.submitJob(app)
    app.scheduler.kick()
    await w.until(() => machine.agent.inbox().length === 1, 'spec queued')
    // Nothing of ours renders there: the spec is given up on at 15 min, and
    // the final pass's manifest reads never answer.
    machine.onExec(/manifest\.jsonl/, HANG)
    await w.until(() => kills.length >= 1, 'the spec withdrawn', {
      timeoutMs: 30 * 60_000,
      stepMs: 5_000
    })
    await w.advance(3 * 60_000, 1_000)
    expect(kills).toHaveLength(2)
    expect(kills[1] - kills[0]).toBeGreaterThanOrEqual(30_000)
    expect(chunksOf(jobId)[0].state).not.toBe('complete')
  })
})

describe('1.8: a spec write with no answer', () => {
  it('fails at its deadline, and the chunk is sent again, charged to the machines', async () => {
    const { app, ids } = await fleet(1)
    const machine = w.machineFor(ids[0])
    // The first spec write goes out on an SFTP channel that never answers
    // it, as a channel another transfer's stall reset does (#244, #245).
    machine.onSftp('writeFile', HANG, 1)
    machine.agent.autoFinish()
    const jobId = await w.submitJob(app)
    app.scheduler.kick()
    await w.until(() => jobState(jobId) === 'complete', 'job complete', { timeoutMs: 10 * 60_000 })
    expect(chunksOf(jobId)[0]).toMatchObject({ retries: 0, infra_retries: 1 })
    expect(w.alerts('warn').join('\n')).toMatch(/SFTP write \S+\.tmp\.json: no answer for 30s/)
  })

  it('a rename the node applied with its answer lost is withdrawn before the chunk goes back', async () => {
    const { app, ids } = await fleet(1)
    const machine = w.machineFor(ids[0])
    // The node moves the spec into place and its answer never comes (a
    // channel reset under it, #245): the spec is live while the dispatch
    // fails, and an agent would render it with nobody polling it.
    machine.onSftp(
      'rename',
      (from, m) => {
        if (!from.endsWith('.tmp.json')) return undefined
        m.files.set(from.replace(/\.tmp\.json$/, '.json'), m.files.get(from)!)
        m.files.delete(from)
        return HANG
      },
      1
    )
    const jobId = await w.submitJob(app)
    const [chunk] = chunksOf(jobId)
    app.scheduler.kick()
    await w.until(
      () => w.alerts('warn').some((a) => a.startsWith(`dispatch ${chunk.id} failed`)),
      'the dispatch failed'
    )
    expect(machine.agent.inbox()).not.toContain(chunk.id)
    expect(machine.ran(new RegExp(`pkill -f '${chunk.id}'`))).toHaveLength(1)

    machine.agent.autoFinish()
    await w.until(() => jobState(jobId) === 'complete', 'job complete')
    expect(chunksOf(jobId)[0]).toMatchObject({ retries: 0, infra_retries: 1 })
  })
})

describe('1.8: a node prep that hangs', () => {
  it('releases the prep lock at its deadline: the chunks waiting on it move on, and the stuck node is let go', async () => {
    w = await setup({ settings: { maxActiveNodes: 2, idleTimeoutMinutes: 8 } })
    const app = await w.boot()
    const stuckId = await w.readyNode(app, { num_gpus: 4 })
    // Its Blender download never ends. Every dispatch to it waits on the
    // one prep lock the first one holds.
    w.machineFor(stuckId).onExec(/provision\.sh install-blender/, HANG)
    const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 4, chunkSize: 1 })
    app.scheduler.kick()
    await w.until(() => assignedTo(stuckId) === 4, 'four lanes in node prep')
    // install-blender's own ceiling is 130 min: on healthy mirrors it may
    // take that long, so nothing is given up before.
    await w.advance(125 * 60_000, 5_000)
    expect(chunksOf(jobId).map((c) => c.state)).toEqual([
      'assigned',
      'assigned',
      'assigned',
      'assigned'
    ])

    // A second node joins; it renders a chunk in four minutes.
    const otherId = await w.readyNode(app)
    const other = w.machineFor(otherId)
    other.onSpec = (spec) => setTimeout(() => other.agent.finish(spec.chunkId), 4 * 60_000)

    // At the deadline the lock goes, and the three waiting behind it with it:
    // all four back in the queue at once, charged to the machines.
    await w.until(
      () => chunksOf(jobId).every((c) => c.node_id !== stuckId || c.state !== 'assigned'),
      'the stuck node lets go of its chunks',
      { timeoutMs: 10 * 60_000 }
    )
    expect(chunksOf(jobId).map((c) => [c.retries, c.infra_retries])).toEqual([
      [0, 1],
      [0, 1],
      [0, 1],
      [0, 1]
    ])
    expect(w.alerts('warn').join('\n')).toMatch(
      /setting up the node did not finish: installing Blender 4\.2\.3 ran past its own 130 min limit/
    )

    // Sent nothing more, it is let go of while work is still queued.
    await w.until(() => nodeState(stuckId) === 'destroyed', 'the stuck node let go', {
      timeoutMs: 20 * 60_000,
      stepMs: 5_000
    })
    expect(chunksOf(jobId).some((c) => c.state === 'pending')).toBe(true)
    expect(assignedTo(stuckId)).toBe(4)
    // Forgotten with the node, not kept for good.
    expect(app.scheduler.nodeUnfit(stuckId)).toBeNull()
    await w.until(() => jobState(jobId) === 'complete', 'job complete', {
      timeoutMs: 60 * 60_000,
      stepMs: 5_000
    })
  }, 20_000)

  it('a 70-minute Blender install and a scene upload moving for 70 minutes both finish, and the chunk renders on that node', async () => {
    // The review's case: one deadline over the whole prep, 60 min, took a
    // node still installing within install-blender's own ceiling for stuck,
    // and destroyed it five minutes before the install would have finished.
    w = await setup({ settings: { maxActiveNodes: 1, idleTimeoutMinutes: 5 } })
    const app = await w.boot()
    const nodeId = await w.readyNode(app)
    const machine = w.machineFor(nodeId)
    machine.onExec(
      /provision\.sh install-blender/,
      () => new Promise((resolve) => setTimeout(() => resolve(''), 70 * 60_000))
    )
    slowUploads(app.nodeManager.get(nodeId)!.ssh, 70 * 60_000)
    machine.agent.autoFinish()
    const jobId = await w.submitJob(app)
    const startedAt = Date.now()
    app.scheduler.kick()
    await w.until(() => jobState(jobId) === 'complete', 'job complete', {
      timeoutMs: 180 * 60_000,
      stepMs: 5_000
    })
    // Both ran their whole length, one after the other.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(140 * 60_000)
    expect(chunksOf(jobId)[0]).toMatchObject({ node_id: nodeId, retries: 0, infra_retries: 0 })
    expect(assignedTo(nodeId)).toBe(1)
    expect(nodeState(nodeId)).not.toBe('destroyed')
    expect(app.scheduler.nodeUnfit(nodeId)).toBeNull()
    expect(w.alerts().join('\n')).not.toMatch(/did not finish|is stuck/)
  }, 20_000)

  it('a scene upload that never ends lets go of the prep lock at twelve hours', async () => {
    // Review round 2: a step bounded by its stall guard had no wall clock at
    // all, and the guard sees only the bytes on the wire. The scene is hashed
    // on this computer first, with no deadline: a .blend on a network volume
    // that hangs held every node's prep lock for good, its chunks 'assigned'
    // and its nodes billing. Here the transfer itself never ends.
    w = await setup({ settings: { maxActiveNodes: 1, idleTimeoutMinutes: 5 } })
    const app = await w.boot()
    const nodeId = await w.readyNode(app)
    slowUploads(app.nodeManager.get(nodeId)!.ssh, 48 * 60 * 60_000)
    const jobId = await w.submitJob(app)
    app.scheduler.kick()
    await w.until(() => assignedTo(nodeId) === 1, 'in node prep')
    await w.advance(11.9 * 60 * 60_000, 60_000)
    expect(chunksOf(jobId)[0].state).toBe('assigned')

    await w.until(() => chunksOf(jobId)[0].state !== 'assigned', 'the prep lock released', {
      timeoutMs: 30 * 60_000,
      stepMs: 5_000
    })
    expect(chunksOf(jobId)[0]).toMatchObject({ retries: 0, infra_retries: 1 })
    expect(w.alerts('warn').join('\n')).toMatch(
      /setting up the node did not finish: uploading the scene was still going after 12 h/
    )
    expect(app.scheduler.nodeUnfit(nodeId)).toMatch(/uploading the scene/)
  }, 60_000)
})

/** The SFTP channel as slowUploads handles it. */
interface UploadChannel {
  slowed?: boolean
  fastPut: (
    local: string,
    remote: string,
    opts: { step?: () => void },
    cb: (err?: Error | null) => void
  ) => void
}

/**
 * Every upload on this connection takes `ms`, reporting progress every 20 s
 * as a transfer that keeps moving does: its stall guard never fires.
 */
function slowUploads(ssh: unknown, ms: number): void {
  const conn = ssh as { sftp: (...args: unknown[]) => Promise<UploadChannel> }
  const open = conn.sftp.bind(conn)
  conn.sftp = async (...args) => {
    const sftp = await open(...args)
    if (!sftp.slowed) {
      sftp.slowed = true
      const put = sftp.fastPut.bind(sftp)
      sftp.fastPut = (local, remote, opts, cb) => {
        const moving = setInterval(() => opts.step?.(), 20_000)
        setTimeout(() => {
          clearInterval(moving)
          put(local, remote, opts, cb)
        }, ms)
      }
    }
    return sftp
  }
}
