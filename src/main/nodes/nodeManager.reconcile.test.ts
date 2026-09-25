import { randomUUID } from 'crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NodeState, UnclaimedInstance } from '../../shared/models'
import { setup, type App, type World } from '../test/harness'

// Plan 1.3: the account's instances are checked against this profile's rows
// all session long, not once at start-up (audit A4, #13 #93).
//
// The sweep used to run from init() alone. An orphan made mid-session (a
// create Vast carried out after its label lookup gave up, a destroy an older
// build took on trust) billed until the next launch, and an instance another
// install had rented drew one warning and was then forgotten. Now the
// reconcile runs every 5 minutes from the cost timer, on waking and after an
// API key is saved. Rentals carry this profile's install id in their label
// (`vastai-blender <install8>:<node8>`). An orphan whose label names a row
// here is destroyed; anything else on the account is listed as unclaimed,
// with its rate, and only the user destroys it. An instance younger than two
// minutes, or one a create still in flight may answer with, is left alone.

let w: World
beforeEach(async () => {
  w = await setup({ settings: { maxActiveNodes: 4 } })
})
afterEach(() => w.dispose())

/** The label a rental made this session carries: this profile's install id, then the node's. */
function labelOf(nodeId: string): string {
  return `vastai-blender ${w.settings.installId!.slice(0, 8)}:${nodeId.slice(0, 8)}`
}

/** The engine, wired and initialised; the scheduler is not needed here. */
async function started(): Promise<App> {
  const app = await w.boot({ start: false })
  app.nodeManager.init()
  // Let init's reconcile and balance read land.
  await w.advance(1_000)
  return app
}

interface RowView {
  id: string
  state: NodeState
  instance_id: number | null
  destroyed_at: number | null
  create_unknown_since: number | null
  label: string | null
}

function row(id: string): RowView {
  return w.get<RowView>(
    'SELECT id, state, instance_id, destroyed_at, create_unknown_since, label FROM nodes WHERE id = ?',
    id
  )!
}

/** Seconds since the epoch, as Vast reports start_date, `agoMs` ago. */
function vastTime(agoMs: number): number {
  return (Date.now() - agoMs) / 1000
}

/**
 * A rental whose create got no answer and whose lookup then found nothing:
 * the row ends 'failed', no longer counted, its label known.
 */
async function lookupGaveUp(app: App): Promise<string> {
  w.vast.addOffer()
  w.vast.fail('createInstance', {
    status: 504,
    message: 'vast.ai PUT /asks/5001/ → 504: gateway timeout'
  })
  const batch = app.nodeManager.requestNodes(1).catch(() => [])
  await w.until(() => w.all('SELECT id FROM nodes').length > 0, 'the rental row')
  const [{ id }] = w.all<{ id: string }>('SELECT id FROM nodes')
  await w.until(() => row(id).state === 'failed', 'the lookup settles the row', {
    stepMs: 1_000
  })
  await batch
  expect(row(id)).toMatchObject({ instance_id: null, create_unknown_since: null })
  expect(app.nodeManager.activeCount()).toBe(0)
  return id
}

describe('1.3 periodic reconcile', () => {
  it('destroys, mid-session, an orphan Vast rented after its create lookup gave up', async () => {
    const app = await started()
    const id = await lookupGaveUp(app)
    // Vast carries the create out after all, a minute late: an instance
    // under the row's label that nothing in the app knows of.
    const late = w.vast.addInstance({ label: labelOf(id), start_date: vastTime(0) })
    const listsBefore = w.vast.count('listInstances')

    // The next reconcile (5 minutes after init's) finds it, claims it for
    // its row and destroys it. The old sweep ran at start-up only.
    await w.until(() => row(id).state === 'destroyed', 'the orphan destroyed', {
      timeoutMs: 6 * 60_000,
      stepMs: 5_000
    })
    expect(w.vast.count('listInstances')).toBeGreaterThan(listsBefore)
    expect(w.vast.argsOf('destroyInstance')).toEqual([[late.id]])
    expect(w.vast.live()).toEqual([])
    expect(row(id)).toMatchObject({ instance_id: late.id })
    expect(row(id).destroyed_at).not.toBeNull()
    expect(w.alerts('warn')).toContain(`destroying orphaned instance ${late.id} (${labelOf(id)})`)
    expect(app.nodeManager.activeCount()).toBe(0)
    expect(app.nodeManager.listUnclaimed()).toEqual([])
  })

  it('runs every 5 minutes from the cost timer', async () => {
    await started()
    // init's pass.
    expect(w.vast.count('listInstances')).toBe(1)
    await w.advance(4 * 60_000 + 30_000, 5_000)
    expect(w.vast.count('listInstances')).toBe(1)
    await w.advance(60_000, 5_000)
    expect(w.vast.count('listInstances')).toBe(2)
    await w.advance(5 * 60_000, 5_000)
    expect(w.vast.count('listInstances')).toBe(3)
  })

  it('leaves an instance younger than 2 minutes to a later pass, then destroys it', async () => {
    const app = await started()
    const id = await lookupGaveUp(app)
    // Appears half a minute before the 5-minute pass.
    await w.advance(5 * 60_000 - 30_000 - (Date.now() - w.vast.calls[0].at), 5_000)
    const late = w.vast.addInstance({ label: labelOf(id), start_date: vastTime(0) })
    const born = Date.now()
    const lists = w.vast.count('listInstances')
    await w.advance(60_000, 5_000)
    // The 5-minute pass has run and let it be.
    expect(w.vast.count('listInstances')).toBe(lists + 1)
    expect(w.vast.live()).toEqual([late.id])
    expect(row(id).instance_id).toBeNull()

    // Taken up as soon as it is two minutes old, not five minutes later.
    await w.until(() => row(id).state === 'destroyed', 'the orphan destroyed', {
      timeoutMs: 3 * 60_000,
      stepMs: 5_000
    })
    const destroyedAt = w.vast.calls.find((c) => c.method === 'destroyInstance')!.at
    expect(destroyedAt - born).toBeGreaterThanOrEqual(2 * 60_000)
    expect(destroyedAt - born).toBeLessThanOrEqual(3 * 60_000)
    expect(w.vast.live()).toEqual([])
  })

  it("leaves alone the instance of a 'requested' row with no instance id: another process's create in flight", async () => {
    const app = await started()
    // Written by another process on this profile (an older build, without
    // the single-instance lock) whose create has not answered yet.
    const id = randomUUID()
    w.db
      .prepare(
        `INSERT INTO nodes (id, state, gpu_name, num_gpus, dph_total, accumulated_cost,
           blender_versions, label, create_unknown_since)
         VALUES (?, 'requested', 'RTX 4090', 1, 0.4, 0, '[]', ?, ?)`
      )
      .run(id, `vastai-blender ${id.slice(0, 8)}`, Date.now())
    const inst = w.vast.addInstance({
      label: `vastai-blender ${id.slice(0, 8)}`,
      start_date: vastTime(10 * 60_000)
    })

    await app.nodeManager.reconcile()

    expect(w.vast.count('destroyInstance')).toBe(0)
    expect(w.vast.live()).toEqual([inst.id])
    expect(row(id)).toMatchObject({ state: 'requested', instance_id: null })
    // Its row names it: not unclaimed either.
    expect(app.nodeManager.listUnclaimed()).toEqual([])
    expect(w.alerts('warn')).toEqual([])
  })

  it('a rental of this session is never taken for an orphan, whenever the reconcile runs', async () => {
    const app = await started()
    w.vast.addOffer()
    const gate = w.vast.hold('createInstance')
    const renting = app.nodeManager.requestNodes(1)
    await w.until(() => gate.reached, 'createInstance in flight')
    // Vast rents it; the reply is still on its way when a reconcile lists it.
    const list = w.vast.hold('listInstances')
    const pass = app.nodeManager.reconcile()
    await w.until(() => list.reached, 'the reconcile asking for the list')
    gate.release()
    const [id] = await renting
    // Vast reports a start date older than the 2-minute guard (its clock,
    // or a slow boot report): only the holders read afresh for each listed
    // instance keep the pass from taking the node's own instance for an
    // orphan. The holders read before the list was asked for predate the
    // create's answer.
    w.vast.patchInstance(w.vast.created[0], { start_date: vastTime(10 * 60_000) })
    list.release()
    await pass

    await w.until(() => app.nodeManager.get(id)?.state === 'ready', 'node ready')
    expect(w.vast.count('destroyInstance')).toBe(0)
    expect(app.nodeManager.listUnclaimed()).toEqual([])
    expect(w.alerts('warn')).toEqual([])
  })

  it('an instance Vast still lists within 2 minutes of its confirmed destroy is not destroyed again', async () => {
    const app = await started()
    // This profile's row, its instance confirmed gone half a minute ago; Vast
    // lists it a little longer.
    const id = randomUUID()
    const label = labelOf(id)
    const inst = w.vast.addInstance({ label, start_date: vastTime(60 * 60_000) })
    w.db
      .prepare(
        `INSERT INTO nodes (id, state, instance_id, gpu_name, num_gpus, dph_total, accumulated_cost,
           blender_versions, label, destroyed_at)
         VALUES (?, 'destroyed', ?, 'RTX 4090', 1, 0.4, 0, '[]', ?, ?)`
      )
      .run(id, inst.id, label, Date.now() - 30_000)

    await app.nodeManager.reconcile()

    expect(w.vast.count('destroyInstance')).toBe(0)
    expect(app.nodeManager.listUnclaimed()).toEqual([])
    expect(w.alerts()).toEqual([])
    expect(row(id)).toMatchObject({ state: 'destroyed', instance_id: inst.id })

    // Still listed once the 2 minutes are up: Vast contradicts the
    // confirmation, and the row takes it back as an orphan to destroy.
    await w.advance(2 * 60_000, 5_000)
    await app.nodeManager.reconcile()
    await w.until(() => w.vast.live().length === 0, 'the orphan destroyed')
    expect(w.vast.argsOf('destroyInstance')).toEqual([[inst.id]])
    expect(w.alerts('warn')).toEqual([`destroying orphaned instance ${inst.id} (${label})`])
    expect(row(id).state).toBe('destroyed')
  })
})

describe('1.3 labels from before install ids', () => {
  it("the legacy label finds its row: a row the migration labelled, and an older build's with no label", async () => {
    // Rows of the last run whose creates got no answer, and the instances
    // Vast rented for them under the legacy `vastai-blender <node8>`:
    //  - `backfilled`: the migration wrote the label every build rented under
    //  - `unlabelled`: an older build ran on this profile after the migration
    //    and wrote no label (nor create_unknown_since), so only its id names it
    const backfilled = randomUUID()
    const unlabelled = randomUUID()
    const insert = w.db.prepare(
      `INSERT INTO nodes (id, state, gpu_name, num_gpus, dph_total, accumulated_cost,
         blender_versions, label, create_unknown_since)
       VALUES (?, 'failed', 'RTX 4090', 1, 0.4, 0, '[]', ?, ?)`
    )
    insert.run(backfilled, `vastai-blender ${backfilled.slice(0, 8)}`, Date.now() - 60 * 60_000)
    insert.run(unlabelled, null, null)
    const a = w.vast.addInstance({
      label: `vastai-blender ${backfilled.slice(0, 8)}`,
      start_date: vastTime(60 * 60_000)
    })
    const b = w.vast.addInstance({
      label: `vastai-blender ${unlabelled.slice(0, 8)}`,
      start_date: vastTime(60 * 60_000)
    })
    // Another install's rental whose node part happens to match the
    // unlabelled row: the id prefix names legacy labels only.
    const foreign = w.vast.addInstance({
      label: `vastai-blender 0bad0bad:${unlabelled.slice(0, 8)}`,
      start_date: vastTime(60 * 60_000)
    })

    const app = await started()
    await w.until(() => w.vast.live().length === 1, 'both orphans destroyed')

    expect(w.vast.live()).toEqual([foreign.id])
    expect(row(backfilled)).toMatchObject({ state: 'destroyed', instance_id: a.id })
    expect(row(unlabelled)).toMatchObject({ state: 'destroyed', instance_id: b.id })
    expect(app.nodeManager.activeCount()).toBe(0)
    expect(app.nodeManager.listUnclaimed()).toMatchObject([
      { instanceId: foreign.id, owner: 'otherVastRender' }
    ])
  })
})

describe('1.3 unclaimed instances', () => {
  it("another install's rental is listed as unclaimed with its rate, never destroyed, announced once", async () => {
    // Another install's label: its own install id, its own node id.
    const foreign = w.vast.addInstance({
      label: 'vastai-blender 0bad0bad:12345678',
      gpu_name: 'RTX 5090',
      num_gpus: 2,
      dph_total: 1.25,
      start_date: vastTime(30 * 60_000)
    })
    const app = await w.boot({ start: false })
    const heard: UnclaimedInstance[][] = []
    app.nodeManager.onUnclaimedChanged((list) => heard.push(list))
    app.nodeManager.init()
    await w.advance(1_000)

    const expected: UnclaimedInstance = {
      instanceId: foreign.id,
      label: 'vastai-blender 0bad0bad:12345678',
      owner: 'otherVastRender',
      gpuName: 'RTX 5090',
      numGpus: 2,
      dphTotal: 1.25,
      status: 'running',
      startedAt: Math.round(foreign.start_date! * 1000),
      firstSeenAt: Date.now() - 1_000,
      destroyError: null
    }
    expect(app.nodeManager.listUnclaimed()).toEqual([expected])
    expect(heard).toEqual([[expected]])
    const warned = w.alerts('warn')
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain(`instance ${foreign.id} (vastai-blender 0bad0bad:12345678)`)

    // Two more passes: still running, still listed, not announced again.
    await w.advance(11 * 60_000, 5_000)
    expect(w.vast.count('listInstances')).toBe(3)
    expect(w.vast.count('destroyInstance')).toBe(0)
    expect(w.vast.live()).toEqual([foreign.id])
    expect(app.nodeManager.listUnclaimed()).toEqual([expected])
    expect(heard).toHaveLength(1)
    expect(w.alerts('warn')).toHaveLength(1)
    // Not counted as this fleet's: it is not.
    expect(app.nodeManager.activeCount()).toBe(0)
  })

  it("one under this install's id that no row names is this profile's: listed, not destroyed, not sent to 'its own app'", async () => {
    // A lost or reset database, or a settings file copied to another
    // machine: the label is this install's, and nothing here rented it.
    const label = `vastai-blender ${w.settings.installId!.slice(0, 8)}:12345678`
    const stray = w.vast.addInstance({ label, start_date: vastTime(30 * 60_000) })
    const app = await started()
    await w.advance(6 * 60_000, 5_000)

    expect(app.nodeManager.listUnclaimed()).toMatchObject([
      { instanceId: stray.id, label, owner: 'thisProfile' }
    ])
    expect(w.vast.count('destroyInstance')).toBe(0)
    const warned = w.alerts('warn')
    expect(warned).toEqual([
      `instance ${stray.id} (${label}) carries this install's id but no node here knows it — left running; destroy it from the Vast.ai console if it is stray`
    ])
  })

  it('an instance with no Vast Render label is listed, never destroyed, and not announced', async () => {
    const other = w.vast.addInstance({ start_date: vastTime(60 * 60_000) })
    const app = await started()
    expect(app.nodeManager.listUnclaimed()).toMatchObject([
      { instanceId: other.id, label: null, owner: 'unlabelled', dphTotal: 0.4 }
    ])
    expect(w.vast.count('destroyInstance')).toBe(0)
    expect(w.alerts()).toEqual([])
  })

  it('the user can destroy an unclaimed instance, and only an unclaimed one', async () => {
    const foreign = w.vast.addInstance({
      label: 'vastai-blender 0bad0bad:12345678',
      start_date: vastTime(30 * 60_000)
    })
    const app = await started()
    const nodeId = await w.readyNode(app)
    const [, ownInstance] = w.vast.created
    const heard: UnclaimedInstance[][] = []
    app.nodeManager.onUnclaimedChanged((list) => heard.push(list))

    // A live node's instance, or one nobody listed: refused, nothing sent.
    await expect(app.nodeManager.destroyUnclaimed(ownInstance)).resolves.toMatchObject({
      ok: false
    })
    await expect(app.nodeManager.destroyUnclaimed(424242)).resolves.toMatchObject({ ok: false })
    expect(w.vast.count('destroyInstance')).toBe(0)
    expect(app.nodeManager.get(nodeId)?.state).toBe('ready')

    const r = await app.nodeManager.destroyUnclaimed(foreign.id)
    expect(r.ok).toBe(true)
    expect(w.vast.argsOf('destroyInstance')).toEqual([[foreign.id]])
    expect(w.vast.live()).toEqual([ownInstance])
    expect(app.nodeManager.listUnclaimed()).toEqual([])
    expect(heard).toEqual([[]])
  })

  it('an unclaimed instance whose destroy Vast refuses stays listed, with the reason', async () => {
    const foreign = w.vast.addInstance({
      label: 'vastai-blender 0bad0bad:12345678',
      start_date: vastTime(30 * 60_000)
    })
    const app = await started()
    w.vast.fail('destroyInstance', { status: 403, message: 'access denied' })

    const r = await app.nodeManager.destroyUnclaimed(foreign.id)

    expect(r.ok).toBe(false)
    expect(r.message).toContain('Vast.ai console')
    expect(w.vast.live()).toEqual([foreign.id])
    const [entry] = app.nodeManager.listUnclaimed()
    expect(entry.instanceId).toBe(foreign.id)
    expect(entry.destroyError).toContain('403')
  })
})

describe('1.3 on waking, and after an API key is saved', () => {
  it('reconcile() runs a pass at once, and calls made during one wait for one more', async () => {
    const app = await started()
    expect(w.vast.count('listInstances')).toBe(1)
    const list = w.vast.hold('listInstances')
    const a = app.nodeManager.reconcile()
    await w.until(() => list.reached, 'a pass in flight')
    const b = app.nodeManager.reconcile()
    const c = app.nodeManager.reconcile()
    list.release()
    await Promise.all([a, b, c])
    // The one in flight, and one more for the two that came during it.
    expect(w.vast.count('listInstances')).toBe(3)
  })

  it('a key saved after a start with none: the orphan the start could not see is destroyed', async () => {
    await w.dispose()
    w = await setup({ secrets: { vastApiKey: undefined } })
    // An orphan of the last run: its row's create never heard back.
    const id = randomUUID()
    w.db
      .prepare(
        `INSERT INTO nodes (id, state, gpu_name, num_gpus, dph_total, accumulated_cost,
           blender_versions, label, create_unknown_since)
         VALUES (?, 'failed', 'RTX 4090', 1, 0.4, 0, '[]', ?, ?)`
      )
      .run(id, `vastai-blender ${id.slice(0, 8)}`, Date.now() - 60 * 60_000)
    const orphan = w.vast.addInstance({
      label: `vastai-blender ${id.slice(0, 8)}`,
      start_date: vastTime(60 * 60_000)
    })
    const app = await started()
    // No key: nothing reached Vast, and the row is still counted.
    expect(w.vast.count('listInstances')).toBe(0)
    expect(app.nodeManager.activeCount()).toBe(1)

    w.secrets.vastApiKey = 'a-new-key'
    await app.nodeManager.onApiKeySaved()

    expect(w.vast.count('listInstances')).toBe(1)
    await w.until(() => row(id).state === 'destroyed', 'the orphan destroyed')
    expect(w.vast.live()).toEqual([])
    expect(row(id)).toMatchObject({ instance_id: orphan.id, create_unknown_since: null })
    expect(app.nodeManager.activeCount()).toBe(0)
  })
})
