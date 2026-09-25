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
    expect(w.alerts('info')).toContain('Scale-up rents again: a rental went through')
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
