import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OctaneState } from '../../shared/models'
import { fakeOctane } from '../test/fakeOctane'
import { setup, type AgentSpec, type World } from '../test/harness'

// Plan 1.18 on the lifecycle harness: a node's Octane state as the fleet
// sees it (NodeSnapshot.octaneState, kept from setup_octane.sh's lines), the
// licence poll that notices a sign-in made by hand on the node's desktop,
// and the first Octane chunk on a new node, which waits for that sign-in
// rather than rendering unlicensed (#85) or failing at once. By default no
// OTOY credential is sent anywhere (#40 #156).

let w: World
beforeEach(async () => {
  w = await setup({
    settings: { maxActiveNodes: 1 },
    secrets: { vastApiKey: 'k', otoyUsername: 'artist@example.com', otoyPassword: 'hunter2' }
  })
})
afterEach(() => w.dispose())

const SEC = 1_000
const MIN = 60 * SEC

function octaneStates(nodeId: string): Array<OctaneState | undefined> {
  return w
    .eventsOf('node:changed')
    .filter((s) => s.id === nodeId)
    .map((s) => s.octaneState)
    .filter((s, i, all) => i === 0 || s !== all[i - 1])
}

describe('1.18: Octane on a node, as the fleet sees it', () => {
  it('1.18: the first Octane chunk on a new node waits for the sign-in by hand, and renders once it is made', async () => {
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

    await w.until(
      () => app.nodeManager.get(nodeId)?.snapshot.octaneState === 'needsLogin',
      'needs a sign-in',
      { timeoutMs: 3 * MIN }
    )
    const snap = app.nodeManager.get(nodeId)!.snapshot
    expect(snap).toMatchObject({ octaneReady: false, octaneNeedsManualLogin: true })
    expect(w.alerts('warn')).toEqual([
      expect.stringMatching(/^Octane on RTX 4090 \w{8} is waiting for a sign-in: .*Open VNC login/)
    ])
    await w.advance(2 * MIN)
    expect(specs).toEqual([])

    // The user signs in on the node's desktop.
    octane.state = 'licensed'
    await w.until(
      () =>
        w.get<{ state: string }>('SELECT state FROM jobs WHERE id = ?', jobId)?.state ===
        'complete',
      'job complete',
      { timeoutMs: 2 * MIN }
    )
    expect(specs.map((s) => s.engine)).toEqual(['octane'])
    expect(app.nodeManager.get(nodeId)!.snapshot).toMatchObject({
      octaneState: 'licensed',
      octaneReady: true,
      octaneNeedsManualLogin: false
    })
    expect(octaneStates(nodeId)).toEqual(['none', 'serverRunning', 'needsLogin', 'licensed'])
    expect(w.alerts('info')).toContain(
      `Octane on RTX 4090 ${nodeId.slice(0, 8)} is signed in: its Octane chunks can render`
    )
    expect(octane.launches).toBe(1)
    // The sign-in was by hand: no credential went anywhere.
    expect(machine.ran(/hunter2|artist@|OCTANE_USER|OCTANE_PASS|--credentials-stdin/)).toEqual([])
  })

  it('1.18: the licence poll notices a sign-in made outside any dispatch, and a server that died', async () => {
    const app = await w.boot()
    const nodeId = await w.readyNode(app)
    const machine = w.machineFor(nodeId)
    const octane = fakeOctane(machine, { signIn: 'byHand' })
    octane.state = 'serverRunning'
    w.db.prepare(`UPDATE nodes SET octane_state = 'needsLogin' WHERE id = ?`).run(nodeId)

    octane.state = 'licensed'
    await w.until(
      () => app.nodeManager.get(nodeId)?.snapshot.octaneState === 'licensed',
      'licensed by the poll',
      { timeoutMs: 45 * SEC }
    )
    expect(w.eventsOf('node:changed').at(-1)).toMatchObject({ id: nodeId, octaneReady: true })

    octane.state = 'none'
    await w.until(
      () => app.nodeManager.get(nodeId)?.snapshot.octaneState === 'none',
      'none once the server died',
      { timeoutMs: 45 * SEC }
    )
    expect(app.nodeManager.get(nodeId)!.snapshot.octaneReady).toBe(false)
    // And from then on it is not polled: nothing of Octane runs there.
    const reads = machine.ran(/setup_octane\.sh status/).length
    await w.advance(2 * MIN)
    expect(machine.ran(/setup_octane\.sh status/)).toHaveLength(reads)
  })

  it('1.18: a node that never ran Octane is never asked about it', async () => {
    const app = await w.boot()
    const nodeId = await w.readyNode(app)
    await w.advance(3 * MIN)
    expect(w.machineFor(nodeId).ran(/setup_octane/)).toEqual([])
    expect(app.nodeManager.get(nodeId)!.snapshot).toMatchObject({
      octaneState: 'none',
      octaneReady: false,
      octaneNeedsManualLogin: false
    })
  })

  it('1.18 (#85): a row an older build marked octane_ready is not taken for a licence', async () => {
    const app = await w.boot()
    const nodeId = await w.readyNode(app)
    w.db.prepare(`UPDATE nodes SET octane_ready = 1 WHERE id = ?`).run(nodeId)
    expect(app.nodeManager.get(nodeId)!.snapshot).toMatchObject({
      octaneState: 'none',
      octaneReady: false
    })
  })
})
