/**
 * The lifecycle test harness: the real nodeManager, scheduler, jobs and
 * downloader code, running against in-memory stand-ins for everything outside
 * the process — Vast.ai (fakeVast.ts), the rented machines and their agent
 * (fakeSsh.ts), the database (sqlite.ts), settings, electron — on a fake
 * clock. Rent → ready → dispatch → download → destroy can all be driven, and
 * broken, from a test, with no network and no money.
 *
 * Usage, from a test file one directory below src/main (nodes/, scheduler/...):
 *
 *   import { afterEach, beforeEach, expect, it } from 'vitest'
 *   import { setup, type World } from '../test/harness'
 *
 *   let w: World
 *   beforeEach(async () => {
 *     w = await setup({ settings: { maxActiveNodes: 1 } })
 *   })
 *   afterEach(() => w.dispose())
 *
 *   it('renders a job', async () => {
 *     const app = await w.boot()               // fresh modules, started as index.ts starts them
 *     const nodeId = await w.readyNode(app)    // rent a fake offer, drive it to 'ready'
 *     w.machineFor(nodeId).agent.autoFinish()  // the agent renders each spec as it lands
 *     const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 4, chunkSize: 4 })
 *     app.scheduler.kick()
 *     await w.until(() => w.get('SELECT state FROM jobs WHERE id = ?', jobId)?.state === 'complete', 'job complete')
 *   })
 *
 * Rules that keep a test honest:
 *
 * - Never import an app module statically, even one that looks harmless. setup()
 *   resets the module registry and registers its mocks for what is imported
 *   AFTER it, so a static import is both unmocked (it pulls in electron and
 *   better-sqlite3) and a different instance from the one the test drives.
 *   Use `w.boot()`, or `await import('../x')` after setup; `import type` is fine.
 * - Time only moves when the test moves it: `w.until(...)` (steps the fake
 *   clock until a condition holds) or `w.advance(ms)`. A step also yields to
 *   the real event loop, because downloads write real files under `w.dir`.
 * - Script failures on the fakes BEFORE the call you want to fail happens:
 *   `w.vast.fail('destroyInstance', { status: 500, message: 'boom' })`,
 *   `w.machineFor(id).onExec(/^cat .*state/, HANG)`, `w.vast.hold(...)` to
 *   stop a call mid-flight. See fakeVast.ts and fakeSsh.ts for the full menu.
 * - Every bus event lands in `w.events` in emit order; `w.eventsOf(channel)`
 *   and `w.alerts()` filter it. `w.openWindow()` adds a renderer window that
 *   records what ipc.ts forwards to it, and `w.invoke(channel, ...args)` calls
 *   an ipcMain handler the way the renderer does.
 *
 * What is mocked, and why (each is a module the money paths reach):
 *   electron            app paths → w.dir; windows, ipcMain, shell, dialog and
 *                       clipboard are recorded, never real
 *   ../db/db            getDb() → an in-memory node:sqlite DB built by db.ts's
 *                       own applySchema (better-sqlite3 is built for Electron's ABI)
 *   ../settings         w.settings / w.secrets, live: mutate them mid-test
 *   ../vast/vastClient  w.vast (the real VastError and sshEndpoints are kept)
 *   ../ssh/sshConnection  FakeSshConnection on w.network (the real HostKeyMismatchError is kept)
 *   ../ssh/keys         no keypair generation, no key registration
 *   ../media/ffmpeg     "not installed", so job-clip stitching is a no-op
 *   global fetch        throws: any unmocked network call fails loudly
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { vi } from 'vitest'
import type { EventChannel, InvokeChannel, IpcEventMap, IpcInvokeMap } from '../../shared/ipc'
import type { AlertEvent, JobSubmission, SecretKey, SettingsPublic } from '../../shared/models'
import type { Db } from '../db/db'
import type { BusEvent } from '../events'
import type { RawOffer } from '../vast/types'
import { FakeMachine, FakeNetwork, FakeSshConnection } from './fakeSsh'
import { FakeVast } from './fakeVast'
import { openTestDb } from './sqlite'

type NodeManagerModule = typeof import('../nodes/nodeManager')
type SchedulerModule = typeof import('../scheduler/scheduler')
type JobsModule = typeof import('../jobs/jobs')

/** The fake clock's starting instant (2023-11-14T22:13:20Z): fixed, so runs are repeatable. */
export const HARNESS_EPOCH = 1_700_000_000_000

/** Blender release the harness pins, so createJob never looks one up online. */
export const HARNESS_BLENDER = '4.2.3'

/** The repo root, which provisioner's localRemoteDir() finds remote/ under. */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

/**
 * Production defaults (settings.ts `defaults()`), except where a test needs
 * otherwise: a Vast key is present, the project root is the world's temp dir,
 * and the Blender version is pinned. Typed as the full SettingsPublic so a new
 * setting that is not given a default here fails the typecheck.
 */
function defaultSettings(dir: string): SettingsPublic {
  return {
    hasVastApiKey: true,
    hasOtoyCredentials: false,
    projectRoot: join(dir, 'project'),
    maxActiveNodes: 2,
    spendCapPerHour: 2,
    idleTimeoutMinutes: 5,
    proxyCodec: 'hevc',
    blenderVersionOverride: HARNESS_BLENDER,
    offerFilters: {
      gpuNames: [],
      maxDphTotal: null,
      minGpuRamGb: 10,
      minInetDownMbps: 100,
      minReliability: 0.95,
      minDiskGb: 40
    },
    sshKeyPath: '',
    concurrentTransfersPerNode: 3,
    thumbnails: true,
    livePreview: 'onDemand',
    livePreviewWidth: 960,
    maxNodeSlots: 0,
    slotsPerGpu: 1,
    eagerFleet: false,
    co2OverheadFactor: 1.6
  }
}

export interface SetupOptions {
  /** Merged over the defaults above. */
  settings?: Partial<SettingsPublic>
  /** Defaults to a Vast key only. */
  secrets?: Partial<Record<SecretKey, string>>
  /** Fake-clock start, epoch ms. */
  now?: number
}

/** The app's engine, loaded fresh for one test. */
export interface App {
  nodeManager: NodeManagerModule['nodeManager']
  scheduler: SchedulerModule['scheduler']
  jobs: JobsModule
}

export interface UntilOptions {
  /** Give up after this much fake time. Default 10 min. */
  timeoutMs?: number
  /** Fake time per step. Default 500 ms — well under every poll interval in the app. */
  stepMs?: number
}

/** A renderer window, as far as main ever touches one: `webContents.send`. */
export class FakeWindow {
  /** Everything sent to this window, in order. */
  readonly sent: Array<{ channel: string; payload: unknown }> = []
  readonly webContents = {
    send: (channel: string, payload: unknown): void => {
      this.sent.push({ channel, payload })
    }
  }
}

/** A call main made to the desktop (shell, dialog, clipboard) — recorded, never performed. */
export interface DesktopCall {
  api: 'shell' | 'dialog' | 'clipboard'
  method: string
  args: unknown[]
}

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown

/** The world the current test runs in. The mocks read it at call time. */
let current: World | null = null

function world(): World {
  if (!current) {
    throw new Error(
      'harness: no world — call setup() in beforeEach, and dispose() only in afterEach'
    )
  }
  return current
}

/** One turn of the REAL event loop: lets real file I/O (downloads) make progress. */
function realTick(): Promise<void> {
  return new Promise((r) => setImmediate(r))
}

export class World {
  /** Every event emitted on the bus, in order. */
  readonly events: BusEvent[] = []
  /** Live settings: getSettings() returns this very object, as the real one returns its cache. */
  settings: SettingsPublic
  readonly secrets: Partial<Record<SecretKey, string>>
  /** Real directory for everything local: the project root, userData, scene files. */
  readonly dir: string
  /** Open windows: what BrowserWindow.getAllWindows() returns. */
  readonly windows: FakeWindow[] = []
  /** ipcMain.handle registrations, by channel. */
  readonly ipcHandlers = new Map<string, IpcHandler>()
  /** shell / dialog / clipboard calls, in order. */
  readonly desktop: DesktopCall[] = []

  private app: App | null = null
  private disposed = false
  private unsubscribe: () => void = () => {}

  /** @internal use setup() */
  constructor(
    dir: string,
    opts: SetupOptions,
    readonly db: Db,
    readonly network: FakeNetwork,
    readonly vast: FakeVast
  ) {
    this.dir = dir
    this.settings = { ...defaultSettings(dir), ...opts.settings }
    this.secrets = { vastApiKey: 'harness-vast-key', ...opts.secrets }
    mkdirSync(this.settings.projectRoot, { recursive: true })
  }

  /** @internal */
  listen(bus: typeof import('../events')): void {
    this.unsubscribe = bus.onEvent((e) => {
      this.events.push(e)
    })
  }

  // -- the app ----------------------------------------------------------------

  /**
   * Load the engine and wire it the way index.ts's `app.whenReady` does:
   * registerIpc, the scheduler providers, then nodeManager.init,
   * scheduler.start and jobClips.catchUp — minus provisioning.
   * `nodeManager.onReady` is left null, so a node goes straight from
   * SSH-reachable to 'ready'; assign it to script provisioning.
   *
   * `start: false` loads and wires without init/start, for a test that seeds
   * the database first (restart recovery) and then calls them itself.
   * Once per world: the engine is a set of module singletons.
   */
  async boot(opts: { start?: boolean } = {}): Promise<App> {
    if (this.app) throw new Error('harness: boot() once per world')
    const { registerIpc } = await import('../ipc')
    const nm = await import('../nodes/nodeManager')
    const { scheduler } = await import('../scheduler/scheduler')
    const jobs = await import('../jobs/jobs')
    const { jobClips } = await import('../transfer/jobClip')
    // Keep in step with index.ts.
    registerIpc()
    nm.setActiveWorkProvider((nodeId) => scheduler.activeWorkForNode(nodeId))
    nm.setSlotInfoProvider((nodeId) => ({
      inUse: scheduler.slotsInUse(nodeId),
      target: scheduler.displaySlotTarget(nodeId)
    }))
    nm.setForgetNodeProvider((nodeId) => scheduler.forgetNode(nodeId))
    this.app = { nodeManager: nm.nodeManager, scheduler, jobs }
    if (opts.start !== false) {
      nm.nodeManager.init()
      scheduler.start()
      jobClips.catchUp()
    }
    return this.app
  }

  /** Open a renderer window: from now on ipc.ts forwards every event to it too. */
  openWindow(): FakeWindow {
    const win = new FakeWindow()
    this.windows.push(win)
    return win
  }

  /** Call an ipcMain handler as the renderer's `window.api.invoke` would. */
  async invoke<C extends InvokeChannel>(
    channel: C,
    ...args: IpcInvokeMap[C]['args']
  ): Promise<IpcInvokeMap[C]['result']> {
    const handler = this.ipcHandlers.get(channel)
    if (!handler) throw new Error(`harness: no ipcMain handler for ${channel} — boot() first`)
    return (await handler({}, ...args)) as IpcInvokeMap[C]['result']
  }

  /**
   * Rent one node through the real requestNodes path and wait for 'ready'.
   * Adds a fresh offer (fakeVast's defaults, overridable) so there is always
   * one to rent. Returns the node id.
   */
  async readyNode(app: App, offer: Partial<RawOffer> = {}): Promise<string> {
    this.vast.addOffer(offer)
    const [id] = await app.nodeManager.requestNodes(1)
    if (!id) throw new Error('harness: requestNodes rented nothing')
    await this.until(() => app.nodeManager.get(id)?.state === 'ready', `node ${id} ready`)
    return id
  }

  /** The fake machine behind a node, found through its instance id. */
  machineFor(nodeId: string): FakeMachine {
    const row = this.get<{ instance_id: number | null }>(
      'SELECT instance_id FROM nodes WHERE id = ?',
      nodeId
    )
    if (!row?.instance_id) throw new Error(`harness: node ${nodeId} has no instance`)
    return this.vast.machine(row.instance_id)
  }

  /** A stand-in .blend on the local disk (content is never parsed: the version is pinned). */
  blend(name = 'scene.blend'): string {
    const path = join(this.dir, 'scenes', name)
    mkdirSync(join(this.dir, 'scenes'), { recursive: true })
    writeFileSync(path, `BLENDER-v402 harness scene ${name}\n`)
    return path
  }

  /** Submit a job through the real createJob. Defaults: frames 1-4, one chunk, Cycles, exclusive. */
  submitJob(app: App, sub: Partial<JobSubmission> = {}): Promise<string> {
    return app.jobs.createJob({
      blendPath: sub.blendPath ?? this.blend(),
      engine: 'cycles',
      frameStart: 1,
      frameEnd: 4,
      frameStep: 1,
      addonIds: [],
      chunkSize: 4,
      ...sub
    })
  }

  // -- database -------------------------------------------------------------------

  /** One row, or undefined. */
  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined
  }

  /** Every row. */
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...params) as T[]
  }

  // -- events -----------------------------------------------------------------------

  /** Payloads emitted on one channel, in order. */
  eventsOf<C extends EventChannel>(channel: C): Array<IpcEventMap[C]> {
    return this.events.filter((e) => e.channel === channel).map((e) => e.payload as IpcEventMap[C])
  }

  /** Alert messages, optionally of one level. */
  alerts(level?: AlertEvent['level']): string[] {
    return this.eventsOf('alert')
      .filter((a) => !level || a.level === level)
      .map((a) => a.message)
  }

  // -- time -----------------------------------------------------------------------

  /**
   * Step the fake clock until `cond` holds, yielding to the real event loop
   * between steps. Fails with the most recent events when it times out, since
   * "what was the app doing instead" is the first question every time.
   */
  async until(
    cond: () => boolean | Promise<boolean>,
    what: string,
    opts: UntilOptions = {}
  ): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? 10 * 60_000
    const stepMs = opts.stepMs ?? 500
    const start = Date.now()
    for (;;) {
      await realTick()
      await realTick()
      if (await cond()) return
      if (Date.now() - start >= timeoutMs) {
        const recent = this.events
          .slice(-15)
          .map((e) => `  ${e.channel} ${JSON.stringify(e.payload).slice(0, 160)}`)
          .join('\n')
        throw new Error(
          `harness: still waiting for ${what} after ${timeoutMs / 1000}s of fake time; last events:\n${recent}`
        )
      }
      await vi.advanceTimersByTimeAsync(stepMs)
    }
  }

  /** Move the fake clock forward, running what falls due, in steps (see until). */
  async advance(ms: number, stepMs = 500): Promise<void> {
    const end = Date.now() + ms
    while (Date.now() < end) {
      await realTick()
      await vi.advanceTimersByTimeAsync(Math.min(stepMs, end - Date.now()))
    }
    await realTick()
  }

  // -- teardown ---------------------------------------------------------------------

  /**
   * Stop the engine, cut every fake connection and let in-flight work settle
   * while the database is still open — so nothing from this test throws into
   * the next — then close everything and put the real clock back.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.app?.scheduler.stop()
    this.app?.nodeManager.shutdown()
    vi.clearAllTimers()
    this.network.shutdown()
    for (let i = 0; i < 5; i++) await realTick()
    this.unsubscribe()
    this.db.close()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    rmSync(this.dir, { recursive: true, force: true })
    if (current === this) current = null
  }
}

// -- module mocks ---------------------------------------------------------------------
// Each delegates to world() at call time, never at import: the modules are
// imported once per setup() (after vi.resetModules), and whatever they close
// over must be the current test's fakes.

function registerMocks(): void {
  const desktop =
    (api: DesktopCall['api'], method: string, result?: unknown) =>
    (...args: unknown[]) => {
      world().desktop.push({ api, method, args })
      return result
    }
  vi.doMock('electron', () => ({
    app: {
      getPath: (name: string) => join(world().dir, 'electron', name),
      getAppPath: () => REPO_ROOT,
      isPackaged: false
    },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (s: string) => Buffer.from(s, 'utf-8'),
      decryptString: (b: Buffer) => b.toString('utf-8')
    },
    BrowserWindow: { getAllWindows: () => [...world().windows] },
    ipcMain: {
      handle: (channel: string, handler: IpcHandler) => {
        const handlers = world().ipcHandlers
        // Electron refuses a second handler for a channel; so does the harness.
        if (handlers.has(channel)) {
          throw new Error(`Attempted to register a second handler for '${channel}'`)
        }
        handlers.set(channel, handler)
      }
    },
    shell: {
      openExternal: desktop('shell', 'openExternal', Promise.resolve()),
      openPath: desktop('shell', 'openPath', Promise.resolve('')),
      showItemInFolder: desktop('shell', 'showItemInFolder')
    },
    dialog: {
      showOpenDialog: desktop(
        'dialog',
        'showOpenDialog',
        Promise.resolve({ canceled: true, filePaths: [] })
      ),
      showErrorBox: desktop('dialog', 'showErrorBox')
    },
    clipboard: { writeText: desktop('clipboard', 'writeText') }
  }))

  vi.doMock('../db/db', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../db/db')>()),
    getDb: () => world().db,
    // The world owns the database's lifetime (dispose).
    closeDb: () => {}
  }))

  vi.doMock('../settings', () => ({
    getSettings: () => world().settings,
    updateSettings: (patch: Partial<SettingsPublic>) => Object.assign(world().settings, patch),
    getSecret: (key: SecretKey) => world().secrets[key] ?? null,
    setSecret: (key: SecretKey, value: string) => {
      const w = world()
      w.secrets[key] = value
      // Derived exactly as settings.ts derives them.
      w.settings.hasVastApiKey = !!w.secrets.vastApiKey
      w.settings.hasOtoyCredentials = !!w.secrets.otoyUsername && !!w.secrets.otoyPassword
    }
  }))

  vi.doMock('../vast/vastClient', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../vast/vastClient')>()),
    searchOffers: (q: Record<string, unknown>) => world().vast.searchOffers(q),
    createInstance: (o: Parameters<FakeVast['createInstance']>[0]) =>
      world().vast.createInstance(o),
    listInstances: () => world().vast.listInstances(),
    showInstance: (id: number) => world().vast.showInstance(id),
    destroyInstance: (id: number) => world().vast.destroyInstance(id),
    listSshKeys: () => world().vast.listSshKeys(),
    registerSshKey: (k: string) => world().vast.registerSshKey(k),
    currentUser: () => world().vast.currentUser()
  }))

  vi.doMock('../ssh/sshConnection', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../ssh/sshConnection')>()),
    SshConnection: class extends FakeSshConnection {
      constructor(target: ConstructorParameters<typeof FakeSshConnection>[0]) {
        super(target, world().network)
      }
    }
  }))

  vi.doMock('../ssh/keys', () => ({
    keyDir: () => join(world().dir, 'ssh'),
    privateKeyPath: () => join(world().dir, 'ssh', 'id_ed25519'),
    publicKeyPath: () => join(world().dir, 'ssh', 'id_ed25519.pub'),
    ensureKeypair: async () => join(world().dir, 'ssh', 'id_ed25519'),
    readPrivateKey: () => Buffer.from('harness private key'),
    readPublicKey: () => 'ssh-ed25519 AAAAharness harness',
    ensureKeyRegistered: async () => {}
  }))

  vi.doMock('../media/ffmpeg', () => ({
    ffmpegPath: async () => null,
    runFfmpeg: async () => {
      throw new Error('harness: ffmpeg is not available')
    }
  }))
}

/**
 * A fresh world for one test: fresh app modules, an empty database with the
 * production schema, no offers or instances, the fake clock at HARNESS_EPOCH.
 * Pair with `afterEach(() => w.dispose())`.
 */
export async function setup(opts: SetupOptions = {}): Promise<World> {
  // A test that threw before its own dispose still gets cleaned up.
  if (current) await current.dispose()

  vi.resetModules()
  registerMocks()
  // setImmediate, nextTick and queueMicrotask stay real: the fakes answer on
  // microtasks, and until() needs real macrotask turns for real file I/O.
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']
  })
  vi.setSystemTime(opts.now ?? HARNESS_EPOCH)
  vi.stubGlobal('fetch', async (input: unknown) => {
    throw new Error(`harness: the network is off (fetch ${String(input)})`)
  })

  // The error classes come from the freshly mocked modules — the same
  // instances the app will import — so the app's `instanceof` checks hold.
  const { applySchema } = await import('../db/db')
  const { HostKeyMismatchError } = await import('../ssh/sshConnection')
  const { VastError } = await import('../vast/vastClient')
  const bus = await import('../events')

  const network = new FakeNetwork((actual, pinned) => new HostKeyMismatchError(actual, pinned))
  const vast = new FakeVast(network, (message, status) => new VastError(message, status))
  const dir = mkdtempSync(join(tmpdir(), 'vr-harness-'))
  const w = new World(dir, opts, openTestDb(applySchema), network, vast)
  w.listen(bus)
  current = w
  return w
}

export { HANG } from './fakeSsh'
export type { AgentSpec, AgentStateFile, FakeMachine } from './fakeSsh'
export type { FakeVast } from './fakeVast'
