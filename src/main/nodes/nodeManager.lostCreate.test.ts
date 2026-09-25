import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setup, type App, type World } from '../test/harness'

// Plan 1.4: a create whose outcome is unknown is found by its label.
//
// A PUT /asks can be carried out by Vast and its reply lost: a gateway 502 or
// 504, a connection reset, a timeout, a reply that is not JSON. The app used
// to record such a create as "not rented", mark the row failed, blacklist the
// machine, and rent the next offer in the same batch at once. The instance
// Vast had rented billed under the row's label, counted by nothing and seen
// by nothing until the next start's orphan sweep (#223 #231 #43 #193).
//
// Now: an explicit refusal (a 4xx) means nothing was rented, and the batch
// moves on. No answer means the instance may exist: the batch stops, the row
// keeps counting as billing, and listInstances is asked for its label for
// about a minute. The instance is adopted if found; the row stops counting
// once Vast has answered without it. PUT /asks is never sent twice.

let w: World
beforeEach(async () => {
  w = await setup({ settings: { maxActiveNodes: 4 } })
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

interface RowView {
  id: string
  state: string
  instance_id: number | null
  create_unknown_since: number | null
  last_error: string | null
}

function rows(): RowView[] {
  return w.all<RowView>(
    'SELECT id, state, instance_id, create_unknown_since, last_error FROM nodes ORDER BY rowid'
  )
}

/**
 * Whether a machine is still rentable, i.e. not blacklisted as having failed:
 * offer it again and see whether it rents. The blacklist is private, and
 * this is the only thing it changes.
 */
async function rentsAgain(app: App, machineId: number): Promise<boolean> {
  w.vast.offers = []
  w.vast.addOffer({ machine_id: machineId })
  const ids = await app.nodeManager.requestNodes(1).catch(() => [])
  return ids.length === 1
}

/** The lookup's calls, not the start-up sweep's. */
function lookups(since: number): number {
  return w.vast.calls.slice(since).filter((c) => c.method === 'listInstances').length
}

describe('1.4: a create with no answer is looked for by its label (#223 #231)', () => {
  const lost: Array<[what: string, error: () => Error | { status?: number; message: string }]> = [
    ['the connection reset after Vast took it', () => new Error('read ECONNRESET')],
    [
      'a 502 from the gateway after Vast took it',
      () => ({ status: 502, message: 'vast.ai PUT /asks/5001/ → 502: bad gateway' })
    ],
    [
      'no reply within the deadline',
      () => ({ message: 'network error: no answer within 30 s (timed out)' })
    ]
  ]
  for (const [what, error] of lost) {
    it(`${what}: the instance is found within a minute and used; the batch stops, no second rent`, async () => {
      const app = await w.boot()
      for (let i = 0; i < 3; i++) w.vast.addOffer()
      const calls = w.vast.calls.length
      w.vast.loseReply('createInstance', error())
      const start = Date.now()

      const batch = watch(app.nodeManager.requestNodes(2))
      await w.until(() => batch.done, 'the batch ends')

      // One rental, and only one create: the batch did not go on to the
      // next offer while an instance it could not see might be billing.
      const [row] = rows()
      expect(batch.value).toEqual([row.id])
      expect(w.vast.count('createInstance')).toBe(1)
      const [instanceId] = w.vast.created
      expect(w.vast.instance(instanceId)?.label).toBe(labelOf(row.id))
      expect(lookups(calls)).toBeGreaterThanOrEqual(1)
      expect(Date.now() - start).toBeLessThan(60_000)
      // Adopted: the row holds the instance, and the rental carries on.
      expect(row).toMatchObject({ instance_id: instanceId, create_unknown_since: null })
      await w.until(() => app.nodeManager.get(row.id)?.state === 'ready', 'node ready')
      expect(Date.now() - start).toBeLessThan(60_000)
      expect(w.vast.live()).toEqual([instanceId])
      expect(w.vast.count('destroyInstance')).toBe(0)
      expect(app.nodeManager.activeCount()).toBe(1)
      expect(w.alerts('error')).toEqual([])
      // Still no second rent once the dust has settled.
      await w.advance(2 * 60_000, 5_000)
      expect(w.vast.count('createInstance')).toBe(1)
    })
  }

  it('nothing rented after all: counted while it is looked for, then not, and the machine is not blamed', async () => {
    const app = await w.boot()
    const offer = w.vast.addOffer()
    w.vast.addOffer()
    // The PUT never reached Vast, but the app cannot know that.
    w.vast.fail('createInstance', { message: 'network error: fetch failed: read ECONNRESET' })
    const start = Date.now()

    const batch = watch(app.nodeManager.requestNodes(2))
    await w.advance(30_000)
    // Half-way: the row may stand for a billing instance, so it counts, and
    // nothing else has been rented next to it.
    const [row] = rows()
    expect(row).toMatchObject({ state: 'requested', instance_id: null })
    expect(row.create_unknown_since).not.toBeNull()
    expect(app.nodeManager.activeCount()).toBe(1)
    expect(app.nodeManager.billingPerHour()).toBeCloseTo(0.4)
    expect(batch.done).toBe(false)
    expect(w.vast.count('createInstance')).toBe(1)

    await w.until(() => batch.done, 'the batch ends')
    expect(Date.now() - start).toBeGreaterThanOrEqual(60_000)
    expect(Date.now() - start).toBeLessThan(90_000)
    expect((batch.error as Error).message).toMatch(/nothing was rented/)
    expect(rows()[0]).toMatchObject({
      state: 'failed',
      instance_id: null,
      create_unknown_since: null
    })
    expect(rows()[0].last_error).toMatch(/no instance appeared under its label/)
    expect(app.nodeManager.activeCount()).toBe(0)
    expect(w.vast.count('createInstance')).toBe(1)
    expect(w.vast.live()).toEqual([])
    // A blip, not the machine's fault.
    expect(await rentsAgain(app, offer.machine_id)).toBe(true)
  })

  it('Vast silent on the lookup too: the row stays counted, the batch gives up waiting, and the instance is used once Vast answers', async () => {
    const app = await w.boot()
    w.settings.maxActiveNodes = 1
    w.vast.addOffer()
    w.vast.addOffer()
    w.vast.loseReply('createInstance', {
      status: 504,
      message: 'vast.ai PUT /asks/5001/ → 504: gateway timeout'
    })
    w.vast.fail(
      'listInstances',
      { status: 503, message: 'vast.ai GET /instances/?owner=me → 503: service unavailable' },
      10
    )

    const batch = watch(app.nodeManager.requestNodes(2))
    await w.until(() => batch.done, 'the batch gives up waiting', { stepMs: 1_000 })
    expect((batch.error as Error).message).toMatch(/keeps looking/)
    const [row] = rows()
    const label = labelOf(row.id)
    expect(row).toMatchObject({ state: 'requested', instance_id: null })
    expect(row.create_unknown_since).not.toBeNull()
    expect(app.nodeManager.activeCount()).toBe(1)
    const warned = w.alerts('warn').filter((m) => m.includes(label))
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('Vast.ai console')
    // Counted, so no replacement: the cap is full.
    await expect(app.nodeManager.requestNodes(1)).resolves.toEqual([])
    expect(w.vast.count('createInstance')).toBe(1)

    await w.until(() => app.nodeManager.get(row.id)?.state === 'ready', 'found and ready', {
      timeoutMs: 10 * 60_000,
      stepMs: 5_000
    })
    const [instanceId] = w.vast.created
    expect(rows()[0]).toMatchObject({ instance_id: instanceId, create_unknown_since: null })
    expect(w.vast.live()).toEqual([instanceId])
    expect(w.vast.count('createInstance')).toBe(1)
    expect(w.alerts('error')).toEqual([])
  })

  it('destroyed while it is looked for: what the lookup finds is destroyed, not used', async () => {
    const app = await w.boot()
    w.vast.addOffer()
    w.vast.loseReply('createInstance', new Error('read ECONNRESET'))
    const lookup = w.vast.hold('listInstances')
    const batch = watch(app.nodeManager.requestNodes(1))
    await w.until(() => lookup.reached, 'the lookup asks Vast')
    const [{ id }] = rows()

    await app.nodeManager.destroyNode(id)
    expect(app.nodeManager.get(id)?.state).toBe('destroying')
    expect(app.nodeManager.activeCount()).toBe(1)
    lookup.release()
    await w.until(() => batch.done, 'the batch ends')

    const [instanceId] = w.vast.created
    expect(w.vast.argsOf('destroyInstance')).toEqual([[instanceId]])
    expect(w.vast.live()).toEqual([])
    expect(rows()[0]).toMatchObject({ state: 'destroyed', instance_id: instanceId })
    expect(w.vast.machine(instanceId).connects).toBe(0)
    expect(app.nodeManager.activeCount()).toBe(0)
    expect(w.alerts('error')).toEqual([])
  })
})

describe('1.4: a create Vast answered is settled at once', () => {
  it('a 400 refusal rented nothing: not billing, no lookup, and the batch moves on', async () => {
    const app = await w.boot()
    for (let i = 0; i < 3; i++) w.vast.addOffer()
    const calls = w.vast.calls.length
    w.vast.fail('createInstance', { status: 400, message: 'create instance failed: no_such_ask' })

    const ids = await app.nodeManager.requestNodes(2)

    expect(ids).toHaveLength(2)
    expect(w.vast.count('createInstance')).toBe(3)
    const [refused] = rows()
    expect(refused).toMatchObject({
      state: 'failed',
      instance_id: null,
      create_unknown_since: null
    })
    expect(ids).not.toContain(refused.id)
    expect(lookups(calls)).toBe(0)
    expect(app.nodeManager.activeCount()).toBe(2)
  })

  it('a 429 rented nothing, and is no fault of the machine: the batch stops, and the create is not sent again', async () => {
    const app = await w.boot()
    const offer = w.vast.addOffer()
    w.vast.addOffer()
    w.vast.fail('createInstance', {
      status: 429,
      message: 'vast.ai PUT /asks/5001/ → 429: {"error":"rate_limit_exceeded"}'
    })

    await expect(app.nodeManager.requestNodes(2)).rejects.toThrow('429')

    expect(w.vast.count('createInstance')).toBe(1)
    expect(rows()[0]).toMatchObject({ state: 'failed', create_unknown_since: null })
    expect(app.nodeManager.activeCount()).toBe(0)
    expect(await rentsAgain(app, offer.machine_id)).toBe(true)
  })
})
