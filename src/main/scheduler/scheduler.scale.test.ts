import { afterEach, describe, expect, it } from 'vitest'
import { setup, type World } from '../test/harness'

// Scale-up as the integration wave wires it (plans 1.5, 1.17, 1.20, 1.21):
// the scheduler's plan goes to requestNodes as a capacity budget, every hold
// in force stops it with its reason, rentals that keep failing back off, and
// a queue the fleet has learned to finish rents nothing.

let w: World
afterEach(() => w.dispose())

describe('scale-up against the plan', () => {
  it('#227 #237 / 1.5: eight exclusive chunks and 8-GPU offers rent one node, not eight', async () => {
    w = await setup({ settings: { maxActiveNodes: 8, spendCapPerHour: 100 } })
    // Ranked first: 8-GPU boxes, each bringing eight exclusive lanes.
    for (let i = 0; i < 8; i++) w.vast.addOffer({ num_gpus: 8, dph_total: 3.2 })
    const app = await w.boot()
    await w.submitJob(app, { frameStart: 1, frameEnd: 8, chunkSize: 1 })
    app.scheduler.kick()
    await w.until(() => w.vast.count('createInstance') >= 1, 'a rental')
    // Let the batch run to its end: with the old count it went on renting.
    await w.advance(5_000)
    expect(w.vast.count('createInstance')).toBe(1)
    expect(app.scheduler.scaleStatus()?.status).toBe('rent')
  })

  it('1.5 cap headroom: under a $2/h cap with $1.95/h running, scale-up rents only what the $0.05 left buys', async () => {
    // The cap used to be tested against the fleet as it stood, so the next
    // rental could be any price: an $8/h box on top of $1.95/h (audit A7).
    w = await setup({ settings: { maxActiveNodes: 4, spendCapPerHour: 2 } })
    const app = await w.boot()
    const busy = await w.readyNode(app, { dph_total: 1.95 })
    w.vast.addOffer({ dph_total: 8, dlperf_per_dphtotal: 900 })
    const cheap = w.vast.addOffer({ dph_total: 0.04 })
    w.machineFor(busy).onSpec = () => {}
    await w.submitJob(app, { frameStart: 1, frameEnd: 2, chunkSize: 1 })
    app.scheduler.kick()
    await w.until(() => w.vast.count('createInstance') === 2, 'a second rental', {
      timeoutMs: 5 * 60_000
    })
    const [, second] = w.vast.argsOf('createInstance')
    expect((second[0] as { offerId: number }).offerId).toBe(cheap.id)
    // The search itself asked for no more than what the cap leaves.
    const searches = w.vast.argsOf('searchOffers').map((a) => a[0] as Record<string, unknown>)
    expect(searches.at(-1)?.dph_total).toMatchObject({ lte: 0.05 })
    await w.advance(2 * 60_000, 1_000)
    expect(w.vast.count('createInstance')).toBe(2)
    expect(app.nodeManager.capUsage().perHour).toBeCloseTo(1.99, 6)
  })

  it('1.17: scale-up that keeps failing backs off, says why, and rents again once it can', async () => {
    w = await setup({ settings: { maxActiveNodes: 2, spendCapPerHour: 10 } })
    w.vast.addOffer()
    // Vast's search fails four times: each batch fails before it rents.
    w.vast.fail('searchOffers', { status: 503, message: 'service unavailable' }, 4)
    const app = await w.boot()
    await w.submitJob(app)
    app.scheduler.kick()
    await w.advance(5 * 60_000, 1_000)
    // Every 15 s tick tried a batch, so the four failures were over within a
    // minute and the fifth search rented. Backing off after two failures, 1
    // then 2 min apart, the fifth search has not happened yet.
    expect(w.vast.count('searchOffers')).toBe(4)
    expect(w.vast.count('createInstance')).toBe(0)
    const held = app.scheduler.fleetHolds().scale
    expect(held?.reason).toMatch(/last 4 scale-up attempts failed.*service unavailable/)
    expect(held?.retryAt).toBeGreaterThan(Date.now())
    expect(app.scheduler.scaleStatus()?.status).toBe('held')
    expect(w.alerts('warn').filter((m) => /^Scale-up paused for/.test(m))).toHaveLength(3)

    // The next try after the backoff finds Vast answering, rents, and clears it.
    await w.until(() => w.vast.count('createInstance') === 1, 'a rental', {
      timeoutMs: 20 * 60_000,
      stepMs: 5_000
    })
    await w.until(() => app.scheduler.fleetHolds().scale == null, 'the backoff cleared')
    expect(w.alerts('info')).toContain('Scale-up rents again: a rented node is ready')
  })

  it('1.17: rentals that never become ready back off scale-up too, not rent and destroy on every tick', async () => {
    // A docker image without what provision.sh needs, or a Blender mirror
    // too slow for the 25-minute deadline, fails every node at its
    // provisioning. Each batch "succeeded" (it rented), so nothing counted,
    // and the fleet rented, billed through a boot, and destroyed a node on
    // every tick, blacklisting one good machine after another (n4, n5).
    w = await setup({ settings: { maxActiveNodes: 1, spendCapPerHour: 10 } })
    for (let i = 0; i < 60; i++) w.vast.addOffer()
    const app = await w.boot()
    app.nodeManager.onReady = async () => {
      throw new Error('install blender 5.1.0 failed (exit 1)')
    }
    await w.submitJob(app)
    app.scheduler.kick()
    await w.advance(10 * 60_000, 1_000)
    // Two in a row, then waits of 1, 2 and 4 minutes: five or so, where
    // every tick rented one (40 in ten minutes).
    expect(w.vast.count('createInstance')).toBeGreaterThanOrEqual(3)
    expect(w.vast.count('createInstance')).toBeLessThanOrEqual(6)
    expect(app.scheduler.fleetHolds().scale?.reason).toMatch(
      /a rented node never became ready: .*install blender 5\.1\.0 failed/
    )

    // Provisioning works again: the next rental's node is ready, and ends it.
    app.nodeManager.onReady = null
    await w.until(() => app.scheduler.fleetHolds().scale == null, 'the backoff over', {
      timeoutMs: 30 * 60_000,
      stepMs: 5_000
    })
    expect(app.nodeManager.list().filter((n) => n.state === 'ready')).toHaveLength(1)
  })

  it('integration review: past a backoff for failed boots, one node is rented as a probe, not a batch', async () => {
    // The first tick past the backoff rented a whole batch, maxRentals
    // nodes, each billed through its boot before it failed the same way.
    w = await setup({ settings: { maxActiveNodes: 4, spendCapPerHour: 10 } })
    for (let i = 0; i < 60; i++) w.vast.addOffer()
    const app = await w.boot()
    app.nodeManager.onReady = async () => {
      throw new Error('install blender 5.1.0 failed (exit 1)')
    }
    await w.submitJob(app, { frameStart: 1, frameEnd: 4, chunkSize: 1 })
    app.scheduler.kick()
    await w.until(() => app.scheduler.fleetHolds().scale != null, 'backing off', {
      timeoutMs: 10 * 60_000,
      stepMs: 1_000
    })
    await w.advance(5_000, 1_000)
    const batch = w.vast.count('createInstance')
    expect(batch).toBe(4)

    // Past the backoff: one rental, and nothing more while it boots.
    await w.until(() => w.vast.count('createInstance') > batch, 'the next rental', {
      timeoutMs: 30 * 60_000,
      stepMs: 5_000
    })
    await w.advance(30_000, 1_000)
    expect(w.vast.count('createInstance')).toBe(batch + 1)

    // Provisioning works again: once a probe is ready, the rest are rented.
    app.nodeManager.onReady = null
    await w.until(
      () =>
        app.nodeManager.list().filter((n) => ['ready', 'rendering'].includes(n.state)).length === 4,
      'the fleet rented',
      { timeoutMs: 60 * 60_000, stepMs: 5_000 }
    )
  })

  it('1.17: the user releasing the backoff lets the next tick rent at once', async () => {
    w = await setup({ settings: { maxActiveNodes: 2, spendCapPerHour: 10 } })
    w.vast.addOffer()
    w.vast.fail('searchOffers', { status: 503, message: 'service unavailable' }, 2)
    const app = await w.boot()
    await w.submitJob(app)
    app.scheduler.kick()
    await w.until(() => app.scheduler.fleetHolds().scale != null, 'backing off')
    const left = await app.scheduler.releaseHold('scale')
    expect(left.scale).toBeUndefined()
    await w.until(() => w.vast.count('createInstance') === 1, 'a rental', { timeoutMs: 30_000 })
  })

  it('1.20 field incident 1d59516c: at $0 the account hold stops scale-up with its reason, and is no failure', async () => {
    w = await setup({ settings: { maxActiveNodes: 4, spendCapPerHour: 10 } })
    for (let i = 0; i < 4; i++) w.vast.addOffer()
    w.vast.fail('createInstance', { status: 400, message: 'insufficient_credit' }, 100)
    const app = await w.boot()
    await w.submitJob(app, { frameStart: 1, frameEnd: 4, chunkSize: 1 })
    app.scheduler.kick()
    await w.until(() => app.scheduler.fleetHolds().account != null, 'the account hold')
    await w.advance(5 * 60_000, 1_000)
    // One refusal, one hold: no attempt after it, and no backoff counted.
    expect(w.vast.count('createInstance')).toBe(1)
    const holds = app.scheduler.fleetHolds()
    expect(holds.scale).toBeUndefined()
    expect(app.scheduler.scaleStatus()).toMatchObject({ status: 'held' })
    expect(app.scheduler.scaleStatus()?.reason).toContain(holds.account!.reason)
    expect(w.alerts('warn').filter((m) => m.startsWith('scale-up failed'))).toEqual([])
  })

  it('1.20 n3 review: a key Vast refuses on the offer search holds renting for the account, with one alert', async () => {
    // Only a create refused for the account set the hold. A key refused on
    // the search failed every scale-up batch instead, a warning each time.
    w = await setup({ settings: { maxActiveNodes: 2, spendCapPerHour: 10 } })
    w.vast.addOffer()
    w.vast.fail('searchOffers', { status: 401, message: 'invalid api key' }, 100)
    const app = await w.boot()
    await w.submitJob(app)
    app.scheduler.kick()
    await w.advance(5 * 60_000, 1_000)
    expect(w.vast.count('searchOffers')).toBe(1)
    expect(app.scheduler.fleetHolds().account?.reason).toMatch(/401|key/i)
    expect(app.scheduler.fleetHolds().scale).toBeUndefined()
    expect(w.alerts('warn').filter((m) => m.startsWith('scale-up failed'))).toEqual([])
    expect(w.alerts('error').filter((m) => /renting is paused/.test(m))).toHaveLength(1)
  })

  it('1.14: a blank spend cap with "no cap" off rents nothing, and says so once', async () => {
    w = await setup({ settings: { maxActiveNodes: 2, spendCapPerHour: null, noSpendCap: false } })
    w.vast.addOffer()
    const app = await w.boot()
    await w.submitJob(app)
    app.scheduler.kick()
    await w.advance(2 * 60_000, 1_000)
    expect(w.vast.count('createInstance')).toBe(0)
    expect(app.scheduler.scaleStatus()?.status).toBe('spend-cap')
    const warned = w.alerts('warn').filter((m) => /no spend cap is set/.test(m))
    expect(warned).toHaveLength(1)
  })

  it('1.21: a pending frame the live node finishes, at the rate learned for its GPU, before a new node could boot rents nothing', async () => {
    w = await setup({ settings: { maxActiveNodes: 2, spendCapPerHour: 10 } })
    const app = await w.boot()
    const nodeId = await w.readyNode(app)
    // RTX 4090s have been measured at 600 frames/h: two frames are 12 s.
    w.db
      .prepare(
        'INSERT INTO gpu_perf (gpu_name, frames_per_hour, samples, updated_at) VALUES (?, ?, ?, ?)'
      )
      .run('RTX 4090', 600, 5, Date.now())
    await w.submitJob(app, { frameStart: 1, frameEnd: 2, chunkSize: 1 })
    app.scheduler.kick()
    // One chunk on the node, rendering with no frame yet; one waiting.
    await w.until(
      () =>
        w.all("SELECT id FROM chunks WHERE node_id = ? AND state != 'pending'", nodeId).length ===
        1,
      'a chunk sent'
    )
    await w.advance(2 * 60_000, 1_000)
    expect(w.vast.count('createInstance')).toBe(1)
    expect(app.scheduler.scaleStatus()).toMatchObject({ status: 'tail' })
    expect(app.scheduler.scaleStatus()?.reason).toMatch(/at the rate learned for its GPUs/)
  })
})
