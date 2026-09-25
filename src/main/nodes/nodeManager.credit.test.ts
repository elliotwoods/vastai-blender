import { afterEach, describe, expect, it } from 'vitest'
import type { FleetHolds } from '../../shared/models'
import { setup, type App, type World } from '../test/harness'

// Plan 1.20, the credit guard. Field incident 1d59516c (2026-09-25): the Vast
// balance hit $0 mid-render. Nothing had said it was running low. Scale-up
// then made 12 rent attempts, each refused with 400 insufficient_credit, each
// a failed Fleet row and a blacklisted machine, and no alert said why.
//
// Now the balance is read on every cost tick and judged against what the
// fleet bills: under 30 minutes of runway the user is warned once; under 10,
// or on any insufficient_credit answer, renting stops under an account hold,
// with one sticky alert, no blacklisting and no failed rows piling up. The
// hold is kept in app_state, and releases itself once the balance goes up.

let w: World
afterEach(() => w.dispose())

/** Vast's answer to a rental the balance cannot pay for, as vastClient throws it. */
const NO_CREDIT = {
  status: 400,
  message:
    'vast.ai PUT /asks/5001/ → 400: {"success": false, "error": "insufficient_credit", "msg": "Your balance is too low"}'
}

async function started(): Promise<App> {
  const app = await w.boot({ start: false })
  app.nodeManager.init()
  // init's balance read and reconcile.
  await w.advance(1_000)
  return app
}

function storedHold(): Record<string, unknown> | null {
  const r = w.get<{ value: string }>("SELECT value FROM app_state WHERE key = 'account_hold'")
  return r ? (JSON.parse(r.value) as Record<string, unknown>) : null
}

function rowCount(): number {
  return w.get<{ n: number }>('SELECT COUNT(*) AS n FROM nodes')!.n
}

describe('1.20 insufficient_credit (job 1d59516c)', () => {
  it('one refusal holds renting: one alert, no blacklist, no failed rows piling up; a top-up releases it', async () => {
    w = await setup({ settings: { maxActiveNodes: 4 } })
    w.vast.user = { id: 1, credit: 0.3 }
    const app = await started()
    const holds: FleetHolds[] = []
    app.nodeManager.onHoldsChanged((h) => holds.push(h))
    const first = w.vast.addOffer()
    w.vast.addOffer()
    w.vast.addOffer()
    w.vast.fail('createInstance', NO_CREDIT)

    // Scale-up asking, tick after tick, as it did twelve times in 1d59516c.
    for (let tick = 0; tick < 12; tick++) {
      await expect(app.nodeManager.requestNodes(3)).resolves.toEqual([])
      await w.advance(15_000, 5_000)
    }

    // One rental tried, one failed row, and no more after it.
    expect(w.vast.count('createInstance')).toBe(1)
    expect(rowCount()).toBe(1)
    expect(w.get('SELECT state FROM nodes')).toMatchObject({ state: 'failed' })
    expect(app.nodeManager.activeCount()).toBe(0)
    // One alert, sticky (an error naming the console), with the balance.
    expect(w.alerts()).toHaveLength(1)
    const [alert] = w.alerts('error')
    expect(alert).toContain('Vast balance $0.30')
    expect(alert).toContain('Vast.ai console')
    expect(alert).toContain('insufficient_credit')
    const account = app.nodeManager.accountHold()
    expect(account).toMatchObject({ balance: 0.3 })
    expect(account!.reason).toContain('insufficient_credit')
    expect(app.nodeManager.getHolds()).toEqual({ account })
    expect(holds).toEqual([{ account }])
    // Kept for a relaunch.
    expect(storedHold()).toMatchObject({ cause: 'credit', balance: 0.3 })
    // The Fleet's button says why rather than trying.
    await expect(app.nodeManager.requestNode()).rejects.toThrow(/Renting is paused/)
    expect(w.vast.count('createInstance')).toBe(1)

    // The user tops up: the next balance reading releases the hold.
    w.vast.user = { id: 1, credit: 50 }
    await w.advance(60_000, 5_000)
    expect(app.nodeManager.accountHold()).toBeNull()
    expect(storedHold()).toBeNull()
    expect(holds.at(-1)).toEqual({})
    expect(w.alerts('info')).toContain('Vast balance $50.00: renting resumes')

    // And the machine Vast refused is not blacklisted: it is rented now.
    w.vast.offers = w.vast.offers.filter((o) => o.id === first.id)
    const [id] = await app.nodeManager.requestNodes(1)
    expect(id).toBeDefined()
    expect(w.vast.instance(w.vast.created[0])?.machine_id).toBe(first.machine_id)
  })

  it('under the scheduler: one alert for the refusal, no "scale-up failed" every tick', async () => {
    w = await setup({ settings: { maxActiveNodes: 3, eagerFleet: true } })
    w.vast.user = { id: 1, credit: 0.3 }
    for (let i = 0; i < 6; i++) w.vast.addOffer()
    w.vast.fail('createInstance', NO_CREDIT, 12)
    const app = await w.boot()
    await w.submitJob(app, { frameStart: 1, frameEnd: 40, chunkSize: 2 })
    app.scheduler.kick()

    await w.advance(5 * 60_000, 5_000)

    expect(w.vast.count('createInstance')).toBe(1)
    expect(rowCount()).toBe(1)
    const money = w.alerts().filter((m) => /credit|balance|scale-up/i.test(m))
    expect(money).toHaveLength(1)
    expect(money[0]).toContain('Vast balance $0.30')
    expect(app.nodeManager.accountHold()).not.toBeNull()
  })

  it('a hold outlives a restart, and lifts only once the balance has gone up', async () => {
    w = await setup()
    w.vast.user = { id: 1, credit: 0.3 }
    w.db
      .prepare("INSERT INTO app_state (key, value, updated_at) VALUES ('account_hold', ?, ?)")
      .run(
        JSON.stringify({
          reason: 'Vast balance too low: insufficient_credit',
          balance: 0.3,
          since: Date.now() - 60_000,
          cause: 'credit',
          perHour: 0
        }),
        Date.now() - 60_000
      )
    const app = await started()
    w.vast.addOffer()

    expect(app.nodeManager.accountHold()).toMatchObject({ balance: 0.3 })
    await expect(app.nodeManager.requestNodes(1)).resolves.toEqual([])
    // Still no money: no fleet billing, but nothing has been topped up.
    await w.advance(3 * 60_000, 5_000)
    expect(app.nodeManager.accountHold()).not.toBeNull()
    expect(w.vast.count('createInstance')).toBe(0)

    w.vast.user = { id: 1, credit: 20 }
    await w.advance(60_000, 5_000)
    expect(app.nodeManager.accountHold()).toBeNull()
    await expect(app.nodeManager.requestNodes(1)).resolves.toHaveLength(1)
  })
})

describe('1.20 runway', () => {
  it('warns once under 30 minutes, holds under 10, and a top-up releases the hold', async () => {
    w = await setup({ settings: { spendCapPerHour: 10, maxActiveNodes: 4 } })
    const app = await started()
    const nodeId = await w.readyNode(app, { dph_total: 6 })
    w.vast.addOffer()

    // $2.50 at $6/hr: 25 minutes.
    w.vast.user = { id: 1, credit: 2.5 }
    await w.advance(3 * 60_000, 5_000)
    const warned = w.alerts('warn').filter((m) => m.includes('lasts about'))
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('Vast balance $2.50 lasts about 25 min')
    expect(warned[0]).toContain('Vast.ai console')
    expect(app.nodeManager.accountHold()).toBeNull()

    // $0.90: 9 minutes. Renting stops; the node is left running.
    w.vast.user = { id: 1, credit: 0.9 }
    await w.advance(60_000, 5_000)
    const held = app.nodeManager.accountHold()
    expect(held).toMatchObject({ balance: 0.9 })
    expect(storedHold()).toMatchObject({ cause: 'runway', balance: 0.9, perHour: 6 })
    const errors = w.alerts('error')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('Vast balance $0.90')
    expect(errors[0]).toContain('renting is paused')
    await expect(app.nodeManager.requestNodes(1)).resolves.toEqual([])
    expect(w.vast.count('createInstance')).toBe(1)
    expect(app.nodeManager.get(nodeId)?.state).toBe('ready')

    // Draining further, and the fleet destroyed to stretch it: still held,
    // and nothing said again.
    w.vast.user = { id: 1, credit: 0.8 }
    await app.nodeManager.destroyNode(nodeId)
    await w.advance(2 * 60_000, 5_000)
    expect(app.nodeManager.accountHold()).not.toBeNull()
    expect(w.alerts('error')).toHaveLength(1)
    expect(w.alerts('warn').filter((m) => m.includes('lasts about'))).toHaveLength(1)

    // A top-up to 30 minutes at the rate it was held at releases it.
    w.vast.user = { id: 1, credit: 3 }
    await w.advance(60_000, 5_000)
    expect(app.nodeManager.accountHold()).toBeNull()
    expect(storedHold()).toBeNull()
    expect(w.alerts('info')).toContain('Vast balance $3.00: renting resumes')
    await expect(app.nodeManager.requestNodes(1)).resolves.toHaveLength(1)
  })

  it('released by hand, it is not set again until the runway has recovered first', async () => {
    w = await setup({ settings: { spendCapPerHour: 10 } })
    const app = await started()
    await w.readyNode(app, { dph_total: 6 })
    w.vast.user = { id: 1, credit: 0.9 }
    await w.advance(60_000, 5_000)
    expect(app.nodeManager.accountHold()).not.toBeNull()

    expect(app.nodeManager.releaseAccountHold()).toEqual({})
    await w.advance(3 * 60_000, 5_000)
    expect(app.nodeManager.accountHold()).toBeNull()
  })
})

describe('1.20 an account Vast refuses', () => {
  it('a 401 on a rental holds renting for the session, blacklists nothing, and a saved key lifts it', async () => {
    w = await setup({ settings: { maxActiveNodes: 4 } })
    const app = await started()
    w.vast.addOffer()
    w.vast.addOffer()
    w.vast.fail('createInstance', {
      status: 401,
      message: 'vast.ai PUT /asks/5001/ → 401: bad key'
    })

    await expect(app.nodeManager.requestNodes(2)).resolves.toEqual([])
    expect(w.vast.count('createInstance')).toBe(1)
    expect(app.nodeManager.accountHold()!.reason).toContain('401')
    expect(w.alerts('error')).toHaveLength(1)
    expect(w.alerts('error')[0]).toContain('API key')
    // For this session only: a restart asks Vast afresh.
    expect(storedHold()).toBeNull()

    await app.nodeManager.onApiKeySaved()
    expect(app.nodeManager.accountHold()).toBeNull()
    await expect(app.nodeManager.requestNodes(1)).resolves.toHaveLength(1)
  })
})

describe('1.20 money readouts (Phase 0 review note on 1.1 / 1.20)', () => {
  it('the fleet totals and the balance are pushed at start-up, not a minute in', async () => {
    w = await setup()
    const app = await started()
    expect(w.eventsOf('fleet:cost')).toEqual([
      expect.objectContaining({ perHour: 0, sessionTotal: 0, balance: 100 })
    ])
    expect(app.nodeManager.fleetCost()).toMatchObject({ perHour: 0, balance: 100 })
  })
})
