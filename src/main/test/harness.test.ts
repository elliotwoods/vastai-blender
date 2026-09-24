import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'
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

  it('main can raise OS notifications and ask which window has focus', async () => {
    const { BrowserWindow, Notification } = await import('electron')
    expect(Notification.isSupported()).toBe(true)
    const n = new Notification({ title: 'Destroy failed', body: 'check the Vast.ai console' })
    const clicks: string[] = []
    n.on('click', () => clicks.push('click'))
    n.show()

    expect(w.notifications).toHaveLength(1)
    expect(w.notifications[0]).toMatchObject({
      options: { title: 'Destroy failed', body: 'check the Vast.ai console' },
      shown: true
    })
    // The user clicks it.
    w.notifications[0].emit('click')
    expect(clicks).toEqual(['click'])

    expect(BrowserWindow.getFocusedWindow()).toBeNull()
    const win = w.openWindow()
    expect(BrowserWindow.getFocusedWindow()).toBeNull()
    win.focused = true
    expect(BrowserWindow.getFocusedWindow()).toBe(win)

    w.notificationsSupported = false
    expect(Notification.isSupported()).toBe(false)
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

  it('an instance that is gone is a 404, as on Vast: a second destroy fails', async () => {
    const { VastError } = await import('../vast/vastClient')
    const client = await import('../vast/vastClient')
    const a = w.vast.addInstance()
    const b = w.vast.addInstance()

    await client.destroyInstance(a.id)
    const again = client.destroyInstance(a.id)
    await expect(again).rejects.toBeInstanceOf(VastError)
    await expect(again).rejects.toMatchObject({ status: 404 })
    // Destroyed with the reply lost, then destroyed again because the app
    // never heard: the retry is the 404, not a success.
    w.vast.loseReply('destroyInstance', new Error('read ECONNRESET'))
    await expect(client.destroyInstance(b.id)).rejects.toThrow('ECONNRESET')
    await expect(client.destroyInstance(b.id)).rejects.toMatchObject({ status: 404 })
    // And one that never existed.
    await expect(client.destroyInstance(4242)).rejects.toMatchObject({ status: 404 })

    expect(w.vast.destroyed).toEqual([a.id, b.id])
    expect(w.vast.count('destroyInstance')).toBe(5)
  })

  it('showInstance answers null for an instance that is gone, as vastClient maps the 404', async () => {
    const client = await import('../vast/vastClient')
    const inst = w.vast.addInstance()
    await expect(client.showInstance(inst.id)).resolves.toMatchObject({
      id: inst.id,
      actual_status: 'running'
    })

    // Scripted: the obvious way to say "gone" reads as gone.
    w.vast.fail('showInstance', { status: 404, message: 'vast.ai GET → 404: not found' })
    await expect(client.showInstance(inst.id)).resolves.toBeNull()
    // Anything else is passed on. A scripted 429 is one that outlasted
    // request()'s retries.
    w.vast.fail('showInstance', { status: 429, message: 'vast.ai GET → 429: slow down' })
    await expect(client.showInstance(inst.id)).rejects.toMatchObject({ status: 429 })

    await client.destroyInstance(inst.id)
    await expect(client.showInstance(inst.id)).resolves.toBeNull()
    // The server's own answer is the 404.
    await expect(w.vast.showInstance(inst.id)).rejects.toMatchObject({ status: 404 })

    // registerSshKey takes a "duplicate" refusal as done, as vastClient does.
    w.vast.fail('registerSshKey', { status: 400, message: 'vast.ai POST → 400: duplicate key' })
    await expect(client.registerSshKey('ssh-ed25519 AAAA')).resolves.toBeUndefined()
  })

  it('with no API key every vastClient call rejects, and nothing reaches Vast', async () => {
    w = await setup({ secrets: { vastApiKey: undefined } })
    const client = await import('../vast/vastClient')
    const offer = w.vast.addOffer()
    const inst = w.vast.addInstance()

    const noKey = new client.VastError('No Vast.ai API key configured')
    await expect(client.searchOffers({})).rejects.toThrow(noKey)
    await expect(client.createInstance(createOpts(offer.id))).rejects.toThrow(noKey)
    await expect(client.listInstances()).rejects.toThrow(noKey)
    await expect(client.showInstance(inst.id)).rejects.toThrow(noKey)
    await expect(client.destroyInstance(inst.id)).rejects.toThrow(noKey)
    await expect(client.listSshKeys()).rejects.toThrow(noKey)
    await expect(client.registerSshKey('ssh-ed25519 AAAA')).rejects.toThrow(noKey)
    await expect(client.currentUser()).rejects.toThrow(noKey)

    // The app, booted without a key: the start-up sweep and a rent both get
    // nowhere. Nothing is rented and nothing destroyed.
    const app = await w.boot()
    await expect(app.nodeManager.requestNodes(1)).rejects.toThrow(noKey)
    expect(w.vast.calls).toEqual([])
    expect(w.vast.live()).toEqual([inst.id])

    // Saved: the next call goes through.
    const { setSecret } = await import('../settings')
    setSecret('vastApiKey', 'a key at last')
    await expect(client.listInstances()).resolves.toHaveLength(1)
  })

  it('searchOffers filters, orders and limits by the query, as Vast does', async () => {
    const client = await import('../vast/vastClient')
    const { buildQuery, findOffers } = await import('../vast/offers')
    const mid = w.vast.addOffer({ dph_total: 0.5 })
    const dear = w.vast.addOffer({ dph_total: 0.9, gpu_name: 'H100 SXM', num_gpus: 4 })
    const cheap = w.vast.addOffer({ dph_total: 0.3, gpu_name: 'RTX 3090' })
    // Below production's default filters: 8 GB of VRAM, an unreliable host.
    w.vast.addOffer({ dph_total: 0.2, gpu_ram: 8_192 })
    w.vast.addOffer({ dph_total: 0.25, reliability2: 0.8 })
    const filters = w.settings.offerFilters
    const ids = (offers: Array<{ id: number }>): number[] => offers.map((o) => o.id)
    const search = async (f: Partial<OfferFilters>): Promise<number[]> =>
      ids(await client.searchOffers(buildQuery({ ...filters, ...f })))

    // Cheapest first: buildQuery orders by dph_total.
    expect(await search({})).toEqual([cheap.id, mid.id, dear.id])
    expect(await search({ maxDphTotal: 0.5 })).toEqual([cheap.id, mid.id])
    expect(await search({ gpuNames: ['RTX 4090'] })).toEqual([mid.id])
    expect(await search({ gpuNames: ['RTX 4090', 'H100 SXM'] })).toEqual([mid.id, dear.id])
    expect(await search({ minNumGpus: 2 })).toEqual([dear.id])
    // What the app gets, through offers.ts's own ranking.
    expect(ids(await findOffers({ ...filters, maxDphTotal: 0.4 }))).toEqual([cheap.id])
    // vastClient's page size, and a limit of the query's own.
    expect(w.vast.argsOf('searchOffers')[0][0]).toMatchObject({ limit: 100 })
    expect(ids(await w.vast.searchOffers({ order: [['dph_total', 'desc']], limit: 2 }))).toEqual([
      dear.id,
      mid.id
    ])
    // An operator the fake does not know fails, rather than filtering nothing.
    await expect(w.vast.searchOffers({ gpu_ram: { like: 24 } })).rejects.toThrow(
      'unsupported search operator like'
    )
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

  it('nothing starts on a box killed, or a connection closed, while its channel was opening', async () => {
    const inst = w.vast.addInstance()
    const machine = w.vast.machine(inst.id).onExec(/^sleep/, HANG)
    const a = await connectTo(inst.id)
    const b = await connectTo(inst.id)
    await a.exec('echo ok')
    await b.exec('echo ok')

    // Closed by the app in the same turn as the exec: acquire() had already
    // handed out the live connection.
    const onClose = watch(b.exec('sleep infinity'))
    b.close()
    // Destroyed in the same turn: DELETE takes effect before either channel opens.
    const execing = watch(a.exec('sleep infinity'))
    const tailing = watch(a.execStream('touch /root/x.log && tail -n +1 -F /root/x.log', () => {}))
    void w.vast.destroyInstance(inst.id)

    await w.until(() => onClose.done && execing.done && tailing.done, 'all three fail', {
      timeoutMs: 60_000
    })
    for (const r of [onClose, execing, tailing]) {
      expect((r.error as Error).message).toBe('No response from server')
    }
    expect(machine.ran(/^sleep|tail/)).toEqual([])
  })

  it('the SFTP channel dies with its connection and with its machine', async () => {
    const { sftpReadFile } = await import('../ssh/sftp')
    const inst = w.vast.addInstance()
    const machine = w.vast.machine(inst.id)
    machine.files.set('/root/a.txt', Buffer.from('a'))

    // The app closes the connection: a request still waiting for its answer
    // fails, as ssh2 fails it. One made on the wrapper afterwards is never
    // answered: ssh2 drops it.
    const a = await connectTo(inst.id)
    const sftpA = await a.sftp()
    const closed = watch(new Promise((r) => sftpA.once('close', r)))
    const waiting = watch(sftpReadFile(sftpA, '/root/a.txt'))
    a.close()
    await w.until(() => waiting.done && closed.done, 'request fails with its connection')
    expect((waiting.error as Error).message).toBe('No response from server')
    const afterClose = watch(sftpReadFile(sftpA, '/root/a.txt'))

    // The instance is destroyed under an open connection: a wrapper obtained
    // before reads nothing more from the dead box, and no new one opens.
    const b = await connectTo(inst.id)
    const sftpB = await b.sftp()
    await expect(sftpReadFile(sftpB, '/root/a.txt')).resolves.toEqual(Buffer.from('a'))
    await w.vast.destroyInstance(inst.id)
    const afterDestroy = watch(sftpReadFile(sftpB, '/root/a.txt'))
    await expect(b.sftp()).rejects.toThrow('ECONNREFUSED')

    await w.advance(10 * 60_000)
    expect(afterClose.done).toBe(false)
    expect(afterDestroy.done).toBe(false)
  })

  it('resetSftp ends the channel: waiting requests fail, the old wrapper goes dead, the next is fresh', async () => {
    const { sftpReadFile } = await import('../ssh/sftp')
    const inst = w.vast.addInstance()
    w.vast.machine(inst.id).files.set('/root/a.txt', Buffer.from('a'))
    const conn = await connectTo(inst.id)
    const old = await conn.sftp()

    const waiting = watch(sftpReadFile(old, '/root/a.txt'))
    conn.resetSftp()
    await w.until(() => waiting.done, 'waiting request fails')
    expect((waiting.error as Error).message).toBe('No response from server')
    // ssh2 registers a request on the closed channel and never answers it.
    const late = watch(sftpReadFile(old, '/root/a.txt'))
    await w.advance(10 * 60_000)
    expect(late.done).toBe(false)

    const fresh = await conn.sftp()
    expect(fresh).not.toBe(old)
    await expect(sftpReadFile(fresh, '/root/a.txt')).resolves.toEqual(Buffer.from('a'))
  })

  it('onSftp scripts SFTP requests: an error, or a hang that ends with the connection', async () => {
    const { sftpReadFile, sftpRename } = await import('../ssh/sftp')
    const inst = w.vast.addInstance()
    const machine = w.vast.machine(inst.id)
    machine.files.set('/root/one', Buffer.from('1'))
    machine.files.set('/root/two', Buffer.from('2'))
    const conn = await connectTo(inst.id)
    const sftp = await conn.sftp()

    // An Error: the request fails with it, `times` times, then the file reads.
    machine.onSftp('readFile', Object.assign(new Error('Failure'), { code: 4 }), 1)
    await expect(sftpReadFile(sftp, '/root/one')).rejects.toThrow('Failure')
    await expect(sftpReadFile(sftp, '/root/one')).resolves.toEqual(Buffer.from('1'))

    // A function picks requests by path; HANG holds one until the channel closes.
    machine.onSftp('rename', (path) => (path === '/root/two' ? HANG : undefined))
    const held = watch(sftpRename(sftp, '/root/two', '/root/two.moved'))
    await expect(sftpRename(sftp, '/root/one', '/root/one.moved')).resolves.toBeUndefined()
    await w.advance(10 * 60_000)
    expect(held.done).toBe(false)
    expect(machine.files.has('/root/two')).toBe(true)

    conn.close()
    await w.until(() => held.done, 'held rename fails with its connection')
    expect((held.error as Error).message).toBe('No response from server')
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
    // And had the app swallowed those throws, the next dispose() still fails,
    // naming the test the work came from.
    await expect(w.dispose()).rejects.toThrow(
      '2 stale call(s) since the last dispose(); the first: harness: stale call from a ' +
        `finished test ("isolation > a finished test's leftover work fails loudly`
    )
  })

  it('dispose waits for work still doing real file I/O, however many turns it takes', async () => {
    const { getSettings } = await import('../settings')
    let rounds = 0
    const work = (async () => {
      for (let i = 0; i < 20; i++) {
        const path = join(w.dir, `scratch-${i}`)
        await writeFile(path, 'x'.repeat(64 * 1024))
        await readFile(path)
        getSettings()
        rounds++
      }
    })()

    await w.dispose()
    expect(rounds).toBe(20)
    await work
  })
})
