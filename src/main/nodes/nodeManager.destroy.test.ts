import { randomUUID } from 'crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NodeState } from '../../shared/models'
import { HANG, setup, type App, type World } from '../test/harness'

// Plan 1.2: one billing predicate and one destroy path. A node may be billing
// while it holds an instance Vast has not confirmed gone, or while a create
// for it has an unknown outcome, whatever its state says; for all that time
// it counts against maxActiveNodes and the spend cap, is metered, and is in
// the fleet $/hr. Every destroy goes through ensureInstanceGone, which
// retries Vast's blips, takes a 404 as done, confirms a DELETE with
// showInstance, and leaves an unconfirmed one 'failed' and retried every
// minute until Vast confirms it.
//
// The field case behind it (#64 #194): one Vast blip during an unattended
// idle scale-down left the destroy 'failed'. From then on the caps, the
// meter, History and the toolbar all skipped an instance that was still
// billing, and the scheduler rented a replacement next to it.

let w: World
beforeEach(async () => {
  w = await setup()
})
afterEach(() => w.dispose())

/** The label a rental made this session carries (plan 1.3): this profile's install id, then the node's. */
function labelOf(nodeId: string): string {
  return `vastai-blender ${w.settings.installId!.slice(0, 8)}:${nodeId.slice(0, 8)}`
}

/** A promise's outcome, readable synchronously from inside w.until(). */
function watch<T>(p: Promise<T>): { done: boolean; value?: T; error?: unknown } {
  const s: { done: boolean; value?: T; error?: unknown } = { done: false }
  p.then(
    (value) => Object.assign(s, { done: true, value }),
    (error) => Object.assign(s, { done: true, error })
  )
  return s
}

/**
 * The engine, loaded and wired but not started: init() is the test's to
 * call, after seeding what the last run left. Nothing here needs the
 * scheduler running.
 */
function bootNodes(): Promise<App> {
  return w.boot({ start: false })
}

/** A 503 from Vast on DELETE, as vastClient's request() throws it. */
function unavailable(instanceId: number): { status: number; message: string } {
  return {
    status: 503,
    message: `vast.ai DELETE /instances/${instanceId}/ → 503: service unavailable`
  }
}

interface NodeRowView {
  state: NodeState
  instance_id: number | null
  destroyed_at: number | null
  create_unknown_since: number | null
  last_error: string | null
  accumulated_cost: number
}

function row(id: string): NodeRowView {
  const r = w.get<NodeRowView>(
    `SELECT state, instance_id, destroyed_at, create_unknown_since, last_error, accumulated_cost
     FROM nodes WHERE id = ?`,
    id
  )
  if (!r) throw new Error(`no row ${id}`)
  return r
}

/** Minutes metered for a node so far (one cost_log row per accrual tick). */
function meteredTicks(nodeId: string): number {
  return w.get<{ n: number }>('SELECT COUNT(*) AS n FROM cost_log WHERE node_id = ?', nodeId)!.n
}

/** The fleet $/hr of the latest fleet:cost push. */
function lastFleetRate(): number | undefined {
  return w.eventsOf('fleet:cost').at(-1)?.perHour
}

/**
 * A node row as the last run left it, on the instance given (or none).
 * Mirrors what rentOffer and driveToReady write.
 */
function seedRow(
  state: NodeState,
  opts: {
    instanceId?: number | null
    createUnknownSince?: number | null
    destroyedAt?: number | null
    id?: string
  } = {}
): string {
  const id = opts.id ?? randomUUID()
  w.db
    .prepare(
      `INSERT INTO nodes (id, instance_id, state, gpu_name, num_gpus, dph_total, started_at,
         accumulated_cost, blender_versions, label, destroyed_at, create_unknown_since)
       VALUES (?, ?, ?, 'RTX 4090', 1, 0.4, ?, 0, '[]', ?, ?, ?)`
    )
    .run(
      id,
      opts.instanceId ?? null,
      state,
      opts.instanceId != null ? Date.now() - 3_600_000 : null,
      `vastai-blender ${id.slice(0, 8)}`,
      opts.destroyedAt ?? null,
      opts.createUnknownSince ?? null
    )
  return id
}

describe('1.2 ensureInstanceGone: a destroy is done when Vast confirms it', () => {
  it('DELETE 503 twice, then 200: counted, metered and in the fleet $/hr until confirmed (#64 #194)', async () => {
    const app = await bootNodes()
    app.nodeManager.init()
    const id = await w.readyNode(app)
    const [instanceId] = w.vast.created

    // Two blips, then a DELETE the test holds so time can pass mid-destroy.
    w.vast.fail('destroyInstance', unavailable(instanceId), 2)
    const third = w.vast.hold('destroyInstance')
    const destroying = watch(app.nodeManager.destroyNode(id))
    await w.until(() => third.reached, 'the third DELETE')

    // Not confirmed yet: still billing, and counted as billing.
    expect(row(id)).toMatchObject({ state: 'destroying', destroyed_at: null })
    expect(app.nodeManager.activeCount()).toBe(1)
    expect(app.nodeManager.billingPerHour()).toBeCloseTo(0.4)
    const ticks = meteredTicks(id)
    await w.advance(61_000)
    expect(meteredTicks(id)).toBe(ticks + 1)
    expect(lastFleetRate()).toBeCloseTo(0.4)
    // The retry timer fired meanwhile, and joined the destroy in flight.
    expect(w.vast.count('destroyInstance')).toBe(3)

    third.release()
    await w.until(() => destroying.done, 'destroy finished')
    expect(destroying.error).toBeUndefined()

    const after = row(id)
    expect(after.state).toBe('destroyed')
    expect(after.destroyed_at).not.toBeNull()
    expect(w.vast.live()).toEqual([])
    // Confirmed by asking after the DELETE, not by the DELETE's word.
    expect(w.vast.calls.at(-1)?.method).toBe('showInstance')
    expect(app.nodeManager.activeCount()).toBe(0)
    expect(app.nodeManager.billingPerHour()).toBe(0)
    // The blips were ridden out inside the call: nothing to alarm anyone.
    expect(w.alerts('error')).toEqual([])

    const done = meteredTicks(id)
    await w.advance(61_000)
    expect(meteredTicks(id)).toBe(done)
    expect(lastFleetRate()).toBe(0)
  })

  it('a DELETE answered 404 is the instance gone: destroyed and stamped, no alarm (#34)', async () => {
    const app = await bootNodes()
    app.nodeManager.init()
    const id = await w.readyNode(app)
    const [instanceId] = w.vast.created
    // Gone behind the app's back (the Vast console, or a destroy whose reply
    // was lost): Vast answers the app's DELETE with 404.
    await w.vast.destroyInstance(instanceId)

    await app.nodeManager.destroyNode(id)

    expect(row(id).state).toBe('destroyed')
    expect(row(id).destroyed_at).not.toBeNull()
    expect(w.vast.count('destroyInstance')).toBe(2)
    expect(w.alerts('error')).toEqual([])
    expect(app.nodeManager.activeCount()).toBe(0)
  })

  it('a DELETE answered 410 is the instance gone too, as vastClient reads it (n2 review)', async () => {
    const app = await bootNodes()
    app.nodeManager.init()
    const id = await w.readyNode(app)
    // Vast destroys it and answers 410 Gone. Read as a refusal, it was
    // 'failed', alerted, and retried every minute for an instance that was
    // no more.
    w.vast.loseReply('destroyInstance', { status: 410, message: 'gone' })

    await app.nodeManager.destroyNode(id)

    expect(row(id).state).toBe('destroyed')
    expect(row(id).destroyed_at).not.toBeNull()
    expect(w.vast.live()).toEqual([])
    expect(w.alerts('error')).toEqual([])
  })

  it('a DELETE Vast accepts while it still lists the instance is not a destroy (#140)', async () => {
    const app = await bootNodes()
    app.nodeManager.init()
    const id = await w.readyNode(app)
    // One DELETE answered 200 that did nothing: the instance runs on.
    const vast = w.vast
    const destroy = vast.destroyInstance.bind(vast)
    let ignored = 0
    vast.destroyInstance = async (instance: number): Promise<void> => {
      if (ignored++ > 0) return destroy(instance)
      vast.calls.push({ method: 'destroyInstance', args: [instance], at: Date.now() })
    }

    const destroying = watch(app.nodeManager.destroyNode(id))
    await w.until(() => destroying.done, 'destroy finished')

    expect(w.vast.count('destroyInstance')).toBe(2)
    expect(w.vast.live()).toEqual([])
    expect(row(id)).toMatchObject({ state: 'destroyed' })
    expect(row(id).destroyed_at).not.toBeNull()
    expect(w.alerts('error')).toEqual([])
  })

  it('the destroy button pressed twice sends one DELETE (#113)', async () => {
    const app = await bootNodes()
    app.nodeManager.init()
    const id = await w.readyNode(app)
    const del = w.vast.hold('destroyInstance')
    const first = watch(app.nodeManager.destroyNode(id))
    await w.until(() => del.reached, 'DELETE in flight')
    const second = watch(app.nodeManager.destroyNode(id))
    del.release()
    await w.until(() => first.done && second.done, 'both destroys finished')

    expect(w.vast.count('destroyInstance')).toBe(1)
    expect(row(id).state).toBe('destroyed')
    expect(w.alerts('error')).toEqual([])
  })

  it('a destroy Vast keeps failing stays counted, blocks a replacement, and is retried every minute until confirmed (#194)', async () => {
    const app = await bootNodes()
    app.nodeManager.init()
    w.settings.maxActiveNodes = 1
    const id = await w.readyNode(app)
    const [instanceId] = w.vast.created
    // Vast is down for longer than one ensureInstanceGone rides out.
    w.vast.fail('destroyInstance', unavailable(instanceId), 12)

    // The idle scale-down's destroy.
    const destroying = watch(app.nodeManager.destroyNode(id))
    await w.until(() => destroying.done, 'destroy given up for now', { stepMs: 1_000 })
    expect(row(id)).toMatchObject({ state: 'failed', destroyed_at: null })
    expect(row(id).last_error).toContain('503')
    const [alarm] = w.alerts('error')
    expect(w.alerts('error')).toHaveLength(1)
    expect(alarm).toContain(`Destroy failed for instance ${instanceId}`)
    expect(alarm).toContain('Vast.ai console')

    // Still billing, so it is still counted: no replacement next to it.
    expect(app.nodeManager.activeCount()).toBe(1)
    expect(app.nodeManager.billingPerHour()).toBeCloseTo(0.4)
    w.vast.addOffer()
    await expect(app.nodeManager.requestNodes(1)).resolves.toEqual([])
    expect(w.vast.count('createInstance')).toBe(1)

    // Metered every minute and retried every minute, with no second alarm,
    // until Vast answers.
    const ticks = meteredTicks(id)
    await w.until(() => row(id).state === 'destroyed', 'destroy confirmed', {
      timeoutMs: 20 * 60_000,
      stepMs: 5_000
    })
    expect(meteredTicks(id)).toBeGreaterThan(ticks)
    expect(row(id).accumulated_cost).toBeGreaterThan(0)
    expect(w.vast.count('destroyInstance')).toBe(13)
    expect(w.vast.live()).toEqual([])
    expect(row(id).destroyed_at).not.toBeNull()
    expect(w.alerts('error')).toHaveLength(1)
    expect(
      w.alerts('info').some((m) => m.includes(`Instance ${instanceId} is destroyed now`))
    ).toBe(true)
    expect(app.nodeManager.activeCount()).toBe(0)

    // Room again under the cap.
    await expect(app.nodeManager.requestNodes(1)).resolves.toHaveLength(1)
  })

  it('OctaneServer is stopped before the DELETE, and a stop that hangs holds it up 20 s at most (1.18)', async () => {
    const app = await bootNodes()
    app.nodeManager.init()
    const id = await w.readyNode(app)
    const machine = w.machineFor(id)
    let deletesBeforeStop = -1
    machine.onExec(/octane-server\.pid/, () => {
      deletesBeforeStop = w.vast.count('destroyInstance')
      return HANG
    })

    const start = Date.now()
    const destroying = watch(app.nodeManager.destroyNode(id))
    await w.until(() => destroying.done, 'destroy finished', { stepMs: 1_000 })

    const [stop] = machine.ran(/octane-server\.pid/)
    // Only where setup_octane.sh left a pidfile does the stop run.
    expect(stop).toMatch(
      /^if \[ -f \/root\/vastai\/state\/octane-server\.pid \]; then .*setup_octane\.sh stop-server/
    )
    expect(deletesBeforeStop).toBe(0)
    const del = w.vast.calls.find((c) => c.method === 'destroyInstance')!
    expect(del.at - start).toBeGreaterThanOrEqual(20_000)
    expect(del.at - start).toBeLessThanOrEqual(21_000)
    expect(row(id).state).toBe('destroyed')
  })

  it("a server the app knows ran gets the script's 30 s to exit cleanly, 35 s at most (1.18 review 2)", async () => {
    // Its clean exit is what gives the OTOY seat back; one cut off at 20 s
    // mid-shutdown could hold the seat until OTOY timed it out.
    const app = await bootNodes()
    app.nodeManager.init()
    const id = await w.readyNode(app)
    w.db.prepare(`UPDATE nodes SET octane_state = 'licensed' WHERE id = ?`).run(id)
    let stopAnswered = false
    w.machineFor(id).onExec(/octane-server\.pid/, async () => {
      // The server takes 28 s to exit, inside the script's own wait.
      await new Promise((resolve) => setTimeout(resolve, 28_000))
      stopAnswered = true
      return 'OCTANE_STOPPED clean\n'
    })

    const start = Date.now()
    const destroying = watch(app.nodeManager.destroyNode(id))
    await w.until(() => destroying.done, 'destroy finished', { stepMs: 1_000 })
    const del = w.vast.calls.find((c) => c.method === 'destroyInstance')!
    expect(stopAnswered).toBe(true)
    expect(del.at - start).toBeGreaterThanOrEqual(28_000)
    expect(del.at - start).toBeLessThanOrEqual(29_000)

    // A stop that hangs is still bounded.
    const other = await w.readyNode(app)
    w.db.prepare(`UPDATE nodes SET octane_state = 'needsLogin' WHERE id = ?`).run(other)
    w.machineFor(other).onExec(/octane-server\.pid/, () => HANG)
    const t = Date.now()
    const second = watch(app.nodeManager.destroyNode(other))
    await w.until(() => second.done, 'second destroy finished', { stepMs: 1_000 })
    const del2 = w.vast.calls.filter((c) => c.method === 'destroyInstance')[1]
    expect(del2.at - t).toBeGreaterThanOrEqual(35_000)
    expect(del2.at - t).toBeLessThanOrEqual(36_000)
    expect(row(other).state).toBe('destroyed')
  })
})

describe('1.2 at start-up: what the last run left', () => {
  it("a row left 'destroying' is destroyed, not resumed (#168, D1)", async () => {
    const app = await bootNodes()
    const inst = w.vast.addInstance()
    const machine = w.vast.machine(inst.id)
    const id = seedRow('destroying', { instanceId: inst.id })
    let provisioned = 0
    app.nodeManager.onReady = async () => {
      provisioned++
    }

    app.nodeManager.init()
    // Counted as billing from the start, until the destroy is confirmed.
    expect(app.nodeManager.activeCount()).toBe(1)
    await w.until(() => row(id).state === 'destroyed', 'destroyed')

    expect(w.vast.argsOf('destroyInstance')).toEqual([[inst.id]])
    expect(w.vast.live()).toEqual([])
    expect(row(id).destroyed_at).not.toBeNull()
    // Never re-provisioned, never back in the fleet.
    expect(machine.connects).toBe(0)
    expect(provisioned).toBe(0)
    const states = w
      .eventsOf('node:changed')
      .filter((s) => s.id === id)
      .map((s) => s.state)
    expect(states).not.toContain('provisioning')
    expect(states).not.toContain('ready')
    expect(app.nodeManager.activeCount()).toBe(0)
  })

  it('a failed row holding an instance is metered and counted, and destroyed by the retries (#64)', async () => {
    const app = await bootNodes()
    const id = randomUUID()
    // Under its row's label, so the orphan sweep sees it too.
    const inst = w.vast.addInstance({ label: `vastai-blender ${id.slice(0, 8)}` })
    seedRow('failed', { id, instanceId: inst.id })
    w.vast.fail('destroyInstance', unavailable(inst.id), 12)

    app.nodeManager.init()
    expect(app.nodeManager.activeCount()).toBe(1)
    expect(app.nodeManager.billingPerHour()).toBeCloseTo(0.4)
    await w.advance(3 * 60_000, 1_000)
    // Billing all along, and charged as such: one metered minute per tick.
    expect(meteredTicks(id)).toBe(3)
    expect(lastFleetRate()).toBeCloseTo(0.4)
    expect(row(id).accumulated_cost).toBeCloseTo((0.4 / 60) * 3)
    expect(row(id)).toMatchObject({ state: 'failed', destroyed_at: null })
    // The orphan sweep left it to the retries: its row holds it.
    expect(w.alerts('warn').filter((m) => m.includes('orphan'))).toEqual([])

    await w.until(() => row(id).state === 'destroyed', 'destroy confirmed', {
      timeoutMs: 20 * 60_000,
      stepMs: 5_000
    })
    expect(w.vast.count('destroyInstance')).toBe(13)
    expect(w.vast.live()).toEqual([])
    expect(app.nodeManager.activeCount()).toBe(0)
    const ticks = meteredTicks(id)
    await w.advance(2 * 60_000, 5_000)
    expect(meteredTicks(id)).toBe(ticks)
  })

  it('rows an older build marked destroyed without confirmation are confirmed: a live instance destroyed, a gone one stamped', async () => {
    const app = await bootNodes()
    const live = w.vast.addInstance()
    const gone = w.vast.addInstance()
    await w.vast.destroyInstance(gone.id)
    const stillBilling = seedRow('destroyed', { instanceId: live.id })
    const settled = seedRow('destroyed', { instanceId: gone.id })
    const confirmedBefore = seedRow('destroyed', { instanceId: 424242, destroyedAt: 1 })

    app.nodeManager.init()
    expect(app.nodeManager.activeCount()).toBe(2)
    await w.until(
      () => row(stillBilling).destroyed_at != null && row(settled).destroyed_at != null,
      'both confirmed'
    )

    expect(w.vast.live()).toEqual([])
    // One DELETE each, and none for the row confirmed long ago.
    expect(
      w.vast
        .argsOf('destroyInstance')
        .slice(1)
        .map(([i]) => i)
        .sort()
    ).toEqual([live.id, gone.id].sort())
    expect(row(confirmedBefore).destroyed_at).toBe(1)
    expect(w.alerts('error')).toEqual([])
    expect(app.nodeManager.activeCount()).toBe(0)
  })

  it('creates the last run never heard back from: one found by its label is destroyed, the rest stop counting', async () => {
    const app = await bootNodes()
    // A reply lost after Vast created the instance...
    const lost = seedRow('failed', { createUnknownSince: Date.now() - 60_000 })
    const inst = w.vast.addInstance({ label: `vastai-blender ${lost.slice(0, 8)}` })
    // ...and a crash mid-create that rented nothing.
    const crashed = seedRow('requested')

    app.nodeManager.init()
    // Until the sweep has looked, both may be billing.
    expect(app.nodeManager.activeCount()).toBe(2)
    await w.until(
      () => row(lost).destroyed_at != null && row(crashed).state === 'failed',
      'both settled'
    )

    expect(row(lost)).toMatchObject({
      state: 'destroyed',
      instance_id: inst.id,
      create_unknown_since: null
    })
    expect(w.vast.live()).toEqual([])
    expect(row(crashed)).toMatchObject({ instance_id: null, create_unknown_since: null })
    expect(app.nodeManager.activeCount()).toBe(0)
  })
})

describe('1.2 (Phase 0 review): a create with no known outcome counts as billing', () => {
  it('a rental cancelled mid-create whose reply is lost fills its place under the cap until its label lookup finds it (plans 1.2, 1.4)', async () => {
    const app = await bootNodes()
    app.nodeManager.init()
    w.settings.maxActiveNodes = 1
    w.vast.addOffer()
    w.vast.addOffer()
    const gate = w.vast.hold('createInstance')
    const renting = watch(app.nodeManager.requestNodes(1))
    await w.until(() => gate.reached, 'createInstance in flight')
    const [{ id }] = w.all<{ id: string }>('SELECT id FROM nodes')
    const label = labelOf(id)
    await app.nodeManager.destroyNode(id)
    // Vast rents it, the reply is lost, and Vast then stops answering the
    // lookup too: for a minute and then some, nothing is known either way.
    w.vast.fail(
      'listInstances',
      { status: 503, message: 'vast.ai GET /instances/?owner=me → 503: service unavailable' },
      12
    )
    gate.loseReply(new Error('read ECONNRESET'))
    await w.until(() => renting.done, 'the batch gives up waiting', { stepMs: 1_000 })
    expect(renting.value).toEqual([id])
    const [instanceId] = w.vast.created

    // Not 'destroyed', which would say nothing is billing: 'destroying',
    // counted, until the lookup knows.
    expect(row(id)).toMatchObject({ state: 'destroying', instance_id: null })
    expect(row(id).create_unknown_since).not.toBeNull()
    expect(app.nodeManager.activeCount()).toBe(1)
    expect(app.nodeManager.billingPerHour()).toBeCloseTo(0.4)
    const errors = w.alerts('error')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain(label)
    expect(errors[0]).toContain('Vast.ai console')
    // So the next rental waits: the instance may be billing under its label.
    await expect(app.nodeManager.requestNodes(1)).resolves.toEqual([])
    expect(w.vast.count('createInstance')).toBe(1)
    // Nor can the row be hidden as destroyed: there is no id to destroy yet.
    await app.nodeManager.destroyNode(id)
    expect(row(id).state).toBe('destroying')
    await expect(app.nodeManager.clearFailed()).resolves.toBe(0)

    // Vast answers again: the lookup finds it by its label, records it on
    // the row and destroys it.
    await w.until(() => row(id).state === 'destroyed', 'found and destroyed', {
      timeoutMs: 10 * 60_000,
      stepMs: 5_000
    })
    expect(w.vast.live()).toEqual([])
    expect(w.vast.argsOf('destroyInstance')).toEqual([[instanceId]])
    expect(row(id)).toMatchObject({
      state: 'destroyed',
      instance_id: instanceId,
      create_unknown_since: null
    })
    expect(app.nodeManager.activeCount()).toBe(0)
    expect(w.alerts('error')).toHaveLength(1)
  })

  it('a create Vast refused is known to have rented nothing, and does not count', async () => {
    const app = await bootNodes()
    app.nodeManager.init()
    w.vast.addOffer()
    w.vast.fail('createInstance', { status: 400, message: 'create instance failed: no_such_ask' })
    await expect(app.nodeManager.requestNodes(1)).rejects.toThrow('no_such_ask')
    const [{ id }] = w.all<{ id: string }>('SELECT id FROM nodes')
    expect(row(id)).toMatchObject({ state: 'failed', create_unknown_since: null })
    expect(app.nodeManager.activeCount()).toBe(0)
  })
})
