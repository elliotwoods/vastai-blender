import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AlertEvent, OfferFilters } from '../../shared/models'
import type { ExecResult, SshConnection } from '../ssh/sshConnection'
import type { CreateInstanceOptions } from '../vast/vastClient'
import { HANG, setup, type World } from './harness'

// Checks on the harness itself: that what it fakes agrees with the app it
// stands in for, and that events reach windows through the real ipc.ts.

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

function createOpts(offerId: number): CreateInstanceOptions {
  return {
    offerId,
    image: 'harness/image',
    diskGb: 40,
    onstart: '',
    env: {},
    label: 'vastai-blender abcd1234'
  }
}

/** A connection to a fake machine, made the way nodeManager makes one. */
async function connectTo(
  instanceId: number,
  pinnedHostKey: string | null = null
): Promise<SshConnection> {
  // The mocked class, as nodeManager gets it.
  const ssh = await import('../ssh/sshConnection')
  const [ep] = w.vast.machine(instanceId).endpoints
  return new ssh.SshConnection({
    host: ep.host,
    port: ep.port,
    username: 'root',
    privateKey: Buffer.from('harness private key'),
    pinnedHostKey
  })
}

describe('harness', () => {
  it('fakeSsh and provisioner agree on the remote root', async () => {
    const { REMOTE_ROOT } = await import('../nodes/provisioner')
    const fake = await import('./fakeSsh')
    expect(fake.REMOTE_ROOT).toBe(REMOTE_ROOT)
  })

  it('ipc.ts forwards every bus event, unchanged, to every open window', async () => {
    const app = await w.boot()
    const { emit } = await import('../events')
    const a = w.openWindow()
    const b = w.openWindow()

    const alert: AlertEvent = { level: 'error', message: 'destroy failed' }
    emit('alert', alert)
    w.vast.addOffer()
    const [id] = await app.nodeManager.requestNodes(1)
    await w.until(() => app.nodeManager.get(id)?.state === 'ready', 'node ready')

    // Everything the bus carried since the windows opened, in order, and the
    // same payload objects: what the renderer receives is what was emitted.
    const opened = w.events.findIndex((e) => e.channel === 'alert' && e.payload === alert)
    const expected = w.events.slice(opened).map((e) => ({ channel: e.channel, payload: e.payload }))
    expect(expected.length).toBeGreaterThan(3)
    expect(a.sent).toEqual(expected)
    expect(b.sent).toEqual(expected)
    expect(a.sent[0].payload).toBe(alert)
  })

  it('invoke reaches the real ipcMain handlers', async () => {
    await w.boot()
    const settings = await w.invoke('settings:get')
    expect(settings.projectRoot).toBe(w.settings.projectRoot)
    await w.invoke('settings:set', { idleTimeoutMinutes: 9 })
    expect(w.settings.idleTimeoutMinutes).toBe(9)
  })

  it('refuses a second boot: the engine is module singletons', async () => {
    await w.boot()
    await expect(w.boot()).rejects.toThrow('once per world')
  })
})

describe('fakeVast', () => {
  it('fail never reaches Vast; loseReply takes effect and then throws', async () => {
    const { VastError } = await import('../vast/vastClient')
    const offer = w.vast.addOffer()

    w.vast.fail('createInstance', new Error('connect ECONNREFUSED'))
    await expect(w.vast.createInstance(createOpts(offer.id))).rejects.toThrow('ECONNREFUSED')
    expect(w.vast.live()).toEqual([])

    w.vast.loseReply('createInstance', new Error('read ECONNRESET'))
    await expect(w.vast.createInstance(createOpts(offer.id))).rejects.toThrow('ECONNRESET')
    const [id] = w.vast.live()
    expect(w.vast.instance(id)?.label).toBe('vastai-blender abcd1234')

    // A destroy whose reply is lost has still destroyed: the instance stops
    // billing, though the caller was told the call failed.
    w.vast.loseReply('destroyInstance', { status: 502, message: 'bad gateway' })
    await expect(w.vast.destroyInstance(id)).rejects.toBeInstanceOf(VastError)
    expect(w.vast.live()).toEqual([])
    expect(w.vast.destroyed).toEqual([id])
    // Still on record after it is gone.
    expect(w.vast.instance(id)?.label).toBe('vastai-blender abcd1234')
  })

  it('a held call can be let through with its reply lost', async () => {
    const offer = w.vast.addOffer()
    const gate = w.vast.hold('createInstance')
    const creating = watch(w.vast.createInstance(createOpts(offer.id)))
    await w.until(() => gate.reached, 'create in flight')
    expect(w.vast.live()).toEqual([])

    gate.loseReply(new Error('read ECONNRESET'))
    await w.until(() => creating.done, 'create settles')
    expect((creating.error as Error).message).toBe('read ECONNRESET')
    expect(w.vast.live()).toHaveLength(1)
  })
})

describe('fakeSsh', () => {
  it('a changed host key ends reconnectWithBackoff at once, as the real one does', async () => {
    const { HostKeyMismatchError } = await import('../ssh/sshConnection')
    const inst = w.vast.addInstance()
    const ssh = await connectTo(inst.id, 'the key of some other box')

    const started = Date.now()
    const reconnect = watch(ssh.reconnectWithBackoff())
    // Long enough for the whole 10-minute budget, were it (wrongly) retrying.
    await w.until(() => reconnect.done, 'reconnect gives up', { timeoutMs: 15 * 60_000 })

    expect(reconnect.error).toBeInstanceOf(HostKeyMismatchError)
    expect(Date.now() - started).toBe(0)
  })

  it('a wedged exec ends with exit code null when its connection closes or its box is destroyed', async () => {
    const inst = w.vast.addInstance()
    const machine = w.vast.machine(inst.id).onExec(/^sleep/, HANG)
    const dropped: ExecResult = { code: null, stdout: '', stderr: '' }

    // The app closes the connection.
    const a = await connectTo(inst.id)
    const onClose = watch(a.exec('sleep infinity'))
    await w.until(() => machine.ran(/^sleep/).length === 1, 'first exec running')
    a.close()
    await w.until(() => onClose.done, 'exec ends with its connection', { timeoutMs: 60_000 })
    expect(onClose.value).toEqual(dropped)

    // The instance is destroyed under an open connection.
    const b = await connectTo(inst.id)
    const onKill = watch(b.exec('sleep infinity'))
    await w.until(() => machine.ran(/^sleep/).length === 2, 'second exec running')
    await w.vast.destroyInstance(inst.id)
    await w.until(() => onKill.done, 'exec ends with its machine', { timeoutMs: 60_000 })
    expect(onKill.value).toEqual(dropped)
  })
})

describe('settings', () => {
  it("start from the real settings.ts's defaults, but for the harness's own", async () => {
    const real = await vi.importActual<typeof import('../settings')>('../settings')
    const production = real.getSettings()
    expect(w.settings).toEqual({
      ...production,
      hasVastApiKey: true,
      projectRoot: w.settings.projectRoot,
      blenderVersionOverride: '4.2.3'
    })
    expect(w.settings.projectRoot.startsWith(w.dir)).toBe(true)
  })

  it('getSettings hands out a copy; updateSettings merges filters and ignores has* flags', async () => {
    const { getSettings } = await import('../settings')
    const held = getSettings()
    const before = held.maxActiveNodes

    // The app's snapshot neither follows the test's edits nor writes back.
    w.settings.maxActiveNodes = before + 5
    held.offerFilters.minDiskGb = 1
    expect(held.maxActiveNodes).toBe(before)
    expect(getSettings().maxActiveNodes).toBe(before + 5)
    expect(w.settings.offerFilters.minDiskGb).toBe(40)

    // What the renderer sends through settings:set.
    await w.boot()
    const out = await w.invoke('settings:set', {
      offerFilters: { maxDphTotal: 1 } as OfferFilters,
      hasVastApiKey: false
    })
    expect(w.settings.offerFilters).toMatchObject({ maxDphTotal: 1, minDiskGb: 40 })
    expect(w.settings.hasVastApiKey).toBe(true)
    expect(out).toEqual(w.settings)
    expect(out).not.toBe(w.settings)
  })

  it('setup merges a partial offerFilters over the defaults', async () => {
    w = await setup({ settings: { offerFilters: { maxDphTotal: 1 } } })
    expect(w.settings.offerFilters).toMatchObject({ maxDphTotal: 1, minDiskGb: 40 })
  })
})

describe('isolation', () => {
  it("a finished test's leftover work fails loudly instead of reaching the next test", async () => {
    // Module instances as this test's app code holds them.
    const { getSettings } = await import('../settings')
    const { getDb } = await import('../db/db')
    await w.dispose()
    w = await setup()

    expect(() => getSettings()).toThrow('stale call from a finished test')
    expect(() => getDb()).toThrow('stale call from a finished test')
    // The new test's own modules are unaffected.
    const fresh = await import('../settings')
    expect(fresh.getSettings().projectRoot).toBe(w.settings.projectRoot)
  })
})
