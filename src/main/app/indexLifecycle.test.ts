import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NodeSnapshot } from '../../shared/models'

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
  closedDb: number
  schedulerStopped: number
  shutdowns: number
  nodes: NodeSnapshot[]
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
 */
async function load(
  nodes: NodeSnapshot[],
  env: Record<string, string> = {},
  opts: { createJob?: () => Promise<string> } = {}
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
    closedDb: 0,
    schedulerStopped: 0,
    shutdowns: 0,
    nodes
  }
  FakeWindow.app = out.listeners
  let ready!: () => void
  const whenReady = new Promise<void>((r) => (ready = r))
  vi.doMock('electron', () => ({
    app: {
      setPath: () => {},
      getPath: () => '/profiles/test',
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
    protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
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
      kick: () => {}
    }
  }))
  vi.doMock('../transfer/jobClip', () => ({ jobClips: { catchUp: () => {} } }))
  vi.doMock('../settings', () => ({ getSettings: () => ({}), updateSettings: () => {} }))
  vi.doMock('../db/db', () => ({
    closeDb: () => {
      out.closedDb++
    },
    // openJobs' count: no job queued or running.
    getDb: () => ({ prepare: () => ({ get: () => ({ n: 0 }) }) })
  }))
  vi.doMock('../jobs/jobs', () => ({
    listJobs: () => [],
    createJob: opts.createJob ?? (async () => 'job-1'),
    emitChunksChanged: () => {},
    refreshJobState: () => {}
  }))
  vi.spyOn(process, 'on').mockImplementation(((event: string, fn: () => void) => {
    out.signals.set(event, fn)
    return process
  }) as typeof process.on)

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
        'sleeps, and nothing renders or downloads until it wakes'
    ])
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

  it("a person's window on Windows closes as it always did", async () => {
    await onWindows(async () => {
      await load([node()])
      expect(closeWindow(FakeWindow.all[0])).toBe(true)
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

  it('on Windows, closing the window hides it, so a shutdown still asks and is held for the destroy', async () => {
    await onWindows(async () => {
      const r = await load([node()], { VR_JOB_SPEC: '/campaign/spec.json' })
      const [win] = FakeWindow.all

      expect(closeWindow(win)).toBe(false)
      expect(win.hidden).toBe(1)
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

  it('the campaign done (after the driver submitted it): destroys the fleet and exits 0', async () => {
    const r = await load([node()], { VR_E2E_BLEND: '/scenes/e2e.blend' })
    // The driver submits 3 s after boot; the campaign counts as done after
    // two checks 30 s apart with no job open.
    await vi.advanceTimersByTimeAsync(3_000)
    expect(r.exits).toEqual([])
    await vi.advanceTimersByTimeAsync(61_000)

    expect(r.destroyed).toEqual(['node-1-abcdef'])
    expect(r.exits).toEqual([0])
  })
})
