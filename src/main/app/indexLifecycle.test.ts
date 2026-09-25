import { EventEmitter } from 'events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NodeSnapshot, SettingsPublic } from '../../shared/models'

// index.ts wires app/lifecycle.ts (plan 1.1): the real before-quit,
// powerMonitor, session-end and signal handling, against a recorded electron
// and a stubbed engine. lifecycle.quit.test.ts drives the same handlers
// against the real nodeManager and scheduler; this file is what fails if
// index.ts stops installing them, or installs them wrong.

/** The window createWindow makes: its listeners are real, so a test can emit on it. */
class FakeWindow extends EventEmitter {
  static all: FakeWindow[] = []
  /** app.on listeners, for 'browser-window-created'. */
  static app: Map<string, Array<(...args: unknown[]) => void>> = new Map()
  shown = 0
  hidden = 0
  minimized = 0
  focused = 0
  restored = 0

  constructor() {
    super()
    FakeWindow.all.push(this)
    for (const fn of FakeWindow.app.get('browser-window-created') ?? []) fn({}, this)
  }

  static getAllWindows(): FakeWindow[] {
    return [...FakeWindow.all]
  }

  static getFocusedWindow(): FakeWindow | null {
    return null
  }

  isMinimized(): boolean {
    return false
  }

  restore(): void {
    this.restored++
  }

  show(): void {
    this.shown++
  }

  hide(): void {
    this.hidden++
  }

  minimize(): void {
    this.minimized++
  }

  focus(): void {
    this.focused++
  }

  loadURL = (): void => {}
  loadFile = (): void => {}

  readonly webContents = {
    on: (): void => {},
    once: (): void => {},
    setWindowOpenHandler: (): void => {}
  }
}

interface Loaded {
  /** app.on listeners, by event. */
  listeners: Map<string, Array<(...args: unknown[]) => void>>
  exits: number[]
  /** dialog.showMessageBox calls: [parent, options] or [options]. */
  boxes: unknown[][]
  /** Answer the next box with this button index. */
  answer: (response: number) => void
  power: EventEmitter
  notifications: string[]
  /** process.on registrations, by signal. */
  signals: Map<string, () => void>
  destroyed: string[]
  /** What index.ts wrote to stderr (fd 2). */
  stderr: string
  /** 'stdout error', 'stderr error': listeners index.ts put on the streams (recorded, not installed). */
  stdio: string[]
  closedDb: number
  schedulerStopped: number
  shutdowns: number
  nodes: NodeSnapshot[]
  /** protocol.handle registrations, by scheme. */
  protocols: Map<string, (request: Request) => Promise<Response>>
  /** nodeManager.accrueElapsed calls, by the ms each was given. */
  accrued: number[]
  /** nodeManager.reconcile calls. */
  reconciles: number
  /** scheduler.resumeRecoveryFor calls, by the jobs each named. */
  resumedFor: string[][]
  /** scheduler.resumeJob calls. */
  resumedJobs: Array<{ jobId: string; octaneSignIn?: boolean }>
}

function node(patch: Partial<NodeSnapshot> = {}): NodeSnapshot {
  return {
    id: 'node-1-abcdef',
    instanceId: 777,
    state: 'rendering',
    gpuName: 'RTX 4090',
    numGpus: 1,
    dphTotal: 0.4,
    sshHost: null,
    sshPort: null,
    startedAt: null,
    accumulatedCost: 0,
    energyWh: 0,
    co2g: 0,
    geolocation: null,
    currentWork: [],
    slotsInUse: 0,
    slotTarget: 1,
    eeveeCapable: null,
    octaneReady: false,
    octaneNeedsManualLogin: false,
    blenderVersions: [],
    lastError: null,
    metrics: null,
    ...patch
  }
}

/**
 * Load index.ts as a launch with `env`, run its whenReady, with `nodes` in
 * the fleet. `createJob` stands in for jobs.createJob (the drivers' submit).
 * `userData` runs the real settings.ts against a profile in that folder
 * instead of a stub, and with `layOverlay` its getSettings() lays the
 * session overlay over what it saved, as plan 1.14 has settings.ts do (a
 * no-op once it does). `settings` is a stub settings.ts that hands out
 * those and never lays the overlay: a build whose settings.ts does not.
 */
async function load(
  nodes: NodeSnapshot[],
  env: Record<string, string> = {},
  opts: {
    createJob?: () => Promise<string>
    userData?: string
    layOverlay?: boolean
    settings?: SettingsPublic
    /** jobs.output_dir by job id, for the media:// handler's lookup. */
    jobDirs?: Record<string, string>
    /** What jobs.listJobs hands the drivers: jobs an earlier run left. */
    jobs?: Array<{ id: string; blendPath: string; state: string }>
  } = {}
): Promise<Loaded> {
  for (const k of ['VR_JOB_SPEC', 'VR_E2E_BLEND', 'VR_SHOT', 'VR_USERDATA', 'VR_QUIT_POLICY']) {
    vi.stubEnv(k, env[k] ?? '')
  }
  const answers: Array<(r: { response: number }) => void> = []
  const pending: number[] = []
  const out: Loaded = {
    listeners: new Map(),
    exits: [],
    boxes: [],
    answer: (response) => {
      const next = answers.shift()
      if (next) next({ response })
      else pending.push(response)
    },
    power: new EventEmitter(),
    notifications: [],
    signals: new Map(),
    destroyed: [],
    stderr: '',
    stdio: [],
    closedDb: 0,
    schedulerStopped: 0,
    shutdowns: 0,
    nodes,
    protocols: new Map(),
    accrued: [],
    reconciles: 0,
    resumedFor: [],
    resumedJobs: []
  }
  FakeWindow.app = out.listeners
  let ready!: () => void
  const whenReady = new Promise<void>((r) => (ready = r))
  vi.doMock('electron', () => ({
    app: {
      setPath: () => {},
      getPath: (name: string) =>
        opts.userData
          ? name === 'userData'
            ? opts.userData
            : join(opts.userData, name)
          : '/profiles/test',
      getAppPath: () => '/app',
      isPackaged: false,
      requestSingleInstanceLock: () => true,
      on: (event: string, fn: (...args: unknown[]) => void) => {
        out.listeners.set(event, [...(out.listeners.get(event) ?? []), fn])
      },
      quit: () => {},
      exit: (code = 0) => {
        out.exits.push(code)
      },
      focus: () => {},
      whenReady: () => whenReady
    },
    BrowserWindow: FakeWindow,
    protocol: {
      registerSchemesAsPrivileged: () => {},
      handle: (scheme: string, fn: (request: Request) => Promise<Response>) => {
        out.protocols.set(scheme, fn)
      }
    },
    shell: { openExternal: async () => {} },
    dialog: {
      showMessageBox: (...args: unknown[]) => {
        out.boxes.push(args)
        const early = pending.shift()
        if (early !== undefined) return Promise.resolve({ response: early })
        return new Promise((r) => answers.push(r))
      }
    },
    powerMonitor: out.power,
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (v: string) => Buffer.from(v, 'utf-8'),
      decryptString: (b: Buffer) => b.toString('utf-8')
    },
    Notification: class {
      static isSupported(): boolean {
        return true
      }

      constructor(readonly options: { body: string }) {}

      show(): void {
        out.notifications.push(this.options.body)
      }
    }
  }))
  vi.doMock('fs', async (importOriginal) => ({
    ...(await importOriginal<typeof import('fs')>()),
    writeSync: (fd: number, text: string) => {
      if (fd === 2) out.stderr += text
      return text.length
    }
  }))
  vi.doMock('@electron-toolkit/utils', () => ({
    electronApp: { setAppUserModelId: () => {} },
    optimizer: { watchWindowShortcuts: () => {} },
    is: { dev: false }
  }))
  vi.doMock('../../../resources/icon.png?asset', () => ({ default: 'icon.png' }))
  vi.doMock('../ipc', () => ({ registerIpc: () => {} }))
  vi.doMock('../nodes/nodeManager', () => ({
    nodeManager: {
      onReady: null,
      init: () => {},
      list: () => out.nodes,
      get: (id: string) => {
        const snapshot = out.nodes.find((n) => n.id === id)
        return snapshot && { snapshot }
      },
      destroyNode: async (id: string) => {
        out.destroyed.push(id)
        out.nodes = out.nodes.map((n) =>
          n.id === id ? { ...n, state: 'destroyed', destroyedAt: Date.now() } : n
        )
      },
      shutdown: () => {
        out.shutdowns++
      },
      accrueElapsed: (ms: number) => {
        out.accrued.push(ms)
      },
      reconcile: async () => {
        out.reconciles++
      }
    },
    setActiveWorkProvider: () => {},
    setForgetNodeProvider: () => {},
    setSlotInfoProvider: () => {}
  }))
  vi.doMock('../nodes/provisioner', () => ({}))
  vi.doMock('../blender/blendInfo', () => ({}))
  vi.doMock('../scheduler/scheduler', () => ({
    scheduler: {
      start: () => {},
      stop: () => {
        out.schedulerStopped++
      },
      kick: () => {},
      resumeRecoveryFor: (jobIds: readonly string[]) => {
        out.resumedFor.push([...jobIds])
      },
      resumeJob: (jobId: string, o: { octaneSignIn?: boolean } = {}) => {
        out.resumedJobs.push({ jobId, ...o })
        return false
      }
    }
  }))
  vi.doMock('../transfer/jobClip', () => ({ jobClips: { catchUp: () => {} } }))
  // A mock outlives resetModules, so an earlier load's stub is undone here.
  const fixed = opts.settings
  if (fixed) {
    vi.doMock('../settings', () => ({
      getSettings: () => structuredClone(fixed),
      updateSettings: () => {
        throw new Error('settings.json written')
      }
    }))
  } else if (opts.userData && opts.layOverlay) {
    vi.doMock('../settings', async (importOriginal) => {
      const real = await importOriginal<typeof import('../settings')>()
      const { sessionOverlay } = await import('./settingsOverlay')
      return { ...real, getSettings: () => sessionOverlay.apply(real.getSettings()) }
    })
  } else if (opts.userData) vi.doUnmock('../settings')
  else vi.doMock('../settings', () => ({ getSettings: () => ({}), updateSettings: () => {} }))
  vi.doMock('../db/db', () => ({
    closeDb: () => {
      out.closedDb++
    },
    getDb: () => ({
      prepare: (sql: string) => ({
        get: (id?: string) =>
          // The media:// handler's job lookup.
          sql.includes('output_dir')
            ? opts.jobDirs?.[id ?? ''] != null
              ? { output_dir: opts.jobDirs[id ?? ''] }
              : undefined
            : // openJobs' count: no job queued or running.
              { n: 0 }
      })
    })
  }))
  vi.doMock('../jobs/jobs', () => ({
    listJobs: () => opts.jobs ?? [],
    createJob: opts.createJob ?? (async () => 'job-1'),
    emitChunksChanged: () => {},
    refreshJobState: () => {},
    setJobRateProvider: () => {}
  }))
  vi.spyOn(process, 'on').mockImplementation(((event: string, fn: () => void) => {
    out.signals.set(event, fn)
    return process
  }) as typeof process.on)
  // Recorded rather than added to the test runner's own streams, unless the
  // test has its own stand-in there already.
  for (const [name, stream] of [
    ['stdout', process.stdout],
    ['stderr', process.stderr]
  ] as const) {
    if (vi.isMockFunction(stream.on)) continue
    vi.spyOn(stream, 'on').mockImplementation(((event: string) => {
      out.stdio.push(`${name} ${event}`)
      return stream
    }) as typeof stream.on)
  }

  await import('../index')
  ready()
  await vi.advanceTimersByTimeAsync(0)
  return out
}

/** Windows asks a window whether the session may end: whether it was held. */
function querySessionEnd(win: FakeWindow): boolean {
  let held = false
  win.emit('query-session-end', { reasons: ['shutdown'], preventDefault: () => (held = true) })
  return held
}

/** The window's close button: whether the window went (no listener held it). */
function closeWindow(win: FakeWindow): boolean {
  let held = false
  win.emit('close', { preventDefault: () => (held = true) })
  return !held
}

/** Run `fn` as on Windows: process.platform is 'win32' meanwhile. */
async function onWindows(fn: () => Promise<void>): Promise<void> {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  try {
    await fn()
  } finally {
    Object.defineProperty(process, 'platform', platform)
  }
}

/** Cmd+Q: every before-quit listener, and whether one held the quit. */
function quit(r: Loaded): boolean {
  let prevented = false
  for (const fn of r.listeners.get('before-quit') ?? []) {
    fn({ preventDefault: () => (prevented = true) })
  }
  return prevented
}

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  FakeWindow.all = []
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('index.ts installs the quit lifecycle (plan 1.1, field incident A1)', () => {
  it('a quit with a node billing is held for the dialog, shown against the window', async () => {
    const r = await load([node()])
    expect(quit(r)).toBe(true)
    await vi.advanceTimersByTimeAsync(0)

    expect(r.boxes).toHaveLength(1)
    const [parent, options] = r.boxes[0] as [FakeWindow, Record<string, unknown>]
    expect(parent).toBe(FakeWindow.all[0])
    expect(options).toMatchObject({
      type: 'warning',
      message: '1 node is billing $0.40/hr',
      buttons: ['Destroy all && quit', 'Leave running', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
      normalizeAccessKeys: true
    })
    expect(r.exits).toEqual([])
  })

  it('"Leave running": the scheduler stops, connections and the database close, then app.exit(0)', async () => {
    const r = await load([node()])
    quit(r)
    r.answer(1)
    await vi.advanceTimersByTimeAsync(0)

    expect(r.exits).toEqual([0])
    expect(r.destroyed).toEqual([])
    expect(r.schedulerStopped).toBe(1)
    expect(r.shutdowns).toBe(1)
    expect(r.closedDb).toBe(1)
  })

  it('"Destroy all & quit": nodeManager.destroyNode for each node, 3 s apart, then app.exit(0)', async () => {
    const r = await load([node(), node({ id: 'node-2-abcdef', instanceId: 778 })])
    quit(r)
    r.answer(0)
    await vi.advanceTimersByTimeAsync(0)
    // Vast takes one DELETE every 3 s.
    expect(r.destroyed).toHaveLength(1)
    expect(r.exits).toEqual([])
    await vi.advanceTimersByTimeAsync(3_000)

    expect(r.destroyed.sort()).toEqual(['node-1-abcdef', 'node-2-abcdef'])
    expect(r.exits).toEqual([0])
  })

  it('nothing billing: exits at once, with no dialog', async () => {
    const r = await load([node({ state: 'destroyed', destroyedAt: 1 })])
    expect(quit(r)).toBe(true)
    expect(r.exits).toEqual([0])
    expect(r.boxes).toEqual([])
  })

  it('going to sleep with a node billing: an OS notification', async () => {
    const r = await load([node()])
    r.power.emit('suspend')
    expect(r.notifications).toEqual([
      'Going to sleep with 1 node billing $0.40/hr: it keeps billing while this computer ' +
        'sleeps, and nothing downloads until it wakes. After 30 minutes without the app, ' +
        'a node with nothing left to render destroys itself'
    ])
  })

  it('1.1: waking meters the time asleep and reconciles the account at once', async () => {
    // Neither was wired: a night asleep with the fleet billing was metered
    // as the one minute the first tick after waking charges (#66), and the
    // account was next checked at the 5-minute reconcile.
    const r = await load([node()])
    r.power.emit('suspend')
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000)
    r.power.emit('resume')
    expect(r.accrued).toHaveLength(1)
    expect(r.accrued[0]).toBeGreaterThanOrEqual(3 * 60 * 60_000)
    expect(r.reconciles).toBe(1)
  })

  it("a person's app: Ctrl+C or a closed terminal asks, as Cmd+Q does, once however many arrive", async () => {
    // Not left to Electron's handler, which has one shot: the second SIGHUP
    // of a closed terminal killed the app with the dialog up (1.1 review).
    const r = await load([node()])
    expect([...r.signals.keys()]).toEqual(expect.arrayContaining(['SIGINT', 'SIGTERM', 'SIGHUP']))

    r.signals.get('SIGHUP')!()
    r.signals.get('SIGHUP')!()
    await vi.advanceTimersByTimeAsync(0)
    expect(r.boxes).toHaveLength(1)
    expect(r.exits).toEqual([])

    r.answer(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(r.destroyed).toEqual(['node-1-abcdef'])
    expect(r.exits).toEqual([0])
  })

  it('Windows asks whether it may shut down: held while the fleet is destroyed, then the app exits', async () => {
    const r = await load([node()])
    const [win] = FakeWindow.all

    expect(querySessionEnd(win)).toBe(true)
    await vi.advanceTimersByTimeAsync(0)

    expect(r.boxes).toEqual([])
    expect(r.destroyed).toEqual(['node-1-abcdef'])
    expect(r.exits).toEqual([0])
  })

  it("on Windows, a person's window closes as it always did with nothing billing", async () => {
    await onWindows(async () => {
      await load([node({ state: 'destroyed', destroyedAt: 1 })])
      expect(closeWindow(FakeWindow.all[0])).toBe(true)
    })
  })

  it('on Windows, closing the window with a node billing: it stays for the dialog, and a shutdown still reaches it', async () => {
    // 1.1 review: the window was gone by the time the dialog came up, and
    // with it the only thing Windows asks before a shutdown. A dialog left
    // unanswered overnight, then an update's restart, ended the app with
    // the fleet billing.
    await onWindows(async () => {
      const r = await load([node()])
      const [win] = FakeWindow.all

      expect(closeWindow(win)).toBe(false)
      await vi.advanceTimersByTimeAsync(0)
      expect(r.boxes).toHaveLength(1)
      expect(r.boxes[0][0]).toBe(win)
      expect(r.exits).toEqual([])

      expect(querySessionEnd(win)).toBe(true)
      await vi.advanceTimersByTimeAsync(0)
      expect(r.destroyed).toEqual(['node-1-abcdef'])
      expect(r.exits).toEqual([0])
    })
  })

  it('on Windows, Cancel keeps the window and the app; the next close asks again', async () => {
    await onWindows(async () => {
      const r = await load([node()])
      const [win] = FakeWindow.all

      expect(closeWindow(win)).toBe(false)
      r.answer(2)
      await vi.advanceTimersByTimeAsync(0)
      expect(r.exits).toEqual([])
      expect(FakeWindow.all).toHaveLength(1)

      expect(closeWindow(win)).toBe(false)
      r.answer(1)
      await vi.advanceTimersByTimeAsync(0)
      expect(r.boxes).toHaveLength(2)
      expect(r.exits).toEqual([0])
    })
  })
})

describe('index.ts, headless (plan 1.1)', () => {
  it('SIGTERM destroys the fleet and exits 0, with no dialog', async () => {
    const r = await load([node()], { VR_E2E_BLEND: '/scenes/e2e.blend' })
    expect([...r.signals.keys()]).toEqual(expect.arrayContaining(['SIGINT', 'SIGTERM', 'SIGHUP']))

    r.signals.get('SIGTERM')!()
    await vi.advanceTimersByTimeAsync(0)

    expect(r.boxes).toEqual([])
    expect(r.destroyed).toEqual(['node-1-abcdef'])
    expect(r.exits).toEqual([0])
  })

  it('VR_QUIT_POLICY=leave: SIGTERM exits 3 and destroys nothing', async () => {
    const r = await load([node()], { VR_JOB_SPEC: '/campaign/spec.json', VR_QUIT_POLICY: 'leave' })
    r.signals.get('SIGTERM')!()
    expect(r.destroyed).toEqual([])
    expect(r.exits).toEqual([3])
    expect(r.stderr).toContain('SIGTERM: leaving 1 node billing $0.40/hr')
  })

  it('on Windows, closing the window minimizes it, so a shutdown still asks and is held for the destroy', async () => {
    // Minimized, not hidden (1.1 review): Windows may end a process with no
    // visible window at shutdown rather than wait on it.
    await onWindows(async () => {
      const r = await load([node()], { VR_JOB_SPEC: '/campaign/spec.json' })
      const [win] = FakeWindow.all

      expect(closeWindow(win)).toBe(false)
      expect(win.minimized).toBe(1)
      expect(win.hidden).toBe(0)
      expect(querySessionEnd(win)).toBe(true)
      await vi.advanceTimersByTimeAsync(0)

      expect(r.destroyed).toEqual(['node-1-abcdef'])
      expect(r.exits).toEqual([0])
    })
  })

  it('a closed terminal (EPIPE on stdout or stderr) is not an uncaught exception mid-destroy', async () => {
    const listening: string[] = []
    for (const [name, stream] of [
      ['stdout', process.stdout],
      ['stderr', process.stderr]
    ] as const) {
      vi.spyOn(stream, 'on').mockImplementation(((event: string, fn: (e: Error) => void) => {
        listening.push(`${name} ${event}`)
        // Nowhere to say it: the listener must not throw either.
        if (event === 'error') fn(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
        return stream
      }) as typeof stream.on)
    }
    const r = await load([node()], { VR_E2E_BLEND: '/scenes/e2e.blend' })

    expect(listening).toEqual(expect.arrayContaining(['stdout error', 'stderr error']))
    expect(r.signals.has('SIGHUP')).toBe(true)
  })

  it('a campaign that could not be submitted ends with exit 1, not 0 (1.1 review)', async () => {
    const r = await load(
      [],
      { VR_E2E_BLEND: '/scenes/e2e.blend' },
      {
        createJob: async () => {
          throw new Error('scene file not found')
        }
      }
    )
    await vi.advanceTimersByTimeAsync(3_000 + 61_000)

    expect(r.exits).toEqual([1])
    expect(r.stderr).toContain('not all of it was submitted')
    expect(r.stderr).toContain('/scenes/e2e.blend: scene file not found')
  })

  it('a spec that cannot be read: the campaign ends with exit 1, and says which spec', async () => {
    const spec = '/campaign/no-such-spec.json'
    const r = await load([], { VR_JOB_SPEC: spec })
    // The driver loads its modules (real imports) before it reads the spec.
    await vi.advanceTimersByTimeAsync(3_000)
    await vi.dynamicImportSettled()
    await vi.advanceTimersByTimeAsync(61_000)

    expect(r.exits).toEqual([1])
    expect(r.stderr).toContain(`  ${spec}: ENOENT`)
  })

  it("integration review: an E2E job an earlier run left open is resumed as the run's own, never its Octane sign-in", async () => {
    const r = await load(
      [node()],
      { VR_E2E_BLEND: '/scenes/e2e.blend' },
      {
        jobs: [{ id: 'job-7', blendPath: '/scenes/e2e.blend', state: 'running' }]
      }
    )
    await vi.advanceTimersByTimeAsync(3_000)

    expect(r.resumedJobs).toEqual([{ jobId: 'job-7', octaneSignIn: false }])
    expect(r.resumedFor).toEqual([['job-7']])
  })

  it('the campaign done (after the driver submitted it): destroys the fleet and exits 0', async () => {
    const r = await load([node()], { VR_E2E_BLEND: '/scenes/e2e.blend' })
    // The driver submits 3 s after boot; the campaign counts as done after
    // two checks 30 s apart with no job open.
    await vi.advanceTimersByTimeAsync(3_000)
    expect(r.exits).toEqual([])
    // The recovery hold is lifted for the job it submitted, and only that.
    expect(r.resumedFor).toEqual([['job-1']])
    await vi.advanceTimersByTimeAsync(61_000)

    expect(r.destroyed).toEqual(['node-1-abcdef'])
    expect(r.exits).toEqual([0])
  })
})

describe("index.ts, a headless run's settings (plan 1.14)", () => {
  // Field: two sessions of VR_JOB_SPEC runs rewrote Elliot's settings.json
  // for good. The next time he opened the app it rented with a campaign's
  // fleet size, cap and filters, none of which he had chosen.
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vr-spec-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("are this run's alone: in the session overlay, and settings.json is never written", async () => {
    const settingsFile = join(dir, 'settings.json')
    writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          public: {
            maxActiveNodes: 2,
            spendCapPerHour: 2,
            noSpendCap: false,
            eagerFleet: false,
            installId: '0b9e3f4c-1d2a-4c3b-9e8f-7a6b5c4d3e2f'
          },
          secrets: {}
        },
        null,
        2
      )
    )
    const before = readFileSync(settingsFile, 'utf-8')
    const spec = join(dir, 'campaign.json')
    writeFileSync(
      spec,
      JSON.stringify({
        blends: ['/scenes/hero.blend'],
        maxActiveNodes: 30,
        spendCapPerHour: 12,
        eagerFleet: true,
        slotsPerGpu: 2,
        offerFilters: { minNumGpus: 4 }
      })
    )
    const submitted: string[] = []
    await load(
      [],
      { VR_JOB_SPEC: spec },
      {
        userData: dir,
        layOverlay: true,
        createJob: async () => {
          submitted.push('hero')
          return 'job-1'
        }
      }
    )
    await vi.advanceTimersByTimeAsync(3_000)
    await vi.dynamicImportSettled()
    await vi.advanceTimersByTimeAsync(0)

    expect(submitted).toEqual(['hero'])
    expect(readFileSync(settingsFile, 'utf-8')).toBe(before)
    const { sessionOverlay } = await import('./settingsOverlay')
    expect(sessionOverlay.fields()).toEqual({
      maxActiveNodes: 30,
      spendCapPerHour: 12,
      noSpendCap: false,
      eagerFleet: true,
      slotsPerGpu: 2,
      offerFilters: { minNumGpus: 4 }
    })
  })

  it('not in force (a settings.ts that does not lay the overlay): nothing submitted, and the run ends at once with 1', async () => {
    // 1.14 review. Saved as the field incident left Elliot's profile. The
    // smoke test asks for 1 node at $2/hr and no buy-ahead; run at the
    // saved settings instead, it could rent 30 nodes and buy ahead to
    // $50/hr. The node billing is one an earlier run rented for a job it
    // left open, which the scheduler would otherwise render on at those caps.
    const saved: SettingsPublic = {
      hasVastApiKey: true,
      hasOtoyCredentials: false,
      projectRoot: '/Users/me/vast-renders',
      maxActiveNodes: 30,
      spendCapPerHour: 50,
      noSpendCap: false,
      idleTimeoutMinutes: 5,
      proxyCodec: 'hevc',
      blenderVersionOverride: null,
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
      eagerFleet: true,
      co2OverheadFactor: 1.6
    }
    const spec = join(dir, 'smoke.json')
    writeFileSync(
      spec,
      JSON.stringify({
        blends: ['/scenes/hero.blend'],
        maxActiveNodes: 1,
        spendCapPerHour: 2,
        eagerFleet: false
      })
    )
    const submitted: string[] = []
    const r = await load(
      [node()],
      { VR_JOB_SPEC: spec },
      {
        settings: saved,
        createJob: async () => {
          submitted.push('hero')
          return 'job-1'
        }
      }
    )
    await vi.advanceTimersByTimeAsync(3_000)
    await vi.dynamicImportSettled()
    await vi.advanceTimersByTimeAsync(0)

    expect(submitted).toEqual([])
    expect(r.destroyed).toEqual(['node-1-abcdef'])
    // Not after the campaign checks, a minute on: at once.
    expect(r.exits).toEqual([1])
    expect(r.stderr).toContain('the campaign was not submitted, so the run ends now')
    expect(r.stderr).toContain('maxActiveNodes is 30, not the 1 the spec asked for')
    const { sessionOverlay } = await import('./settingsOverlay')
    expect(sessionOverlay.isEmpty()).toBe(true)
  })
})

describe('index.ts, an error nothing caught (plan 1.21)', () => {
  // Field, job da68b61b: with the Mac's disk full, the headless stdout
  // mirror threw ENOSPC, and Electron's modal "A JavaScript error occurred
  // in the main process" box sat in front of the app while nodes billed.

  it("a person's app: an uncaught exception is an alert and a line on stderr, not Electron's box", async () => {
    const r = await load([node()])
    const uncaught = r.signals.get('uncaughtException') as ((e: unknown) => void) | undefined
    expect(uncaught).toBeTypeOf('function')
    const { onEvent } = await import('../events')
    const alerts: unknown[] = []
    onEvent((e) => {
      if (e.channel === 'alert') alerts.push(e.payload)
    })

    const e = Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
    expect(() => uncaught!(e)).not.toThrow()

    expect(alerts).toEqual([
      {
        level: 'error',
        message: expect.stringMatching(
          /^Vast Render hit an unexpected error and kept running: ENOSPC: no space left on device/
        )
      }
    ])
    expect(r.stderr).toContain('[vast-render] uncaught exception: ENOSPC: no space left on device')
    expect(r.exits).toEqual([])
  })

  it('a headless run: an unhandled rejection is an alert too, and the campaign carries on', async () => {
    const r = await load([node()], { VR_E2E_BLEND: '/scenes/e2e.blend' })
    const rejected = r.signals.get('unhandledRejection') as ((reason: unknown) => void) | undefined
    expect(rejected).toBeTypeOf('function')
    const { recentAlerts } = await import('../events')

    expect(() => rejected!(new Error('socket hang up'))).not.toThrow()

    expect(recentAlerts().map((a) => a.message)).toEqual([
      expect.stringContaining('kept running: socket hang up')
    ])
    expect(r.stderr).toContain('[vast-render] unhandled rejection: socket hang up')
    expect(r.exits).toEqual([])
  })

  it("stdout and stderr get an 'error' listener in a person's app, not only a headless run", async () => {
    // A person's app started from a terminal writes there too, and a write
    // to a terminal that went away fails later, as an 'error' event.
    const r = await load([])
    expect(r.stdio).toEqual(expect.arrayContaining(['stdout error', 'stderr error']))
  })
})

describe('index.ts serves media:// (plan 1.13)', () => {
  const JOB = '4f1c2a9e-0000-4000-8000-000000000001'
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vr-media-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** index.ts's media:// handler, with JOB's output folder under `dir/old-root`. */
  async function media(): Promise<(url: string, headers?: HeadersInit) => Promise<Response>> {
    const jobDir = join(dir, 'old-root', 'renders', JOB)
    mkdirSync(join(jobDir, 'frames'), { recursive: true })
    writeFileSync(join(jobDir, 'frames', '0001.png'), 'png bytes')
    writeFileSync(join(dir, 'secret.txt'), 'not for the renderer')
    // The project root has since moved (B7): the job's folder is not under it.
    const settings = { projectRoot: join(dir, 'new-root') } as SettingsPublic
    const r = await load([], {}, { settings, jobDirs: { [JOB]: jobDir } })
    const handler = r.protocols.get('media')
    expect(handler).toBeTypeOf('function')
    return (url, headers) => handler!(new Request(url, { headers }))
  }

  it("1.13: a job's file comes from its own output folder, after the project root moved", async () => {
    // Field: changing the root in Settings blanked every earlier job's
    // previews (#9 #61 #175 #202 #214). media://job names the job, not a
    // path under the current root.
    const get = await media()
    const res = await get(`media://job/${JOB}/frames/0001.png`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(await res.text()).toBe('png bytes')
  })

  it('with byte ranges, for <video> seeking', async () => {
    const get = await media()
    const res = await get(`media://job/${JOB}/frames/0001.png`, { range: 'bytes=4-' })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 4-8/9')
    expect(await res.text()).toBe('bytes')
  })

  it('nothing outside the job folder; an unknown job or a bad escape is refused, not thrown', async () => {
    const get = await media()
    expect((await get(`media://job/${JOB}/..%2F..%2F..%2Fsecret.txt`)).status).toBe(403)
    expect((await get(`media://job/${JOB}/%2e%2e/%2e%2e/secret.txt`)).status).toBe(404)
    expect((await get('media://job/no-such-job/frames/0001.png')).status).toBe(404)
    expect((await get(`media://job/${JOB}/frames/%E0%A4%A`)).status).toBe(400)
    expect((await get(`media://job/${JOB}/frames/0002.png`)).status).toBe(404)
  })
})
