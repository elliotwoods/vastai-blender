import { EventEmitter } from 'events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HANG, setup, type App, type World } from '../test/harness'
import { rateLimitDestroys } from '../test/vastRateLimit'
import type { FleetPort, Lifecycle, Prompt, QuitPolicy } from './lifecycle'

// Plan 1.1 on the lifecycle harness: the real nodeManager and scheduler, a
// fake Vast, and a fake of each Electron object the lifecycle adapter is
// handed (app, powerMonitor, message boxes, signals). Field incident A1:
// quitting, or closing the lid, left every rented node billing with nothing
// running to render on it, destroy it, or scale it down.

let w: World
afterEach(() => w.dispose())

/** electron's app: `before-quit` and `browser-window-created` listeners, and exit(). */
class FakeApp extends EventEmitter {
  /** Each exit(), with what was still billing on Vast at that moment. */
  readonly exits: Array<{ code: number; live: number[]; created: number[] }> = []

  exit(code = 0): void {
    this.exits.push({ code, live: w.vast.live(), created: [...w.vast.created] })
  }

  /** Cmd+Q: `before-quit`, and whether a listener held it. */
  quit(): { prevented: boolean } {
    const event = {
      prevented: false,
      preventDefault(): void {
        this.prevented = true
      }
    }
    this.emit('before-quit', event)
    return event
  }
}

/** A reply the test settles by hand. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

/** Button indexes, as the prompts lay them out. */
const DESTROY = 0
const LEAVE = 1
const CANCEL = 2
const RETRY = 0
const CONSOLE = 1
const QUIT_ANYWAY = 2

interface Rig {
  app: FakeApp
  lifecycle: Lifecycle
  power: EventEmitter
  signals: EventEmitter
  /** Every message box shown, in order. */
  dialogs: Array<Prompt<string>>
  /** Answers for the next message boxes: a button index, or a promise of one. A box with none waits for good. */
  answers: Array<number | Promise<number>>
  opened: string[]
  notes: string[]
  stderr: string[]
  closedDb: number
  ensuredWindow: number
  hooks: { accrued: number[]; reconciled: number }
}

/**
 * Install the lifecycle on the booted engine, as index.ts does, with the
 * fleet port index.ts builds (fleetPort), plus the resume hooks when asked.
 */
async function rig(
  engine: App,
  opts: { headless?: QuitPolicy; hooks?: boolean; platform?: NodeJS.Platform } = {}
): Promise<Rig> {
  const { fleetPort, installLifecycle } = await import('./lifecycle')
  // Every destroy loads octaneLicense lazily (ensureInstanceGone's Octane
  // stop). Loading it is real I/O, and until() steps the fake clock while it
  // waits: the first destroy of a world would start 15-30 s of fake time
  // late, inside the quit's 20 s budget. Loaded here, it costs nothing.
  await import('../octane/octaneLicense')
  const r: Rig = {
    app: new FakeApp(),
    lifecycle: undefined as unknown as Lifecycle,
    power: new EventEmitter(),
    signals: new EventEmitter(),
    dialogs: [],
    answers: [],
    opened: [],
    notes: [],
    stderr: [],
    closedDb: 0,
    ensuredWindow: 0,
    hooks: { accrued: [], reconciled: 0 }
  }
  const fleet: FleetPort = fleetPort(engine.nodeManager, engine.scheduler)
  if (opts.hooks) {
    fleet.accrueSleep = (ms) => r.hooks.accrued.push(ms)
    fleet.reconcile = () => r.hooks.reconciled++
  }
  r.lifecycle = installLifecycle({
    app: r.app,
    powerMonitor: r.power,
    showMessageBox: (_parent, prompt) => {
      r.dialogs.push(prompt)
      const answer = r.answers.shift()
      return answer === undefined ? new Promise<number>(() => {}) : Promise.resolve(answer)
    },
    openExternal: (url) => r.opened.push(url),
    notify: (body) => r.notes.push(body),
    frontWindow: () => null,
    ensureWindow: () => r.ensuredWindow++,
    fleet,
    closeDb: () => r.closedDb++,
    headless: opts.headless ? { policy: opts.headless } : null,
    signals: r.signals,
    stderr: (text) => r.stderr.push(text),
    // Not this machine's: a SIGHUP means a console closing only on Windows.
    platform: opts.platform ?? 'darwin'
  })
  return r
}

function instanceOf(nodeId: string): number {
  return w.get<{ instance_id: number }>('SELECT instance_id FROM nodes WHERE id = ?', nodeId)!
    .instance_id
}

function nodeState(nodeId: string): string | undefined {
  return w.get<{ state: string }>('SELECT state FROM nodes WHERE id = ?', nodeId)?.state
}

/** `count` nodes up and billing, $0.40/hr each. */
async function fleetOf(
  count: number
): Promise<{ engine: App; ids: string[]; instances: number[] }> {
  w = await setup({ settings: { maxActiveNodes: count, spendCapPerHour: 10 } })
  const engine = await w.boot()
  const ids: string[] = []
  for (let i = 0; i < count; i++) ids.push(await w.readyNode(engine))
  return { engine, ids, instances: ids.map(instanceOf) }
}

/** Two nodes up and billing, $0.40/hr each. */
async function twoNodes(): Promise<{ engine: App; ids: string[]; instances: number[] }> {
  w = await setup({ settings: { maxActiveNodes: 2 } })
  const engine = await w.boot()
  const ids = [await w.readyNode(engine), await w.readyNode(engine)]
  return { engine, ids, instances: ids.map(instanceOf) }
}

describe('quitting with nodes billing (plan 1.1, field incident A1)', () => {
  it('2 nodes, "Destroy all & quit": both instances destroyed before the app exits', async () => {
    const { engine, instances } = await twoNodes()
    const r = await rig(engine)
    r.answers.push(DESTROY)

    expect(r.app.quit().prevented).toBe(true)
    await w.until(() => r.app.exits.length > 0, 'the app to exit')

    expect(r.dialogs.map((d) => d.message)).toEqual(['2 nodes are billing $0.80/hr'])
    expect([...w.vast.destroyed].sort()).toEqual([...instances].sort())
    // Nothing billing at the moment of exit, and one exit.
    expect(r.app.exits).toEqual([{ code: 0, live: [], created: instances }])
    expect(r.closedDb).toBe(1)
    expect(w.alerts('info')).toContain('Destroying 2 nodes before quitting…')
    expect(w.alerts('error')).toEqual([])
  })

  it('"Leave running": exits at once, destroying nothing', async () => {
    const { engine, instances } = await twoNodes()
    const r = await rig(engine)
    r.answers.push(LEAVE)

    r.app.quit()
    await w.until(() => r.app.exits.length > 0, 'the app to exit')

    expect(r.app.exits).toEqual([{ code: 0, live: instances, created: instances }])
    expect(w.vast.count('destroyInstance')).toBe(0)
    expect(r.closedDb).toBe(1)
  })

  it('"Cancel": no exit, nothing destroyed, the app carries on, and the next quit asks again', async () => {
    const { engine, ids } = await twoNodes()
    const r = await rig(engine)
    r.answers.push(CANCEL)

    r.app.quit()
    await w.advance(60_000)

    expect(r.dialogs).toHaveLength(1)
    expect(r.app.exits).toEqual([])
    expect(w.vast.count('destroyInstance')).toBe(0)
    expect(ids.map(nodeState)).toEqual(['ready', 'ready'])
    // A Windows quit comes after the last window closed: the user gets one back.
    expect(r.ensuredWindow).toBe(1)
    expect(r.closedDb).toBe(0)

    r.answers.push(LEAVE)
    expect(r.app.quit().prevented).toBe(true)
    await w.until(() => r.app.exits.length > 0, 'the second quit to exit')
    expect(r.dialogs).toHaveLength(2)
  })

  it('a second Cmd+Q while the dialog is up is held, and asks nothing more', async () => {
    const { engine } = await twoNodes()
    const r = await rig(engine)
    const answer = deferred<number>()
    r.answers.push(answer.promise)

    r.app.quit()
    await w.advance(1_000)
    expect(r.app.quit().prevented).toBe(true)
    await w.advance(1_000)
    expect(r.dialogs).toHaveLength(1)

    answer.resolve(LEAVE)
    await w.until(() => r.app.exits.length > 0, 'the app to exit')
    expect(r.app.exits).toHaveLength(1)
  })

  it("1.1: a person's app, its terminal closed (npm run dev): SIGHUP twice asks once, and the answer decides", async () => {
    // 1.1 review: Electron's own handler has one shot and then puts the
    // signal back to its default, so the second SIGHUP of a closed terminal
    // killed the app with the dialog up and the fleet billing.
    const { engine, instances } = await twoNodes()
    const r = await rig(engine)
    const answer = deferred<number>()
    r.answers.push(answer.promise)

    r.signals.emit('SIGHUP')
    await w.advance(1, 1)
    r.signals.emit('SIGHUP')
    r.signals.emit('SIGINT')
    await w.advance(5_000)
    expect(r.dialogs.map((d) => d.message)).toEqual(['2 nodes are billing $0.80/hr'])
    expect(r.app.exits).toEqual([])

    answer.resolve(DESTROY)
    await w.until(() => r.app.exits.length > 0, 'the app to exit')
    expect(r.app.exits).toEqual([{ code: 0, live: [], created: instances }])
  })

  it("a person's app, Ctrl+C with nothing billing: quits at once", async () => {
    w = await setup()
    const engine = await w.boot()
    const r = await rig(engine)

    r.signals.emit('SIGINT')

    expect(r.app.exits).toEqual([{ code: 0, live: [], created: [] }])
    expect(r.dialogs).toEqual([])
  })

  it('nothing billing: the quit goes ahead at once, with no dialog', async () => {
    w = await setup()
    const engine = await w.boot()
    const r = await rig(engine)

    expect(r.app.quit().prevented).toBe(true)
    // In the same synchronous run as before-quit: nothing in flight gets a turn.
    expect(r.app.exits).toEqual([{ code: 0, live: [], created: [] }])
    expect(r.dialogs).toEqual([])
    expect(r.closedDb).toBe(1)
  })
})

describe('Destroy all that cannot confirm a destroy (plan 1.1)', () => {
  it('blocks the exit and lists the instance with the Vast.ai console; "Try again" then quits', async () => {
    const { engine, instances } = await twoNodes()
    const r = await rig(engine)
    const retry = deferred<number>()
    r.answers.push(DESTROY, retry.promise)
    // A refusal (Vast documents 400 invalid_args for DELETE), not a 5xx: a
    // destroy path that retries transient errors (plan 1.2) must still fail it.
    w.vast.fail('destroyInstance', { status: 400, message: 'invalid_args' })

    r.app.quit()
    await w.until(() => r.dialogs.length === 2, 'the failure list')

    // One DELETE failed: no exit, and the list names what is still billing.
    const [failed] = w.vast.live()
    expect(instances).toContain(failed)
    expect(r.app.exits).toEqual([])
    const list = r.dialogs[1]
    expect(list.message).toBe('1 instance may still be billing')
    expect(list.detail).toContain(`• instance ${failed} (RTX 4090, $0.40/hr): destroy failed`)
    expect(list.detail).toContain('https://cloud.vast.ai/instances/')
    await w.advance(60_000)
    expect(r.app.exits).toEqual([])

    retry.resolve(RETRY)
    await w.until(() => r.app.exits.length > 0, 'the app to exit')
    expect(r.app.exits).toEqual([{ code: 0, live: [], created: instances }])
  })

  it('"Open Vast.ai console" opens it and shows the list again; "Quit anyway" exits with it billing', async () => {
    const { engine, instances } = await twoNodes()
    const r = await rig(engine)
    r.answers.push(DESTROY, CONSOLE, QUIT_ANYWAY)
    w.vast.fail('destroyInstance', { status: 400, message: 'invalid_args' }, 20)

    r.app.quit()
    await w.until(() => r.app.exits.length > 0, 'the app to exit')

    expect(r.opened).toEqual(['https://cloud.vast.ai/instances/'])
    expect(r.dialogs.map((d) => d.message)).toEqual([
      '2 nodes are billing $0.80/hr',
      '2 instances may still be billing',
      '2 instances may still be billing'
    ])
    expect(r.app.exits).toEqual([{ code: 0, live: instances, created: instances }])
  })

  it('a DELETE Vast keeps failing: retried for the destroy budget, then listed with its error', async () => {
    const { engine } = await twoNodes()
    const r = await rig(engine)
    r.answers.push(DESTROY)
    w.vast.fail('destroyInstance', { status: 502, message: 'bad gateway' }, 100)
    const quitAt = Date.now()

    r.app.quit()
    await w.until(() => r.dialogs.length === 2, 'the failure list', { timeoutMs: 90_000 })

    // destroyNode was held to the quit's 20 s, not its own minute: the list
    // says what Vast answered, not that the quit ran out of time.
    expect(Date.now() - quitAt).toBeLessThan(30_000)
    expect(w.vast.count('destroyInstance')).toBeGreaterThan(2)
    expect(r.dialogs[1].message).toBe('2 instances may still be billing')
    expect(r.dialogs[1].detail).toMatch(
      /• instance \d+ \(RTX 4090, \$0\.40\/hr\): destroy failed: /
    )
    expect(r.dialogs[1].detail).not.toContain('no answer')
    expect(r.app.exits).toEqual([])
  })

  it('a destroy with no answer is reported after its budget, not waited on forever', async () => {
    const { engine, instances } = await twoNodes()
    const r = await rig(engine)
    const retry = deferred<number>()
    r.answers.push(DESTROY, retry.promise)
    const gate = w.vast.hold('destroyInstance')

    r.app.quit()
    await w.until(() => gate.reached, 'a DELETE held')
    const heldAt = Date.now()
    await w.until(() => r.dialogs.length === 2, 'the failure list', { timeoutMs: 90_000 })

    // 20 s for the destroy, 20 s for the Octane stop in front of it.
    expect(Date.now() - heldAt).toBeLessThan(45_000)
    expect(r.dialogs[1].message).toBe('1 instance may still be billing')
    expect(r.dialogs[1].detail).toContain('no answer from Vast.ai within 40 s')
    expect(r.app.exits).toEqual([])

    // The DELETE lands late. Try again reads the fleet afresh: nothing left.
    gate.release()
    await w.advance(1_000)
    retry.resolve(RETRY)
    await w.until(() => r.app.exits.length > 0, 'the app to exit')
    expect(r.app.exits).toEqual([{ code: 0, live: [], created: instances }])
    expect(w.vast.count('destroyInstance')).toBe(2)
  })
})

describe('Destroy all with an Octane node gone quiet (plans 1.1, 1.18)', () => {
  /** One node, licensed for Octane, whose OctaneServer stop never answers. */
  async function quietOctaneNode(): Promise<{ engine: App; id: string; instances: number[] }> {
    const { engine, ids, instances } = await fleetOf(1)
    w.db.prepare("UPDATE nodes SET octane_state = 'licensed' WHERE id = ?").run(ids[0])
    w.machineFor(ids[0]).onExec(/stop-server/, HANG)
    return { engine, id: ids[0], instances }
  }

  /**
   * The Fleet's destroy button on it, the moment before the quit: its stop
   * under way. Wrapped, since an async function would adopt the promise.
   */
  async function destroyUnderWay(engine: App, id: string): Promise<{ done: Promise<void> }> {
    const machine = w.machineFor(id)
    const done = engine.nodeManager.destroyNode(id)
    await w.until(() => machine.ran(/stop-server/).length > 0, 'the Octane stop under way')
    return { done }
  }

  it("integration review: a quit that joins the Fleet's destroy of a licensed node holds its stop to the quit's 20 s: three 502s, and it is still destroyed", async () => {
    // The destroy already under way had no budget: 35 s for the stop, and
    // the quit that joined it waited that out of its own 40 s. The DELETE's
    // retries were still pending when the quit gave up, and 'Quit anyway'
    // left the instance live.
    const { engine, id, instances } = await quietOctaneNode()
    const r = await rig(engine)
    const destroying = await destroyUnderWay(engine, id)
    r.answers.push(DESTROY, QUIT_ANYWAY)
    w.vast.fail('destroyInstance', { status: 502, message: 'bad gateway' }, 3)

    r.app.quit()
    await w.until(() => r.app.exits.length > 0, 'the app to exit', { timeoutMs: 120_000 })

    expect(r.dialogs).toHaveLength(1)
    expect(r.app.exits).toEqual([{ code: 0, live: [], created: instances }])
    await destroying.done
    expect(w.vast.count('destroyInstance')).toBe(4)
  })

  it("integration review: a session end that joins the Fleet's destroy sends its DELETE without waiting on the stop", async () => {
    const { engine, id, instances } = await quietOctaneNode()
    const r = await rig(engine)
    const win = new EventEmitter()
    r.app.emit('browser-window-created', {}, win)
    const destroying = await destroyUnderWay(engine, id)

    win.emit('session-end')
    await w.advance(3_000, 100)

    expect(w.vast.count('destroyInstance')).toBe(1)
    await w.until(() => r.app.exits.length > 0, 'the app to exit')
    expect(r.app.exits).toEqual([{ code: 0, live: [], created: instances }])
    await destroying.done
  })

  it("n5 review: a licensed node's stop does not eat the DELETE's window: two 502s, and it is still destroyed", async () => {
    // A server known to have run gets 35 s to stop, and the stop came out
    // of the quit's 40 s for the node: 5 s were left for the DELETE and its
    // retries, the quit listed the node as billing, and 'Quit anyway' left
    // it live. Under a quit's budget the stop gets the 20 s it allows for.
    const { engine, instances } = await quietOctaneNode()
    const r = await rig(engine)
    r.answers.push(DESTROY, QUIT_ANYWAY)
    w.vast.fail('destroyInstance', { status: 502, message: 'bad gateway' }, 2)

    r.app.quit()
    await w.until(() => r.app.exits.length > 0, 'the app to exit', { timeoutMs: 120_000 })

    expect(r.dialogs).toHaveLength(1)
    expect(r.app.exits).toEqual([{ code: 0, live: [], created: instances }])
  })

  it('1.1 / 1.18: a session end nobody asked about sends the DELETE without waiting on the Octane stop', async () => {
    const { engine, instances } = await quietOctaneNode()
    const r = await rig(engine)
    const win = new EventEmitter()
    r.app.emit('browser-window-created', {}, win)

    win.emit('session-end')
    await w.advance(3_000, 100)

    expect(w.vast.count('destroyInstance')).toBe(1)
    await w.until(() => r.app.exits.length > 0, 'the app to exit')
    expect(r.app.exits).toEqual([{ code: 0, live: [], created: instances }])
  })
})

describe('Destroy all against what Vast is really like (plan 1.1)', () => {
  it("six nodes and Vast's 3 s DELETE limit: all destroyed on the first pass, none listed", async () => {
    // 1.1 review: every DELETE went out at once, and Vast takes one every
    // 3 s. vastClient's 429 retry, inside the call, got them through one by
    // one, and the last ran past the quit's budget.
    w = await setup({ settings: { maxActiveNodes: 6, spendCapPerHour: 10 } })
    const engine = await w.boot()
    const ids: string[] = []
    for (let i = 0; i < 6; i++) ids.push(await w.readyNode(engine))
    const instances = ids.map(instanceOf)
    const client = await import('../vast/vastClient')
    const limit = rateLimitDestroys(w.vast, client, (m, status) => new client.VastError(m, status))
    const r = await rig(engine)
    r.answers.push(DESTROY)

    r.app.quit()
    await w.until(
      () => r.app.exits.length > 0 || r.dialogs.length > 1,
      'the app to exit, or the failure list',
      { timeoutMs: 5 * 60_000 }
    )

    expect(r.dialogs.map((d) => d.message)).toEqual(['6 nodes are billing $2.40/hr'])
    expect(r.app.exits).toEqual([{ code: 0, live: [], created: instances }])
    expect(limit.gaveUp).toBe(0)
  })

  it('a create that answered with no outcome is listed at once, not waited on', async () => {
    // 1.1 review: such a row was polled for the whole 20 s, as if its create
    // were still out, then listed as "got no answer within 20 s". Here, an
    // earlier run's rental whose create got a 5xx, which Vast cannot be
    // asked about now (the lookup by label fails too): it stays 'failed' and
    // billing, and nothing within the quit will settle it.
    w = await setup()
    const engine = await w.boot({ start: false })
    const label = 'vastai-blender 0bad0bad'
    w.db
      .prepare(
        `INSERT INTO nodes (id, state, gpu_name, num_gpus, dph_total, accumulated_cost, blender_versions, geolocation, label, create_unknown_since, last_error)
         VALUES ('0bad0bad-0000-4000-8000-000000000000', 'failed', 'RTX 4090', 1, 0.4, 0, '[]', NULL, ?, ?, 'Vast.ai server error: bad gateway (HTTP 502)')`
      )
      .run(label, Date.now() - 3_600_000)
    w.vast.fail('listInstances', { status: 503, message: 'service unavailable' }, 1_000)
    engine.nodeManager.init()
    engine.scheduler.start()
    await w.advance(1_000)
    const r = await rig(engine)
    r.answers.push(DESTROY)
    const quitAt = Date.now()

    r.app.quit()
    await w.until(() => r.dialogs.length === 2, 'the failure list')

    expect(r.dialogs[0].message).toBe('1 node is billing $0.40/hr')
    expect(r.dialogs[0].detail).not.toContain('still being rented')
    expect(Date.now() - quitAt).toBeLessThan(5_000)
    expect(r.dialogs[1].detail).toContain(
      `• the rental "${label}" (RTX 4090, $0.40/hr): Vast never answered its create; ` +
        `look for "${label}" in the Vast.ai console`
    )
    expect(w.vast.count('destroyInstance')).toBe(0)
  })
})

describe('Destroy all while the fleet is still changing (plan 1.1; Phase 0 review note)', () => {
  it('a rental whose create is still out: waits for its answer, then destroys what it rented', async () => {
    w = await setup()
    const engine = await w.boot()
    w.vast.addOffer()
    const gate = w.vast.hold('createInstance')
    const renting = engine.nodeManager.requestNodes(1)
    await w.until(() => gate.reached, 'the create in flight')
    const r = await rig(engine)
    r.answers.push(DESTROY)

    r.app.quit()
    expect(r.dialogs[0]?.message).toBe('1 node is billing $0.40/hr')
    await w.advance(5_000)
    // Exiting now would leave the create to rent an instance nobody destroys.
    expect(r.app.exits).toEqual([])

    gate.release()
    await renting
    await w.until(() => r.app.exits.length > 0, 'the app to exit')
    const [instance] = w.vast.created
    expect(r.app.exits).toEqual([{ code: 0, live: [], created: [instance] }])
    expect(w.vast.argsOf('destroyInstance')).toEqual([[instance]])
  })

  it('1.1: a create still out after its 20 s: listed, and what it rents when it answers is destroyed with no Try again', async () => {
    // 1.1 review: the row was listed but left 'requested'. A reply after the
    // budget (a PUT can take 30 s, then 1.4's lookup a minute more) drove
    // the instance to ready, billing behind the failure list until the user
    // pressed Try again, if they did.
    w = await setup()
    const engine = await w.boot()
    w.vast.addOffer()
    const gate = w.vast.hold('createInstance')
    const renting = engine.nodeManager.requestNodes(1)
    await w.until(() => gate.reached, 'the create in flight')
    const r = await rig(engine)
    const retry = deferred<number>()
    r.answers.push(DESTROY, retry.promise)

    r.app.quit()
    await w.until(() => r.dialogs.length === 2, 'the failure list')
    expect(r.dialogs[1].detail).toContain('Vast never answered its create')

    // The reply comes while the list is up, and nobody presses anything.
    gate.release()
    await renting
    const [instance] = w.vast.created
    await w.until(() => w.vast.live().length === 0, 'its instance destroyed', {
      timeoutMs: 2 * 60_000
    })
    expect(w.vast.argsOf('destroyInstance')).toEqual([[instance]])
    expect(r.app.exits).toEqual([])

    retry.resolve(RETRY)
    await w.until(() => r.app.exits.length > 0, 'the app to exit')
    expect(r.app.exits).toEqual([{ code: 0, live: [], created: [instance] }])
  })

  it('a scale-up batch already under way: its create in flight is destroyed, and it rents nothing more', async () => {
    // requestNodes read the caps before its first await, so each destroy
    // freed room for the batch's next rental, and it rented it.
    w = await setup({ settings: { maxActiveNodes: 3 } })
    const engine = await w.boot()
    const first = await w.readyNode(engine)
    w.vast.addOffer()
    w.vast.addOffer()
    const gate = w.vast.hold('createInstance')
    const batch = engine.nodeManager.requestNodes(2)
    await w.until(() => gate.reached, "the batch's first create in flight")
    const r = await rig(engine)
    r.answers.push(DESTROY)

    r.app.quit()
    await w.advance(1_000)
    gate.release()
    await batch
    await w.until(() => r.app.exits.length > 0, 'the app to exit')

    // The first node, and the one create already out when Destroy all began.
    expect(w.vast.count('createInstance')).toBe(2)
    expect(w.vast.created).toHaveLength(2)
    expect(w.vast.created).toContain(instanceOf(first))
    expect(r.app.exits).toEqual([{ code: 0, live: [], created: w.vast.created }])
  })

  it('1.1: Destroy all mid-render with room under maxActiveNodes rents nothing, and sends no chunk anywhere', async () => {
    // 1.1 review: every destroy requeues its node's chunks and kicks the
    // scheduler, and a stopped scheduler still ticked. The requeued chunks
    // went straight back to the dying nodes, burning a retry each, and
    // scalePolicy rented two more RTX 4090s into the room the destroys
    // freed, drove them to ready and gave them work, all during the one
    // action meant to stop spending.
    w = await setup({ settings: { maxActiveNodes: 2 } })
    const engine = await w.boot()
    const ids = [await w.readyNode(engine), await w.readyNode(engine)]
    const instances = ids.map(instanceOf)
    const landed: string[] = []
    for (const id of ids) {
      w.machineFor(id).onSpec = (spec) => landed.push(`${id.slice(0, 8)} ${spec.chunkId}`)
    }
    // Four exclusive chunks: one on each node, two waiting for room.
    await w.submitJob(engine, { frameStart: 1, frameEnd: 16, chunkSize: 4 })
    engine.scheduler.kick()
    await w.until(() => landed.length === 2, 'a chunk on each node')
    await w.advance(5_000)
    expect(w.vast.created).toEqual(instances)
    const r = await rig(engine)
    r.answers.push(DESTROY)

    // Room for two more, and offers to fill it: what a tick would rent into.
    w.settings.maxActiveNodes = 4
    w.vast.addOffer()
    w.vast.addOffer()
    r.app.quit()
    await w.until(() => r.app.exits.length > 0, 'the app to exit')

    expect(w.vast.created).toEqual(instances)
    expect(landed).toHaveLength(2)
    expect(r.app.exits).toEqual([{ code: 0, live: [], created: instances }])
    expect(w.alerts('info').filter((m) => m.startsWith('scale-up'))).toEqual([])
  })

  it('1.1: Destroy all sends nothing: a chunk requeued off one dying node is not dispatched to the next', async () => {
    // The first destroy's forgetNode requeued its chunk and kicked, and the
    // tick sent it to the node still waiting its turn, which was destroyed
    // next: the chunk was requeued, and charged, a second time.
    w = await setup()
    const engine = await w.boot()
    const busy = await w.readyNode(engine, { dph_total: 0.5 })
    const landed: string[] = []
    w.machineFor(busy).onSpec = (spec) => landed.push(`busy ${spec.chunkId}`)
    await w.submitJob(engine)
    engine.scheduler.kick()
    await w.until(() => landed.length === 1, 'the chunk on the first node')
    const idle = await w.readyNode(engine)
    w.machineFor(idle).onSpec = (spec) => landed.push(`idle ${spec.chunkId}`)
    const r = await rig(engine)
    r.answers.push(DESTROY)

    r.app.quit()
    await w.until(() => r.app.exits.length > 0, 'the app to exit')

    expect(landed).toHaveLength(1)
    expect(w.alerts('warn').filter((m) => m.includes('requeued'))).toHaveLength(1)
    expect(w.all('SELECT state, node_id FROM chunks')).toEqual([
      { state: 'pending', node_id: null }
    ])
    expect(r.app.exits).toEqual([{ code: 0, live: [], created: w.vast.created }])
  })

  it('a destroy already under way is joined, not sent a second time', async () => {
    w = await setup()
    const engine = await w.boot()
    const id = await w.readyNode(engine)
    const instance = instanceOf(id)
    const gate = w.vast.hold('destroyInstance')
    // The Fleet's destroy button, or the idle scale-down, just before the quit.
    const destroying = engine.nodeManager.destroyNode(id)
    await w.until(() => gate.reached, 'the DELETE in flight')
    const r = await rig(engine)
    r.answers.push(DESTROY)

    r.app.quit()
    await w.advance(2_000)
    gate.release()
    await destroying
    await w.until(() => r.app.exits.length > 0, 'the app to exit')

    expect(w.vast.argsOf('destroyInstance')).toEqual([[instance]])
    expect(r.app.exits).toEqual([{ code: 0, live: [], created: [instance] }])
    expect(w.alerts('error')).toEqual([])
  })
})

describe('headless runs follow VR_QUIT_POLICY, never a dialog (plan 1.1)', () => {
  it('SIGTERM, policy destroy: every node destroyed, then exit 0', async () => {
    const { engine, instances } = await twoNodes()
    const r = await rig(engine, { headless: 'destroy' })

    r.signals.emit('SIGTERM')
    await w.until(() => r.app.exits.length > 0, 'the run to exit')

    expect(r.dialogs).toEqual([])
    expect(r.app.exits).toEqual([{ code: 0, live: [], created: instances }])
  })

  it('a quit (the window, Cmd+Q) follows the policy too', async () => {
    const { engine, instances } = await twoNodes()
    const r = await rig(engine, { headless: 'destroy' })

    expect(r.app.quit().prevented).toBe(true)
    await w.until(() => r.app.exits.length > 0, 'the run to exit')

    expect(r.dialogs).toEqual([])
    expect(r.app.exits).toEqual([{ code: 0, live: [], created: instances }])
  })

  it('SIGINT, policy leave: exits 3 and names the nodes it left billing', async () => {
    const { engine, instances } = await twoNodes()
    const r = await rig(engine, { headless: 'leave' })

    r.signals.emit('SIGINT')

    expect(r.app.exits).toEqual([{ code: 3, live: instances, created: instances }])
    expect(r.stderr.join('')).toContain('SIGINT: leaving 2 nodes billing $0.80/hr')
    for (const i of instances) expect(r.stderr.join('')).toContain(`instance ${i} `)
  })

  it('a destroy that keeps failing: three passes, then exit 3 with the list on stderr', async () => {
    const { engine, instances } = await twoNodes()
    const r = await rig(engine, { headless: 'destroy' })
    const [stuck] = instances
    w.vast.fail('destroyInstance', { status: 400, message: 'invalid_args' }, 50)

    r.signals.emit('SIGTERM')
    await w.until(() => r.app.exits.length > 0, 'the run to exit')

    expect(r.app.exits[0].code).toBe(3)
    expect(r.app.exits[0].live).toContain(stuck)
    expect(
      w.vast.argsOf('destroyInstance').filter(([i]) => i === stuck).length
    ).toBeGreaterThanOrEqual(3)
    const err = r.stderr.join('')
    expect(err).toContain('2 instances may still be billing')
    expect(err).toContain(`instance ${stuck} (RTX 4090, $0.40/hr): destroy failed`)
  })

  it('a second SIGINT, 2 s or more after the first, exits at once, with 3', async () => {
    const { engine } = await twoNodes()
    const r = await rig(engine, { headless: 'destroy' })
    w.vast.hold('destroyInstance')

    r.signals.emit('SIGINT')
    expect(r.stderr.join('')).toContain('Ctrl+C again, 2 s or more from now, exits without waiting')
    await w.advance(2_000)
    expect(r.app.exits).toEqual([])
    r.signals.emit('SIGINT')

    expect(r.app.exits).toHaveLength(1)
    expect(r.app.exits[0].code).toBe(3)
    expect(r.stderr.join('')).toContain('SIGINT again: exiting without waiting')
  })

  it('a1 review: SIGINT then SIGTERM, a supervisor escalating, is not "asked twice": the destroy carries on', async () => {
    const { engine, instances } = await twoNodes()
    const r = await rig(engine, { headless: 'destroy' })
    const gate = w.vast.hold('destroyInstance')

    r.signals.emit('SIGINT')
    await w.advance(3_000)
    r.signals.emit('SIGTERM')
    expect(r.app.exits).toEqual([])
    gate.release()
    await w.until(() => r.app.exits.length > 0, 'the app to exit')
    expect(r.app.exits).toEqual([{ code: 0, live: [], created: instances }])
  })

  it('1.1: terminal closed: SIGHUP twice, 1 ms apart, still destroys every node, exit 0', async () => {
    // 1.1 review, field incident A1 again: a closed terminal sends SIGHUP
    // twice, 0.4 ms apart (the shell resends it to its jobs, then the kernel
    // to the foreground group). The second was taken for "exit now": the
    // destroy the first had started was abandoned 0.4 ms in, exit 3, to a
    // terminal no longer there, and both nodes billed on.
    const { engine, instances } = await twoNodes()
    const r = await rig(engine, { headless: 'destroy' })

    r.signals.emit('SIGHUP')
    await w.advance(1, 1)
    r.signals.emit('SIGHUP')
    await w.until(() => r.app.exits.length > 0, 'the run to exit')

    expect(r.app.exits).toEqual([{ code: 0, live: [], created: instances }])
  })

  it('1.1: one Ctrl+C delivered twice (the electron CLI forwards it): the destroy carries on, exit 0', async () => {
    const { engine, instances } = await twoNodes()
    const r = await rig(engine, { headless: 'destroy' })

    r.signals.emit('SIGINT')
    await w.advance(1, 1)
    r.signals.emit('SIGINT')
    await w.until(() => r.app.exits.length > 0, 'the run to exit')

    expect(r.app.exits).toEqual([{ code: 0, live: [], created: instances }])
  })

  it('1.1: the campaign done, then one Ctrl+C during its destroy: the destroy carries on, exit 0', async () => {
    // 1.1 review: the first Ctrl+C a user sent, while the destroy the
    // campaign's end had started was under way, was taken for their second.
    w = await setup()
    const engine = await w.boot()
    const instance = instanceOf(await w.readyNode(engine))
    const r = await rig(engine, { headless: 'destroy' })
    const gate = w.vast.hold('destroyInstance')
    r.lifecycle.watchCampaign(openJobs)
    await w.until(() => gate.reached, "the campaign end's DELETE in flight")

    r.signals.emit('SIGINT')
    await w.advance(5_000)
    expect(r.app.exits).toEqual([])
    expect(r.stderr.join('')).toContain('Ctrl+C again, 2 s or more from now, exits without waiting')

    gate.release()
    await w.until(() => r.app.exits.length > 0, 'the run to exit')
    expect(r.app.exits).toEqual([{ code: 0, live: [], created: [instance] }])
  })

  it('the campaign done, its destroy under way: Ctrl+C, and again 2 s later, exits 3', async () => {
    w = await setup()
    const engine = await w.boot()
    const instance = instanceOf(await w.readyNode(engine))
    const r = await rig(engine, { headless: 'destroy' })
    const gate = w.vast.hold('destroyInstance')
    r.lifecycle.watchCampaign(openJobs)
    await w.until(() => gate.reached, "the campaign end's DELETE in flight")

    r.signals.emit('SIGINT')
    await w.advance(2_000)
    r.signals.emit('SIGINT')

    expect(r.app.exits).toEqual([{ code: 3, live: [instance], created: [instance] }])
    expect(r.stderr.join('')).toContain(`SIGINT again: exiting without waiting; 1 instance may`)
  })

  it('the campaign done: policy destroy destroys the fleet and exits 0', async () => {
    w = await setup()
    const engine = await w.boot()
    const nodeId = await w.readyNode(engine)
    const instance = instanceOf(nodeId)
    const { agent } = w.machineFor(nodeId)
    const r = await rig(engine, { headless: 'destroy' })
    const jobId = await w.submitJob(engine)
    r.lifecycle.watchCampaign(openJobs)
    engine.scheduler.kick()

    // Still rendering: the run carries on.
    await w.until(() => agent.inbox().length === 1, 'the spec to land')
    const [chunkId] = agent.inbox()
    agent.progress(chunkId, 1, 2)
    await w.advance(90_000)
    expect(r.app.exits).toEqual([])

    agent.finish(chunkId)
    await w.until(() => jobState(jobId) === 'complete', 'the job to complete')
    await w.until(() => r.app.exits.length > 0, 'the run to exit')
    expect(r.app.exits).toEqual([{ code: 0, live: [], created: [instance] }])
  })

  it('a campaign with a part never submitted: ends when the rest is done, exit 1, and says why', async () => {
    // 1.1 review: a spec that did not parse left no job open, so the run
    // destroyed the fleet and exited 0, as if the campaign had rendered.
    w = await setup()
    const engine = await w.boot()
    const nodeId = await w.readyNode(engine)
    const instance = instanceOf(nodeId)
    const r = await rig(engine, { headless: 'destroy' })
    r.lifecycle.watchCampaign(openJobs, ['/scenes/missing.blend: no such file'])

    await w.until(() => r.app.exits.length > 0, 'the run to exit')

    expect(r.app.exits).toEqual([{ code: 1, live: [], created: [instance] }])
    expect(r.stderr.join('')).toContain(
      'campaign done, but not all of it was submitted:\n  /scenes/missing.blend: no such file\n'
    )
  })

  it("1.14 review: a spec refused whole ends the run at once; an earlier run's open job does not render on", async () => {
    // Its settings could not be put in force (app/headless/jobSpec.ts), so
    // nothing was submitted. Waiting out the job an earlier run left open
    // would render it at the saved caps, which the campaign did not ask for.
    w = await setup()
    const engine = await w.boot()
    const nodeId = await w.readyNode(engine)
    const instance = instanceOf(nodeId)
    const { agent } = w.machineFor(nodeId)
    const r = await rig(engine, { headless: 'destroy' })
    const jobId = await w.submitJob(engine)
    engine.scheduler.kick()
    await w.until(() => agent.inbox().length === 1, "the earlier run's chunk to land")

    r.lifecycle.endCampaign([
      "/campaign/smoke.json: the spec's settings cannot all be put in force"
    ])
    await w.until(() => r.app.exits.length > 0, 'the run to exit')

    expect(r.app.exits).toEqual([{ code: 1, live: [], created: [instance] }])
    expect(jobState(jobId)).not.toBe('complete')
    expect(r.stderr.join('')).toContain(
      'the campaign was not submitted, so the run ends now:\n' +
        "  /campaign/smoke.json: the spec's settings cannot all be put in force\n"
    )
  })

  it('a spec refused whole, policy leave: exits at once, leaving the node as the policy asks (3)', async () => {
    w = await setup()
    const engine = await w.boot()
    const instance = instanceOf(await w.readyNode(engine))
    const r = await rig(engine, { headless: 'leave' })

    r.lifecycle.endCampaign(['/campaign/smoke.json: refused'])
    await w.until(() => r.app.exits.length > 0, 'the run to exit')

    expect(r.app.exits).toEqual([{ code: 3, live: [instance], created: [instance] }])
    expect(w.vast.count('destroyInstance')).toBe(0)
  })

  it("a person's app: endCampaign does nothing", async () => {
    w = await setup()
    const engine = await w.boot()
    await w.readyNode(engine)
    const r = await rig(engine)
    r.lifecycle.endCampaign(['/campaign/smoke.json: refused'])
    await w.advance(60_000)
    expect(r.app.exits).toEqual([])
    expect(w.vast.count('destroyInstance')).toBe(0)
  })

  it('the campaign done, policy leave: the run stays up for the idle scale-down', async () => {
    w = await setup({ settings: { idleTimeoutMinutes: 5 } })
    const engine = await w.boot()
    const nodeId = await w.readyNode(engine)
    w.machineFor(nodeId).agent.autoFinish()
    const r = await rig(engine, { headless: 'leave' })
    const jobId = await w.submitJob(engine)
    r.lifecycle.watchCampaign(openJobs)
    engine.scheduler.kick()

    await w.until(() => jobState(jobId) === 'complete', 'the job to complete')
    await w.advance(3 * 60_000)
    expect(r.app.exits).toEqual([])
  })

  it("a person's app never stops by itself when its jobs are done", async () => {
    w = await setup()
    const engine = await w.boot()
    await w.readyNode(engine)
    const r = await rig(engine)
    r.lifecycle.watchCampaign(openJobs)
    await w.advance(3 * 60_000)
    expect(r.app.exits).toEqual([])
  })
})

describe('Windows session end (plan 1.1)', () => {
  /** A window, as `browser-window-created` hands it over. */
  function openWindow(r: Rig): EventEmitter {
    const win = new EventEmitter()
    r.app.emit('browser-window-created', {}, win)
    return win
  }

  /** Windows asks the window whether the session may end: whether it was held. */
  function querySessionEnd(win: EventEmitter): boolean {
    let held = false
    win.emit('query-session-end', { reasons: ['shutdown'], preventDefault: () => (held = true) })
    return held
  }

  it('shutting down with nodes billing: held until the fleet is destroyed, with no dialog, then exits', async () => {
    // 1.1 review: 'session-end' alone started the destroy as Windows was
    // about to end the process, and nothing got as far as a DELETE.
    const { engine, instances } = await twoNodes()
    const r = await rig(engine)
    const win = openWindow(r)

    expect(querySessionEnd(win)).toBe(true)
    await w.until(() => r.app.exits.length > 0, 'the app to exit')

    expect(r.dialogs).toEqual([])
    expect(r.app.exits).toEqual([{ code: 0, live: [], created: instances }])
  })

  it('every window is asked: each is held, and the fleet is destroyed once', async () => {
    const { engine, instances } = await twoNodes()
    const r = await rig(engine)
    const wins = [openWindow(r), openWindow(r)]

    expect(wins.map(querySessionEnd)).toEqual([true, true])
    await w.until(() => r.app.exits.length > 0, 'the app to exit')

    expect(w.vast.count('destroyInstance')).toBe(2)
    expect(r.app.exits).toEqual([{ code: 0, live: [], created: instances }])
  })

  it('nothing billing: the shutdown is not held, and the session end exits', async () => {
    w = await setup()
    const engine = await w.boot()
    const r = await rig(engine)
    const win = openWindow(r)

    expect(querySessionEnd(win)).toBe(false)
    expect(r.app.exits).toEqual([])
    win.emit('session-end')
    expect(r.app.exits).toEqual([{ code: 0, live: [], created: [] }])
  })

  it('headless, VR_QUIT_POLICY=leave: not held, and the session end leaves the nodes, exit 3', async () => {
    const { engine, instances } = await twoNodes()
    const r = await rig(engine, { headless: 'leave' })
    const win = openWindow(r)

    expect(querySessionEnd(win)).toBe(false)
    win.emit('session-end')
    expect(r.app.exits).toEqual([{ code: 3, live: instances, created: instances }])
  })

  it('a session end nobody asked about still starts the destroy', async () => {
    const { engine, instances } = await twoNodes()
    const r = await rig(engine)
    const win = openWindow(r)

    win.emit('session-end')
    await w.until(() => r.app.exits.length > 0, 'the app to exit')

    expect(r.dialogs).toEqual([])
    expect(r.app.exits).toEqual([{ code: 0, live: [], created: instances }])
  })

  it('takes over from a quit dialog left unanswered', async () => {
    const { engine, instances } = await twoNodes()
    const r = await rig(engine)
    const win = openWindow(r)
    const answer = deferred<number>()
    r.answers.push(answer.promise)

    r.app.quit()
    await w.advance(1_000)
    expect(querySessionEnd(win)).toBe(true)
    await w.until(() => r.app.exits.length > 0, 'the app to exit')
    expect(r.app.exits).toEqual([{ code: 0, live: [], created: instances }])

    // The dialog's late answer changes nothing.
    answer.resolve(LEAVE)
    await w.advance(1_000)
    expect(r.app.exits).toHaveLength(1)
  })

  it('1.1: a person closing the last window with nodes billing: kept for the dialog, which a shutdown then takes over', async () => {
    // 1.1 review: the dialog came up with the window already gone, and with
    // it what Windows asks before a shutdown or an update's restart.
    const { engine, instances } = await twoNodes()
    const r = await rig(engine)
    const win = openWindow(r)
    r.answers.push(deferred<number>().promise)

    expect(r.lifecycle.holdWindowClose()).toBe(true)
    await w.advance(1_000)
    expect(r.dialogs.map((d) => d.message)).toEqual(['2 nodes are billing $0.80/hr'])
    // Closed again while it asks: still kept, and asked only the once.
    expect(r.lifecycle.holdWindowClose()).toBe(true)

    expect(querySessionEnd(win)).toBe(true)
    await w.until(() => r.app.exits.length > 0, 'the app to exit')
    expect(r.dialogs).toHaveLength(1)
    expect(r.app.exits).toEqual([{ code: 0, live: [], created: instances }])
  })

  it('a window closing with nothing billing, or in a headless run, is let go', async () => {
    w = await setup()
    const engine = await w.boot()
    const r = await rig(engine)
    expect(r.lifecycle.holdWindowClose()).toBe(false)
    expect(r.dialogs).toEqual([])

    await w.readyNode(engine)
    const headless = await rig(engine, { headless: 'destroy' })
    expect(headless.lifecycle.holdWindowClose()).toBe(false)
    expect(headless.app.exits).toEqual([])
  })

  it('1.1: a session end nobody asked about: each destroy starts once the one before it is done, not 3 s apart', async () => {
    // 'session-end': the process may be ended at any moment.
    const { engine, instances } = await fleetOf(6)
    const r = await rig(engine)
    const win = openWindow(r)

    win.emit('session-end')
    await w.advance(2_000, 100)

    expect(w.vast.count('destroyInstance')).toBe(6)
    await w.until(() => r.app.exits.length > 0, 'the app to exit')
    expect(r.app.exits).toEqual([{ code: 0, live: [], created: instances }])
  })
})

describe('Windows: the console closing (SIGHUP) ends the process 5 to 10 s later (plan 1.1)', () => {
  it("1.1: a headless run's console closed: each destroy starts once the one before it is done, not 3 s apart", async () => {
    // 1.1 review: Windows ends the process about 5 to 10 s after the
    // console closes, and one DELETE every 3 s sent only the first 2 to 4.
    const { engine, instances } = await fleetOf(6)
    const r = await rig(engine, { headless: 'destroy', platform: 'win32' })

    r.signals.emit('SIGHUP')
    await w.advance(2_000, 100)

    expect(w.vast.count('destroyInstance')).toBe(6)
    await w.until(() => r.app.exits.length > 0, 'the run to exit')
    expect(r.app.exits).toEqual([{ code: 0, live: [], created: instances }])
  })

  it("under Vast's 3 s DELETE limit: no fewer through in 10 s than one every 3 s", async () => {
    // Why not every DELETE at once: Vast takes one and refuses the rest,
    // and vastClient retries those 2, 6 and 14 s later. All at once got 2
    // of these 6 through in 10 s.
    const { engine } = await fleetOf(6)
    const client = await import('../vast/vastClient')
    rateLimitDestroys(w.vast, client, (m, status) => new client.VastError(m, status))
    const r = await rig(engine, { headless: 'destroy', platform: 'win32' })

    r.signals.emit('SIGHUP')
    await w.advance(10_000, 100)

    expect(w.vast.count('destroyInstance')).toBeGreaterThanOrEqual(4)
  })

  it("a person's app: no dialog can be answered in time, so it goes as a session end, taking over the one that is up", async () => {
    const { engine, instances } = await fleetOf(3)
    const r = await rig(engine, { platform: 'win32' })
    const answer = deferred<number>()
    r.answers.push(answer.promise)
    r.app.quit()
    await w.advance(1_000)

    r.signals.emit('SIGHUP')
    await w.advance(2_000, 100)

    expect(w.vast.count('destroyInstance')).toBe(3)
    await w.until(() => r.app.exits.length > 0, 'the app to exit')
    expect(r.dialogs).toHaveLength(1)
    expect(r.app.exits).toEqual([{ code: 0, live: [], created: instances }])
    answer.resolve(LEAVE)
    await w.advance(1_000)
    expect(r.app.exits).toHaveLength(1)
  })

  it('elsewhere a SIGHUP is a terminal, and the 3 s turns stand', async () => {
    const { engine } = await fleetOf(3)
    const r = await rig(engine, { headless: 'destroy', platform: 'linux' })

    r.signals.emit('SIGHUP')
    await w.advance(2_000, 100)

    expect(w.vast.count('destroyInstance')).toBe(1)
  })
})

describe('sleep (plan 1.1, #45)', () => {
  it('going to sleep with nodes billing: an alert and an OS notification', async () => {
    const { engine } = await twoNodes()
    const r = await rig(engine)

    r.power.emit('suspend')

    const warning =
      'Going to sleep with 2 nodes billing $0.80/hr: they keep billing while this computer ' +
      'sleeps, and nothing renders or downloads until it wakes'
    expect(w.alerts('warn')).toContain(warning)
    expect(r.notes).toEqual([warning])
  })

  it('on waking: what the sleep cost, then the resume hooks (accrual, reconcile)', async () => {
    const { engine } = await twoNodes()
    const r = await rig(engine, { hooks: true })

    r.power.emit('suspend')
    // Asleep: timers do not run, the wall clock moves on.
    const sleptMs = 2 * 3_600_000
    vi.setSystemTime(Date.now() + sleptMs)
    r.power.emit('resume')

    expect(w.alerts('warn')).toContain(
      'Awake after 2 h: 2 nodes billed about $1.60 while this computer slept, ' +
        'with nothing rendering or downloading'
    )
    expect(r.hooks).toEqual({ accrued: [sleptMs], reconciled: 1 })
  })

  it('nothing billing: sleep and wake pass without a word', async () => {
    w = await setup()
    const engine = await w.boot()
    const r = await rig(engine, { hooks: true })

    r.power.emit('suspend')
    r.power.emit('resume')

    expect(w.alerts()).toEqual([])
    expect(r.notes).toEqual([])
    // The hooks run anyway: a reconcile on waking is for what the app does not know of.
    expect(r.hooks.reconciled).toBe(1)
  })
})

function openJobs(): number {
  return w.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM jobs WHERE state IN ('queued', 'running')"
  )!.n
}

function jobState(jobId: string): string | undefined {
  return w.get<{ state: string }>('SELECT state FROM jobs WHERE id = ?', jobId)?.state
}
