import { readFileSync } from 'fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FleetHolds, MetricsSample, UnclaimedInstance } from '../shared/models'
import { setup, type World } from './test/harness'

// The integration wave's IPC (Phase 1): every channel the shared contract
// declares has a handler in main, and the Phase 1 ones reach the code the
// tracks built. Before this, fleet:unclaimed, fleet:destroyUnclaimed,
// fleet:holds, fleet:releaseHold, fleet:gpuHistory and node:metricsHistory
// rejected with "No handler registered", fleet:requestNode dropped its
// options, and a saved API key reconciled nothing until the next 5-minute
// pass.

let w: World
beforeEach(async () => {
  w = await setup({ settings: { maxActiveNodes: 4, spendCapPerHour: 10 } })
})
afterEach(() => w.dispose())

/** Every invoke channel IpcInvokeMap declares, read from the contract's source. */
function contractChannels(): string[] {
  const src = readFileSync(new URL('../shared/ipc.ts', import.meta.url), 'utf-8')
  const body = src.slice(src.indexOf('export interface IpcInvokeMap {'))
  const end = body.indexOf('\n}\n')
  return [...body.slice(0, end).matchAll(/^ {2}'([a-z]+:[A-Za-z]+)': \{/gm)].map((m) => m[1])
}

/** Seconds since the epoch, as Vast reports start_date, `agoMs` ago. */
function vastTime(agoMs: number): number {
  return (Date.now() - agoMs) / 1000
}

describe('the Phase 1 IPC contract in main', () => {
  it('every invoke channel the contract declares has a handler', async () => {
    await w.boot({ start: false })
    const declared = contractChannels()
    expect(declared.length).toBeGreaterThan(40)
    for (const ch of [
      'fleet:unclaimed',
      'fleet:destroyUnclaimed',
      'fleet:holds',
      'fleet:releaseHold',
      'fleet:gpuHistory',
      'node:metricsHistory',
      'node:openVncTunnel',
      'job:retryMissing',
      'node:reprovision',
      'job:resume',
      'scheduler:scaleStatus'
    ]) {
      expect(declared).toContain(ch)
    }
    expect(declared.filter((ch) => !w.ipcHandlers.has(ch))).toEqual([])
  })

  it('1.3: fleet:unclaimed lists, pushes, and fleet:destroyUnclaimed destroys only a listed instance', async () => {
    const foreign = w.vast.addInstance({
      label: 'vastai-blender 0bad0bad:12345678',
      start_date: vastTime(30 * 60_000)
    })
    const win = w.openWindow()
    const app = await w.boot()
    await w.advance(1_000)
    const nodeId = await w.readyNode(app)
    const own = w.get<{ instance_id: number }>(
      'SELECT instance_id FROM nodes WHERE id = ?',
      nodeId
    )!.instance_id

    const listed = await w.invoke('fleet:unclaimed')
    expect(listed.map((u) => u.instanceId)).toEqual([foreign.id])
    const pushed = win.sent.filter((s) => s.channel === 'fleet:unclaimed')
    expect((pushed.at(-1)?.payload as UnclaimedInstance[]).map((u) => u.instanceId)).toEqual([
      foreign.id
    ])

    // The node's own instance, an id nobody listed, and nonsense: refused, nothing sent.
    for (const id of [own, 424242, -1, 1.5, Number.NaN]) {
      expect((await w.invoke('fleet:destroyUnclaimed', id)).ok).toBe(false)
    }
    expect(w.vast.count('destroyInstance')).toBe(0)

    expect(await w.invoke('fleet:destroyUnclaimed', foreign.id)).toMatchObject({ ok: true })
    expect(w.vast.argsOf('destroyInstance')).toEqual([[foreign.id]])
    expect(win.sent.filter((s) => s.channel === 'fleet:unclaimed').at(-1)?.payload).toEqual([])
    expect(app.nodeManager.get(nodeId)?.state).toBe('ready')
  })

  it('1.20: fleet:holds names the account hold, pushes it, and fleet:releaseHold releases it', async () => {
    w.vast.addOffer()
    w.vast.fail('createInstance', { status: 400, message: 'insufficient_credit' })
    const win = w.openWindow()
    const app = await w.boot()
    await expect(w.invoke('fleet:requestNode')).rejects.toThrow(/Renting is paused/)
    const holds = await w.invoke('fleet:holds')
    expect(holds.account?.reason).toMatch(/credit/i)
    const pushed = win.sent.filter((s) => s.channel === 'fleet:holds')
    expect((pushed.at(-1)?.payload as FleetHolds).account).toBeDefined()

    const left = await w.invoke('fleet:releaseHold', 'account')
    expect(left.account).toBeUndefined()
    expect(app.nodeManager.accountHold()).toBeNull()
    expect(
      (win.sent.filter((s) => s.channel === 'fleet:holds').at(-1)?.payload as FleetHolds).account
    ).toBeUndefined()
    await expect(w.invoke('fleet:releaseHold', 'nonsense' as 'account')).rejects.toThrow(
      /no such hold/
    )
  })

  it('1.5: fleet:requestNode stops at the cap, and past it rents no dearer than the price it names', async () => {
    w.settings.spendCapPerHour = 0.5
    w.vast.addOffer({ dph_total: 0.8 })
    const app = await w.boot()
    // $0.80 under a $0.50 cap: the search finds nothing it may rent.
    await expect(w.invoke('fleet:requestNode')).rejects.toThrow(/at or under \$0\.50\/hr/)
    // Confirmed past the cap, but at most $0.60: still nothing.
    await expect(
      w.invoke('fleet:requestNode', { overSpendCap: true, maxPerHour: 0.6 })
    ).rejects.toThrow(/at or under \$0\.60\/hr/)
    expect(w.vast.count('createInstance')).toBe(0)
    // At most $1: rented.
    await w.invoke('fleet:requestNode', { overSpendCap: true, maxPerHour: 1 })
    expect(w.vast.count('createInstance')).toBe(1)
    expect(app.nodeManager.list()).toHaveLength(1)
  })

  it('1.3 / 1.20: saving a Vast key reconciles at once and lifts a hold the old key caused', async () => {
    w.vast.addOffer()
    w.vast.fail('createInstance', { status: 401, message: 'invalid api key' })
    const app = await w.boot()
    await w.advance(1_000)
    await expect(w.invoke('fleet:requestNode')).rejects.toThrow(/Renting is paused/)
    expect(app.nodeManager.accountHold()).not.toBeNull()
    const lists = w.vast.count('listInstances')
    await w.invoke('settings:setSecret', 'vastApiKey', 'a-new-key')
    await w.advance(1_000)
    expect(w.vast.count('listInstances')).toBeGreaterThan(lists)
    expect(app.nodeManager.accountHold()).toBeNull()
  })

  it('Feature G: node:metricsHistory and fleet:gpuHistory answer, and every sample is pushed', async () => {
    const win = w.openWindow()
    const app = await w.boot()
    const nodeId = await w.readyNode(app, { num_gpus: 2 })
    await w.advance(2 * 60_000, 1_000)
    const samples = win.sent
      .filter((s) => s.channel === 'node:metricsSample')
      .map((s) => s.payload as MetricsSample)
    expect(samples.filter((s) => s.nodeId === nodeId).length).toBeGreaterThan(3)

    const now = Date.now()
    const node = await w.invoke('node:metricsHistory', {
      nodeId,
      fromMs: now - 10 * 60_000,
      toMs: now,
      maxPoints: 20
    })
    expect(node.nodeId).toBe(nodeId)
    expect(node.gpus.map((g) => g.index)).toEqual([0, 1])
    const fleet = await w.invoke('fleet:gpuHistory', {
      fromMs: now - 10 * 60_000,
      toMs: now,
      maxPoints: 20
    })
    expect(fleet.points.some((p) => (p.gpusRented ?? 0) === 2)).toBe(true)
    await expect(w.invoke('node:metricsHistory', {} as never)).rejects.toThrow(/nodeId/)
  })

  it('1.17: job:resume releases a job the breaker held; scheduler:scaleStatus says why scale-up rents or not', async () => {
    const app = await w.boot()
    const jobId = await w.submitJob(app)
    w.db.prepare('UPDATE jobs SET attention = ? WHERE id = ?').run(
      JSON.stringify({
        kind: 'repeatedFailure',
        message: 'the same failure on 2 nodes',
        since: 1
      }),
      jobId
    )
    expect(await w.invoke('job:resume', jobId)).toBe(true)
    expect(
      w.get<{ attention: string | null }>('SELECT attention FROM jobs WHERE id = ?', jobId)
    ).toEqual({ attention: null })
    expect(await w.invoke('job:resume', jobId)).toBe(false)

    await w.advance(20_000)
    const status = await w.invoke('scheduler:scaleStatus')
    expect(status?.status).toBeDefined()
    expect(typeof status?.reason).toBe('string')
  })
})
