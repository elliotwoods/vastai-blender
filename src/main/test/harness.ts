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
 *   `w.vast.fail('destroyInstance', { status: 500, message: 'boom' })` (it
 *   never reached Vast), `w.vast.loseReply('createInstance', err)` (Vast did
 *   it; the app never heard), `w.machineFor(id).onExec(/^cat .*state/, HANG)`,
 *   `w.machineFor(id).onSftp('read', HANG)`, `w.vast.hold(...)` to stop a
 *   call mid-flight. See fakeVast.ts and fakeSsh.ts for the full menu.
 * - The fakes answer as Vast and ssh2 do, not as the app hopes they will: a
 *   destroy of an instance that is already gone is a 404, a connection that
 *   closes takes its SFTP channel's transfers down with it. A test of a fix
 *   for the app's handling of either must fail without that fix.
 * - Every bus event lands in `w.events` in emit order; `w.eventsOf(channel)`
 *   and `w.alerts()` filter it. `w.openWindow()` adds a renderer window that
 *   records what ipc.ts forwards to it, and `w.invoke(channel, ...args)` calls
 *   an ipcMain handler the way the renderer does.
 *
 * What is mocked, and why (each is a module the money paths reach):
 *   electron            app paths → w.dir; windows, ipcMain, shell, dialog,
 *                       clipboard and OS notifications (w.notifications) are
 *                       recorded, never real
 *   ../db/db            getDb() → an in-memory node:sqlite DB built by db.ts's
 *                       own applySchema (better-sqlite3 is built for Electron's ABI)
 *   ../settings         w.settings / w.secrets: mutate them mid-test. getSettings()
 *                       returns a copy and updateSettings merges, as settings.ts does
 *   ../vast/vastClient  w.vast is the Vast server, behind a copy of what
 *                       vastClient.ts does around each request: with no API key
 *                       every call rejects with VastError and never reaches
 *                       w.vast, showInstance maps a 404 to null, registerSshKey
 *                       takes "duplicate" as done. Not its 429 retry: see
 *                       fakeVast.ts. (The real VastError and sshEndpoints are kept.)
 *   ../ssh/sshConnection  FakeSshConnection on w.network (the real HostKeyMismatchError is kept)
 *   ../ssh/keys         no keypair generation, no key registration
 *   ../media/ffmpeg     "not installed", so job-clip stitching is a no-op
 *   global fetch        throws: any unmocked network call fails loudly
 *
 * The mocks belong to the test that set them up. dispose() closes every fake
 * connection and then waits for what that sets off (failing transfers, the
 * app's handling of them) to go quiet, so a test may end in the middle of
 * anything. Work that still outlives it throws "stale call from a finished
 * test", naming the test, rather than reaching the next test's database and
 * fakes, and the next dispose() fails with it in case the app swallowed it.
 */

import type { NotificationConstructorOptions } from 'electron'
import { EventEmitter } from 'events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { expect, vi } from 'vitest'
import type { EventChannel, InvokeChannel, IpcEventMap, IpcInvokeMap } from '../../shared/ipc'
import type {
  AlertEvent,
  JobSubmission,
  OfferFilters,
  SecretKey,
  SettingsPublic
} from '../../shared/models'
import type { Db } from '../db/db'
import type { BusEvent } from '../events'
import type { RawOffer } from '../vast/types'
import type { CreateInstanceOptions } from '../vast/vastClient'
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

/** What getSettings() hands out: a copy, down to offerFilters, as settings.ts's is. */
function copySettings(s: SettingsPublic): SettingsPublic {
  return { ...s, offerFilters: { ...s.offerFilters } }
}

export interface SetupOptions {
  /**
   * Merged over production's defaults, read from the real settings.ts, less
   * two things a test needs: the project root is under the world's temp dir
   * and the Blender version is pinned. offerFilters merges too, so
   * `{ offerFilters: { maxDphTotal: 1 } }` keeps the other filters.
   * hasVastApiKey / hasOtoyCredentials follow `secrets`, as in settings.ts.
   */
  settings?: Partial<Omit<SettingsPublic, 'offerFilters'>> & {
    offerFilters?: Partial<OfferFilters>
  }
  /**
   * Defaults to a Vast key only. `{ vastApiKey: undefined }` for none: every
   * vastClient call then rejects, as it does in production.
   */
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

/**
 * A renderer window, as far as main touches one outside index.ts:
 * `webContents.send`, and whether the user is looking at it.
 */
export class FakeWindow {
  /** Everything sent to this window, in order. */
  readonly sent: Array<{ channel: string; payload: unknown }> = []
  readonly webContents = {
    send: (channel: string, payload: unknown): void => {
      this.sent.push({ channel, payload })
    }
  }
  /** What BrowserWindow.getFocusedWindow() goes by. Set it to put the user in front of the app. */
  focused = false
  minimized = false
  visible = true

  isFocused(): boolean {
    return this.focused
  }

  focus(): void {
    this.focused = true
  }

  isMinimized(): boolean {
    return this.minimized
  }

  restore(): void {
    this.minimized = false
  }

  show(): void {
    this.visible = true
  }

  isDestroyed(): boolean {
    return false
  }
}

/**
 * An OS notification main raised (electron's `Notification`): recorded in
 * `w.notifications` as constructed, never shown on the desktop. `emit('click')`
 * on one is the user clicking it.
 */
export class FakeNotification extends EventEmitter {
  shown = false
  closed = false

  constructor(readonly options: NotificationConstructorOptions = {}) {
    super()
  }

  show(): void {
    this.shown = true
    this.emit('show')
  }

  close(): void {
    this.closed = true
    this.emit('close')
  }
}

/** A call main made to the desktop (shell, dialog, clipboard) — recorded, never performed. */
export interface DesktopCall {
  api: 'shell' | 'dialog' | 'clipboard'
  method: string
  args: unknown[]
}

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown

/** The world of the test running now, so setup() can clean up after one that threw. */
let current: World | null = null

/**
 * Stale calls not yet reported: the next dispose() fails with them, since the
 * app may have swallowed the throw (a `.catch(() => {})` around the call).
 */
const strays: string[] = []

/** How long dispose() waits for a finished test's work to go quiet (real ms). */
const SETTLE_BUDGET_MS = 2_000

/** Turns of the real event loop in a row with nothing happening that count as quiet. */
const QUIET_TURNS = 5

/**
 * What one setup()'s mocks find their world through. The mocks outlive their
 * test — an app module keeps the mock instances it imported — so each set
 * closes over its own scope, never over "whichever test is running now".
 * Leftover work from a finished test then fails loudly instead of quietly
 * writing into the next test's database and fakes.
 */
class Scope {
  world: World | null = null
  /** Set by dispose() once in-flight work has had its chance to settle. */
  ended = false
  /** Calls made into this scope's mocks so far: dispose() waits for it to stop moving. */
  calls = 0
  /** The test this scope belongs to, for the stale-call message. */
  readonly test = expect.getState().currentTestName ?? '(outside a test)'

  constructor(readonly dir: string) {}

  /** For a mock being called now: throws if its test is over. */
  check(): void {
    this.calls++
    if (this.ended) {
      const message =
        `harness: stale call from a finished test (${JSON.stringify(this.test)}) — work it ` +
        'started outlived its dispose(); await it (or stop it) inside the test'
      strays.push(message)
      throw new Error(message)
    }
  }

  get(): World {
    this.check()
    if (!this.world) throw new Error('harness: a mock was called before setup() built the world')
    return this.world
  }
}

/** One turn of the REAL event loop: lets real file I/O (downloads) make progress. */
function realTick(): Promise<void> {
  return new Promise((r) => setImmediate(r))
}

/** Is real file I/O (a download's writes, a sha256 of a .part) still in flight in this process? */
function fileIoPending(): boolean {
  return process.getActiveResourcesInfo().some((r) => r.startsWith('FSReq') || r === 'CloseReq')
}

export class World {
  /** Every event emitted on the bus, in order. */
  readonly events: BusEvent[] = []
  /**
   * The settings the app reads: the real settings.ts's cache, in effect. Edit
   * it mid-test and the next getSettings() sees the change; one the app
   * already holds does not, since getSettings() returns a copy.
   */
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
  /** OS notifications main constructed, in order (shown or not: see FakeNotification). */
  readonly notifications: FakeNotification[] = []
  /** What Notification.isSupported() answers. */
  notificationsSupported = true

  private app: App | null = null
  private disposed = false
  private unsubscribe: () => void = () => {}

  /** @internal use setup() */
  constructor(
    private readonly scope: Scope,
    opts: SetupOptions,
    /** getSettings() of the real settings.ts with nothing saved: production's defaults */
    defaults: SettingsPublic,
    readonly db: Db,
    readonly network: FakeNetwork,
    readonly vast: FakeVast
  ) {
    this.dir = scope.dir
    const base: SettingsPublic = {
      ...defaults,
      projectRoot: join(this.dir, 'project'),
      blenderVersionOverride: HARNESS_BLENDER
    }
    this.settings = {
      ...base,
      ...opts.settings,
      offerFilters: { ...base.offerFilters, ...opts.settings?.offerFilters }
    }
    this.secrets = { vastApiKey: 'harness-vast-key', ...opts.secrets }
    deriveFlags(this)
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
   *
   * Fails if work from an earlier test called a mock after its own dispose()
   * (see Scope): the test that leaked is named in the message.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.app?.scheduler.stop()
    this.app?.nodeManager.shutdown()
    vi.clearAllTimers()
    this.network.shutdown()
    await this.settle()
    // From here on, anything this test's modules still call throws.
    this.scope.ended = true
    this.unsubscribe()
    this.db.close()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    rmSync(this.dir, { recursive: true, force: true })
    if (current === this) current = null
    const leaked = strays.splice(0)
    if (leaked.length > 0) {
      throw new Error(
        `${leaked.length} stale call(s) since the last dispose(); the first: ${leaked[0]}`
      )
    }
  }

  /**
   * Turn the real event loop until nothing has touched the harness (a mock,
   * a fake connection, the bus) and no real file I/O is in flight, for
   * QUIET_TURNS turns in a row. Closing the connections fails every transfer
   * on them, and each failure runs the app's handling — truncating a .part,
   * an alert, the settings, the next queued transfer — over as many turns as
   * its file I/O takes. A fixed few turns was not enough: a test that ended
   * mid-download left downloads failing into the next test. The fake clock
   * stands still meanwhile, so work waiting on a timer stays parked for good.
   */
  private async settle(): Promise<void> {
    const activity = (): number => this.scope.calls + this.network.activity + this.events.length
    const deadline = performance.now() + SETTLE_BUDGET_MS
    let last = activity()
    let quiet = 0
    while (quiet < QUIET_TURNS && performance.now() < deadline) {
      await realTick()
      const now = activity()
      quiet = now === last && !fileIoPending() ? quiet + 1 : 0
      last = now
    }
  }
}

/** The has* flags, derived from the secrets exactly as settings.ts derives them. */
function deriveFlags(w: World): void {
  w.settings.hasVastApiKey = !!w.secrets.vastApiKey
  w.settings.hasOtoyCredentials = !!w.secrets.otoyUsername && !!w.secrets.otoyPassword
}

// -- module mocks ---------------------------------------------------------------------
// Each resolves its world through `scope` at call time, never at import: the
// modules are imported once per setup() (after vi.resetModules), and whatever
// they close over must be that test's fakes — and only while it runs.

function registerMocks(scope: Scope): void {
  const world = (): World => scope.get()
  const desktop =
    (api: DesktopCall['api'], method: string, result?: unknown) =>
    (...args: unknown[]) => {
      world().desktop.push({ api, method, args })
      return result
    }
  vi.doMock('electron', () => ({
    app: {
      // Straight from the scope: setup() reads the real settings.ts's
      // defaults, which need a documents path, before the world exists.
      getPath: (name: string) => {
        scope.check()
        return join(scope.dir, 'electron', name)
      },
      getAppPath: () => REPO_ROOT,
      isPackaged: false
    },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (s: string) => Buffer.from(s, 'utf-8'),
      decryptString: (b: Buffer) => b.toString('utf-8')
    },
    BrowserWindow: {
      getAllWindows: () => [...world().windows],
      getFocusedWindow: () => world().windows.find((win) => win.isFocused()) ?? null
    },
    Notification: class extends FakeNotification {
      static isSupported(): boolean {
        return world().notificationsSupported
      }

      constructor(options?: NotificationConstructorOptions) {
        super(options)
        world().notifications.push(this)
      }
    },
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

  vi.doMock('../settings', async () => {
    // As settings.ts: a headless spec's session overlay is laid over what is
    // saved (plan 1.14), and never saved with it.
    const { sessionOverlay } = await import('../app/settingsOverlay')
    return {
      getSettings: () => sessionOverlay.apply(copySettings(world().settings)),
      // As settings.ts: the derived has* flags are stripped from the patch, and
      // a partial offerFilters merges over the current filters.
      updateSettings: (patch: Partial<SettingsPublic>) => {
        const s = world().settings
        const rest = { ...patch }
        delete rest.hasVastApiKey
        delete rest.hasOtoyCredentials
        delete rest.offerFilters
        Object.assign(s, rest)
        if (patch.offerFilters) Object.assign(s.offerFilters, patch.offerFilters)
        return sessionOverlay.apply(copySettings(s))
      },
      getSecret: (key: SecretKey) => world().secrets[key] ?? null,
      setSecret: (key: SecretKey, value: string) => {
        const w = world()
        w.secrets[key] = value
        deriveFlags(w)
      }
    }
  })

  vi.doMock('../vast/vastClient', async (importOriginal) => {
    const real = await importOriginal<typeof import('../vast/vastClient')>()
    const { VastError } = real
    // What vastClient.ts does around each request, with w.vast as the server
    // (fakeVast.ts): the API key comes first, and without one the call
    // rejects and nothing reaches Vast. request()'s 429 retry is not redone.
    const request =
      <A extends unknown[], R>(send: (vast: FakeVast, ...args: A) => Promise<R>) =>
      (...args: A): Promise<R> => {
        // Outside the promise: a finished test's leftover work throws at
        // once, not as a rejection the app might swallow.
        const w = world()
        if (!w.secrets.vastApiKey) {
          return Promise.reject(new VastError('No Vast.ai API key configured'))
        }
        return send(w.vast, ...args)
      }
    return {
      ...real,
      // vastClient sends its own page size ahead of the query.
      searchOffers: request((vast, q: Record<string, unknown>) =>
        vast.searchOffers({ limit: 100, ...q })
      ),
      createInstance: request((vast, o: CreateInstanceOptions) => vast.createInstance(o)),
      listInstances: request((vast) => vast.listInstances()),
      showInstance: request((vast, id: number) =>
        vast.showInstance(id).catch((e: unknown) => {
          // Gone (or never was): null, as vastClient.ts answers a 404.
          if (e instanceof VastError && e.status === 404) return null
          throw e
        })
      ),
      destroyInstance: request((vast, id: number) => vast.destroyInstance(id)),
      listSshKeys: request((vast) => vast.listSshKeys()),
      registerSshKey: request((vast, key: string) =>
        vast.registerSshKey(key).catch((e: unknown) => {
          // Already registered: what vastClient.ts wants anyway.
          if (e instanceof VastError && e.message.includes('duplicate')) return
          throw e
        })
      ),
      currentUser: request((vast) => vast.currentUser())
    }
  })

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
  const scope = new Scope(mkdtempSync(join(tmpdir(), 'vr-harness-')))
  registerMocks(scope)
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
  // Production's defaults, from the real settings.ts rather than a copy that
  // could drift. It runs on the mocked electron, so it looks for a saved file
  // under the world's empty temp dir — never the user's real settings.
  const real = await vi.importActual<typeof import('../settings')>('../settings')

  const network = new FakeNetwork((actual, pinned) => new HostKeyMismatchError(actual, pinned))
  const vast = new FakeVast(network, (message, status) => new VastError(message, status))
  const w = new World(scope, opts, real.getSettings(), openTestDb(applySchema), network, vast)
  scope.world = w
  w.listen(bus)
  current = w
  return w
}

export { HANG } from './fakeSsh'
export type {
  AgentSpec,
  AgentStateFile,
  FakeMachine,
  SftpHandler,
  SftpMethod,
  SftpReply
} from './fakeSsh'
export type { FakeVast } from './fakeVast'
