import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NodeState } from '../../shared/models'
import { setup, type App, type World } from '../test/harness'

// Destroying a node while it is still being rented or brought up (plan 0.6).
// The Fleet shows a destroy button on every row from the moment the row
// exists, which is before the instance does and minutes before it answers
// SSH, so a destroy can land in the middle of any step of driveToReady. What
// must hold whenever it does: the instance is destroyed exactly once, the
// node ends 'destroyed', and nothing reports it as a node failure. Unless the
// instance may still be billing: the destroy's DELETE threw. Then the node
// ends 'failed', the state that says so, and one alert tells the user. A
// create that ended with no answer as to whether it rented anything has its
// instance looked for by its label, and destroyed when found (plan 1.4).
// Either way the cancelled rental is not replaced by another.

let w: World
beforeEach(async () => {
  w = await setup()
})
afterEach(() => w.dispose())

/** A promise's outcome, readable synchronously from inside w.until(). */
function watch<T>(p: Promise<T>): { done: boolean; value?: T; error?: unknown } {
  const s: { done: boolean; value?: T; error?: unknown } = { done: false }
  p.then(
    (value) => Object.assign(s, { done: true, value }),
    (error) => Object.assign(s, { done: true, error })
  )
  return s
}

/** First-connect attempts that have failed and been retried so far. */
function sshRetries(nodeId: string): number {
  return w
    .eventsOf('render:logLine')
    .filter((l) => l.nodeId === nodeId && l.line.startsWith('ssh attempt')).length
}

/**
 * Every state a node was shown in from event index `from` on. A snapshot
 * pushed for another field (the create's outcome, the destroy's stamp) that
 * repeats the state before it is left out.
 */
function statesSince(nodeId: string, from: number): NodeState[] {
  return w.events
    .slice(from)
    .filter((e) => e.channel === 'node:changed')
    .map((e) => e.payload as { id: string; state: NodeState })
    .filter((s) => s.id === nodeId)
    .map((s) => s.state)
    .filter((s, i, all) => i === 0 || s !== all[i - 1])
}

/**
 * A DELETE Vast refuses outright. ensureInstanceGone does not retry it
 * within the call (plan 1.2), so the destroy is unconfirmed at once; the
 * retry timer tries again a minute later. A 5xx would be retried with
 * backoff inside the call instead.
 */
const REFUSED = { status: 403, message: 'access denied' }

/** Asserts the one alert a destroy Vast has not confirmed raises. */
function expectDestroyFailedAlert(instanceId: number): void {
  const errors = w.alerts('error')
  expect(errors).toHaveLength(1)
  expect(errors[0]).toContain(`Destroy failed for instance ${instanceId}`)
  expect(errors[0]).toContain('Vast.ai console')
}

/**
 * Whether a machine is still rentable, i.e. not blacklisted as having failed:
 * offer it again and see whether it rents. The blacklist is private, and
 * this is the only thing it changes.
 */
async function rentsAgain(app: App, machineId: number): Promise<boolean> {
  // Only this offer, so what rents is this machine or nothing.
  w.vast.offers = []
  w.vast.addOffer({ machine_id: machineId })
  const ids = await app.nodeManager.requestNodes(1).catch(() => [])
  return ids.length === 1
}

describe('destroy while createInstance is in flight (finding #110)', () => {
  it('destroys the instance the create returns, once it returns', async () => {
    const app = await w.boot()
    w.vast.addOffer()
    const gate = w.vast.hold('createInstance')
    const renting = app.nodeManager.requestNodes(1)
    await w.until(() => gate.reached, 'createInstance in flight')
    const [{ id }] = w.all<{ id: string }>('SELECT id FROM nodes')

    // The 'requested' row has no instance id yet: destroyNode has nothing to
    // destroy, and ends the node at once.
    await app.nodeManager.destroyNode(id)
    expect(app.nodeManager.get(id)?.state).toBe('destroyed')
    expect(w.vast.count('destroyInstance')).toBe(0)

    // Vast rents the instance anyway: the request was already on its way.
    gate.release()
    await expect(renting).resolves.toEqual([id])
    const [instanceId] = w.vast.created
    expect(w.vast.argsOf('destroyInstance')).toEqual([[instanceId]])
    expect(w.vast.live()).toEqual([])

    // And it is never driven towards ready, then or later: the one question
    // to Vast about it is the destroy's confirmation, after the DELETE.
    await w.advance(5 * 60_000)
    expect(w.vast.calls.map((c) => c.method).filter((m) => /Instance$/.test(m))).toEqual([
      'createInstance',
      'destroyInstance',
      'showInstance'
    ])
    expect(w.get('SELECT state, instance_id FROM nodes WHERE id = ?', id)).toEqual({
      state: 'destroyed',
      instance_id: instanceId
    })
    expect(w.alerts('error')).toEqual([])
  })

  it('a late destroy that fails leaves the node failed, holding the instance id, so it is retried', async () => {
    const app = await w.boot()
    w.vast.addOffer()
    const gate = w.vast.hold('createInstance')
    const renting = app.nodeManager.requestNodes(1)
    await w.until(() => gate.reached, 'createInstance in flight')
    const [{ id }] = w.all<{ id: string }>('SELECT id FROM nodes')
    await app.nodeManager.destroyNode(id)

    w.vast.fail('destroyInstance', REFUSED)
    gate.release()
    await renting
    const [instanceId] = w.vast.created

    // Still billing, and the row says so: 'failed' with the instance id is
    // what the retry timer and clearFailed act on, and it counts.
    expect(w.vast.live()).toEqual([instanceId])
    const row = w.get<{ state: string; instance_id: number; last_error: string }>(
      'SELECT state, instance_id, last_error FROM nodes WHERE id = ?',
      id
    )
    expect(row).toMatchObject({ state: 'failed', instance_id: instanceId })
    expect(row?.last_error).toContain('access denied')
    expectDestroyFailedAlert(instanceId)
    expect(app.nodeManager.activeCount()).toBe(1)

    await expect(app.nodeManager.clearFailed()).resolves.toBe(1)
    expect(w.vast.live()).toEqual([])
    expect(app.nodeManager.get(id)?.state).toBe('destroyed')
    expect(app.nodeManager.activeCount()).toBe(0)
  })

  it('a create Vast refuses is the end of it: no failure, no blacklist, no replacement', async () => {
    const app = await w.boot()
    const offer = w.vast.addOffer()
    // A second offer the batch would move on to if it took the refusal for
    // a failed rental.
    w.vast.addOffer()
    const gate = w.vast.hold('createInstance')
    const renting = app.nodeManager.requestNodes(1)
    await w.until(() => gate.reached, 'createInstance in flight')
    const [{ id }] = w.all<{ id: string }>('SELECT id FROM nodes')
    const from = w.events.length
    await app.nodeManager.destroyNode(id)

    // The offer went to someone else meanwhile: a 4xx, so nothing was rented.
    gate.fail({ status: 400, message: 'create instance failed: no_such_ask' })
    await expect(renting).resolves.toEqual([id])

    expect(w.vast.count('createInstance')).toBe(1)
    expect(w.vast.live()).toEqual([])
    expect(statesSince(id, from)).toEqual(['destroying', 'destroyed'])
    expect(w.all('SELECT id FROM nodes')).toEqual([{ id }])
    expect(w.alerts('error')).toEqual([])
    expect(await rentsAgain(app, offer.machine_id)).toBe(true)
  })

  it('a create that ends with no answer: its instance is found by its label and destroyed (plan 1.4)', async () => {
    const app = await w.boot()
    w.vast.addOffer()
    w.vast.addOffer()
    const gate = w.vast.hold('createInstance')
    const renting = app.nodeManager.requestNodes(1)
    await w.until(() => gate.reached, 'createInstance in flight')
    const [{ id }] = w.all<{ id: string }>('SELECT id FROM nodes')
    await app.nodeManager.destroyNode(id)

    // Vast rents the instance, then the connection drops before the reply:
    // the reply that named the instance never comes. It used to bill,
    // unseen, until the next start's orphan sweep.
    gate.loseReply(new Error('read ECONNRESET'))
    await expect(renting).resolves.toEqual([id])

    const [instanceId] = w.vast.created
    expect(w.vast.instance(instanceId)?.label).toBe(`vastai-blender ${id.slice(0, 8)}`)
    // Found under the row's label, recorded on the row, and destroyed.
    expect(w.vast.argsOf('destroyInstance')).toEqual([[instanceId]])
    expect(w.vast.live()).toEqual([])
    const row = w.get<{ state: string; instance_id: number | null; destroyed_at: number | null }>(
      'SELECT state, instance_id, destroyed_at FROM nodes WHERE id = ?',
      id
    )
    expect(row).toMatchObject({ state: 'destroyed', instance_id: instanceId })
    expect(row?.destroyed_at).not.toBeNull()
    expect(app.nodeManager.activeCount()).toBe(0)
    expect(w.alerts('error')).toEqual([])
    // A cancelled rental: not replaced by the second offer.
    expect(w.vast.count('createInstance')).toBe(1)
  })
})

describe('destroy during the first-connect SSH retry (findings #239, #221)', () => {
  it('is not a node failure: no blacklist, no error alert, no second destroy', async () => {
    const app = await w.boot()
    const offer = w.vast.addOffer()
    // Boots slowly enough for the test to stop sshd answering first.
    w.vast.bootMs = 20_000
    const [id] = await app.nodeManager.requestNodes(1)
    w.machineFor(id).refuseConnects = Infinity
    await w.until(() => sshRetries(id) >= 1, 'first-connect retry under way')

    const from = w.events.length
    await app.nodeManager.destroyNode(id)
    // The retry wakes from its backoff, sees the destroy and gives up.
    await w.advance(2 * 60_000)

    expect(statesSince(id, from)).toEqual(['destroying', 'destroyed'])
    expect(app.nodeManager.get(id)?.state).toBe('destroyed')
    expect(w.vast.count('destroyInstance')).toBe(1)
    expect(w.alerts('error')).toEqual([])
    expect(await rentsAgain(app, offer.machine_id)).toBe(true)
  })

  it('an attempt that connects after the destroy does not bring the node back', async () => {
    const app = await w.boot()
    const provisioned: string[] = []
    app.nodeManager.onReady = async ({ id }) => {
      provisioned.push(id)
    }
    w.vast.addOffer()
    w.vast.bootMs = 20_000
    const [id] = await app.nodeManager.requestNodes(1)
    // The first attempt is refused on both endpoints; the second gets in.
    w.machineFor(id).refuseConnects = 2
    await w.until(() => sshRetries(id) >= 1, 'first attempt failed')

    // Catch the second attempt just past its abort check, then destroy the
    // node under it. The DELETE is held, so the box is still up to answer.
    const show = w.vast.hold('showInstance')
    await w.until(() => show.reached, 'second attempt under way')
    const del = w.vast.hold('destroyInstance')
    const from = w.events.length
    const destroying = watch(app.nodeManager.destroyNode(id))
    expect(app.nodeManager.get(id)?.state).toBe('destroying')

    show.release()
    await w.until(() => w.machineFor(id).connects === 1, 'second attempt connected')
    await w.advance(5_000)
    del.release()
    await w.until(() => destroying.done, 'destroy finished')

    expect(provisioned).toEqual([])
    expect(statesSince(id, from).filter((s) => s !== 'destroying')).toEqual(['destroyed'])
    expect(app.nodeManager.get(id)?.ssh).toBeNull()
    expect(w.alerts().filter((m) => m.endsWith(' ready'))).toEqual([])
    expect(w.vast.count('destroyInstance')).toBe(1)
    expect(w.alerts('error')).toEqual([])
  })

  it('a destroy whose DELETE fails stops the retry: the box is still up, but not ours to use', async () => {
    const app = await w.boot()
    const provisioned: string[] = []
    app.nodeManager.onReady = async ({ id }) => {
      provisioned.push(id)
    }
    w.vast.addOffer()
    w.vast.bootMs = 20_000
    const [id] = await app.nodeManager.requestNodes(1)
    w.machineFor(id).refuseConnects = 2
    await w.until(() => sshRetries(id) >= 1, 'first attempt failed')
    const [instanceId] = w.vast.created

    const from = w.events.length
    w.vast.fail('destroyInstance', REFUSED)
    await app.nodeManager.destroyNode(id)
    expect(app.nodeManager.get(id)?.state).toBe('failed')
    // sshd answers from the next attempt on, had there been one.
    await w.advance(2 * 60_000)

    expect(provisioned).toEqual([])
    // Unconfirmed, then destroyed by the retry timer: never back in the fleet.
    expect(statesSince(id, from)).toEqual(['destroying', 'failed', 'destroyed'])
    expect(app.nodeManager.get(id)?.ssh).toBeNull()
    expect(w.vast.count('destroyInstance')).toBe(2)
    expectDestroyFailedAlert(instanceId)
    expect(w.vast.live()).toEqual([])
  })
})

describe('destroy during provisioning', () => {
  it('provisioning that completes after the destroy does not mark the node ready', async () => {
    const app = await w.boot()
    let finish: () => void = () => {}
    app.nodeManager.onReady = () => new Promise<void>((r) => (finish = r))
    w.vast.addOffer()
    const [id] = await app.nodeManager.requestNodes(1)
    await w.until(() => app.nodeManager.get(id)?.state === 'provisioning', 'provisioning')

    await app.nodeManager.destroyNode(id)
    finish()
    await w.advance(60_000)

    expect(app.nodeManager.get(id)?.state).toBe('destroyed')
    expect(w.alerts().filter((m) => m.endsWith(' ready'))).toEqual([])
    expect(w.vast.count('destroyInstance')).toBe(1)
    expect(w.alerts('error')).toEqual([])
  })

  it('a destroy whose DELETE fails is not undone when provisioning ends', async () => {
    const app = await w.boot()
    let provisioning = false
    let finish: () => void = () => {}
    app.nodeManager.onReady = () => {
      provisioning = true
      return new Promise<void>((r) => (finish = r))
    }
    const offer = w.vast.addOffer()
    const [id] = await app.nodeManager.requestNodes(1)
    await w.until(() => provisioning, 'provisioning')
    const [instanceId] = w.vast.created

    const from = w.events.length
    w.vast.fail('destroyInstance', REFUSED)
    await app.nodeManager.destroyNode(id)
    finish()
    await w.advance(1_000)

    // 'failed' with the instance id: still billing, and the row says so. Not
    // 'ready', where the scheduler would take it back into the fleet.
    expect(statesSince(id, from)).toEqual(['destroying', 'failed'])
    expect(w.get('SELECT state, instance_id FROM nodes WHERE id = ?', id)).toEqual({
      state: 'failed',
      instance_id: instanceId
    })
    expect(w.alerts().filter((m) => m.endsWith(' ready'))).toEqual([])
    expectDestroyFailedAlert(instanceId)
    expect(w.vast.count('destroyInstance')).toBe(1)
    expect(w.vast.live()).toEqual([instanceId])

    // The retry timer finishes the destroy, and nothing brought it back meanwhile.
    await w.until(() => app.nodeManager.get(id)?.state === 'destroyed', 'destroy retried')
    expect(statesSince(id, from)).toEqual(['destroying', 'failed', 'destroyed'])
    expect(w.vast.live()).toEqual([])
    expect(await rentsAgain(app, offer.machine_id)).toBe(true)
  })

  it('provisioning that fails because of the destroy is not a node failure', async () => {
    const app = await w.boot()
    let fail: (e: Error) => void = () => {}
    app.nodeManager.onReady = () => new Promise<void>((_, reject) => (fail = reject))
    const offer = w.vast.addOffer()
    const [id] = await app.nodeManager.requestNodes(1)
    await w.until(() => app.nodeManager.get(id)?.state === 'provisioning', 'provisioning')

    const from = w.events.length
    await app.nodeManager.destroyNode(id)
    // What provisionBase throws when its connection is closed under it.
    fail(new Error('provision.sh base failed (exit null)'))
    await w.advance(60_000)

    expect(statesSince(id, from)).toEqual(['destroying', 'destroyed'])
    expect(w.vast.count('destroyInstance')).toBe(1)
    expect(w.alerts('error')).toEqual([])
    expect(await rentsAgain(app, offer.machine_id)).toBe(true)
  })
})
