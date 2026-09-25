import { afterEach, describe, expect, it } from 'vitest'
import type { CapacityBudget } from '../../shared/models'
import { setup, type App, type World } from '../test/harness'

// Plan 1.5: the spend cap is a budget, not a yes/no (audit A7; #5 #16 #35 #65
// #94 #144 #158 #172 #211).
//
// requestNodes used to allow a rental whenever the fleet was still under the
// cap, whatever the offer cost: with a $2/h cap and $1.95/h running, the next
// rental could be an $8/h multi-GPU box. The manual "request node" button
// ignored the cap altogether. And the batch read maxActiveNodes once, before
// its awaits, so a batch under way kept renting after the user lowered it
// (Phase 0 review note on 1.1).
//
// Now the search asks only for offers within what the cap leaves (maxDphTotal
// = min(filter, headroom)); before each rental the caps are taken afresh from
// the live fleet and settings, and the offer must fit after its own price. A
// manual request stops at the cap unless the user confirmed going past it.

let w: World
afterEach(() => w.dispose())

async function started(): Promise<App> {
  const app = await w.boot({ start: false })
  app.nodeManager.init()
  await w.advance(1_000)
  return app
}

/** The price ceiling of the latest offer search, as sent to Vast. */
function lastSearchCeiling(): unknown {
  const [q] = w.vast.argsOf('searchOffers').at(-1) as [Record<string, unknown>]
  return q.dph_total
}

/** The prices of the instances rented, in order. */
function rentedPrices(): number[] {
  return w.vast.created.map((id) => w.vast.instance(id)!.dph_total!)
}

describe('1.5 cap headroom at rent time (A7)', () => {
  it('cap $2 with $1.95/h running: the search asks for $0.05/h at most, and the $8/h box is not rented', async () => {
    w = await setup({ settings: { spendCapPerHour: 2, maxActiveNodes: 4 } })
    const app = await started()
    await w.readyNode(app, { dph_total: 1.95 })
    w.vast.addOffer({ dph_total: 8, num_gpus: 8, gpu_name: 'RTX 4090', dlperf_per_dphtotal: 900 })
    w.vast.addOffer({ dph_total: 0.4 })
    w.vast.addOffer({ dph_total: 0.04, dlperf_per_dphtotal: 10 })

    const ids = await app.nodeManager.requestNodes(2)

    expect(lastSearchCeiling()).toEqual({ lte: 0.05 })
    expect(ids).toHaveLength(1)
    expect(rentedPrices()).toEqual([1.95, 0.04])
    expect(app.nodeManager.billingPerHour()).toBeCloseTo(1.99)
  })

  it('the offer filter still binds when it is lower than what the cap leaves', async () => {
    w = await setup({ settings: { spendCapPerHour: 5, offerFilters: { maxDphTotal: 0.5 } } })
    const app = await started()
    w.vast.addOffer({ dph_total: 0.4 })
    await app.nodeManager.requestNodes(1)
    expect(lastSearchCeiling()).toEqual({ lte: 0.5 })
  })

  it('each rental must fit what the live fleet leaves after its own price', async () => {
    w = await setup({ settings: { spendCapPerHour: 2, maxActiveNodes: 4 } })
    const app = await started()
    await w.readyNode(app, { dph_total: 1.2 })
    // Both fit the $0.80 the search is given; not both together.
    w.vast.addOffer({ dph_total: 0.5 })
    w.vast.addOffer({ dph_total: 0.5 })

    const ids = await app.nodeManager.requestNodes(2)

    expect(lastSearchCeiling()).toEqual({ lte: 0.8 })
    expect(ids).toHaveLength(1)
    expect(w.vast.count('createInstance')).toBe(2)
    expect(app.nodeManager.billingPerHour()).toBeCloseTo(1.7)
  })

  it('maxActiveNodes is read again before each rental: lowered mid-batch, the batch stops', async () => {
    w = await setup({ settings: { maxActiveNodes: 3 } })
    const app = await started()
    w.vast.addOffer()
    w.vast.addOffer()
    w.vast.addOffer()
    const gate = w.vast.hold('createInstance')
    const batch = app.nodeManager.requestNodes(3)
    await w.until(() => gate.reached, 'the first create in flight')
    // The user lowers the cap while the first create awaits Vast.
    w.settings.maxActiveNodes = 1
    gate.release()

    await expect(batch).resolves.toHaveLength(1)
    expect(w.vast.count('createInstance')).toBe(1)
  })

  it('so is the spend cap: lowered mid-batch, the next offer must fit the new one', async () => {
    w = await setup({ settings: { spendCapPerHour: 4, maxActiveNodes: 4 } })
    const app = await started()
    w.vast.addOffer({ dph_total: 1 })
    w.vast.addOffer({ dph_total: 1 })
    const gate = w.vast.hold('createInstance')
    const batch = app.nodeManager.requestNodes(2)
    await w.until(() => gate.reached, 'the first create in flight')
    w.settings.spendCapPerHour = 1.5
    gate.release()

    await expect(batch).resolves.toHaveLength(1)
    expect(w.vast.count('createInstance')).toBe(1)
  })

  it('a scheduler budget stops the batch once what it rented covers the demand (#227 #237)', async () => {
    w = await setup({ settings: { spendCapPerHour: 20, maxActiveNodes: 8 } })
    const app = await started()
    // Best-ranked first: a 4-GPU box, then 1-GPU ones.
    w.vast.addOffer({ num_gpus: 4, dph_total: 1.6, dlperf_per_dphtotal: 1000 })
    for (let i = 0; i < 4; i++) w.vast.addOffer({ num_gpus: 1, dph_total: 0.4 })
    const budget: CapacityBudget = {
      nodes: 0,
      maxNodes: 8,
      nodeRoom: 8,
      perHour: 0,
      spendCap: 20,
      headroomPerHour: 20,
      // Four exclusive lanes wanted: the 4-GPU box brings them all.
      exclusiveLanes: 4,
      sharedSlots: 0
    }

    const ids = await app.nodeManager.requestNodes(8, { budget })

    expect(ids).toHaveLength(1)
    expect(w.vast.instance(w.vast.created[0])?.num_gpus).toBe(4)
  })
})

describe('1.5 manual requests and the cap', () => {
  it('the Fleet button stops at the spend cap; past it only when the user confirmed', async () => {
    w = await setup({ settings: { spendCapPerHour: 2, maxActiveNodes: 4 } })
    const app = await started()
    await w.readyNode(app, { dph_total: 1.95 })
    w.vast.addOffer({ dph_total: 0.4 })

    await expect(app.nodeManager.requestNode()).rejects.toThrow(/spend cap/)
    expect(w.vast.count('createInstance')).toBe(1)

    await expect(app.nodeManager.requestNode({ overSpendCap: true })).resolves.toBeDefined()
    expect(rentedPrices()).toEqual([1.95, 0.4])
  })

  it('at the cap it says so before searching', async () => {
    w = await setup({ settings: { spendCapPerHour: 2, maxActiveNodes: 4 } })
    const app = await started()
    await w.readyNode(app, { dph_total: 2 })
    const searches = w.vast.count('searchOffers')
    w.vast.addOffer({ dph_total: 0.4 })

    await expect(app.nodeManager.requestNode()).rejects.toThrow(/Spend cap reached/)
    expect(w.vast.count('searchOffers')).toBe(searches)
    // maxActiveNodes holds whatever the user confirmed.
    w.settings.maxActiveNodes = 1
    await expect(app.nodeManager.requestNode({ overSpendCap: true })).rejects.toThrow(
      /max active nodes/
    )
  })

  it('a missing cap without "no cap" rents nothing, and says how to fix it', async () => {
    w = await setup({ settings: { spendCapPerHour: null } })
    const app = await started()
    w.vast.addOffer({ dph_total: 0.4 })
    await expect(app.nodeManager.requestNode()).rejects.toThrow(/No spend cap is set/)
    await expect(app.nodeManager.requestNodes(1)).resolves.toEqual([])
    expect(w.vast.count('createInstance')).toBe(0)
  })
})
