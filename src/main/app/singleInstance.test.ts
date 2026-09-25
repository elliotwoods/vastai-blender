import { resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HandoffResult } from './headless/handoff'

// index.ts's single-instance lock: what a launch refused by it does, and what
// the running instance does about it. index.ts takes the lock as it loads, so
// each test loads it afresh under a recorded electron, with every app module
// it imports stubbed out: nothing past the lock runs, since whenReady never
// resolves here.

/** process.exit, which the refused launch calls at load, stopping the import. */
class Exit extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`)
  }
}

/** The window the running instance has, or makes for a second launch. */
class FakeWindow {
  static all: FakeWindow[] = []
  static created = 0
  shown = 0
  focused = 0
  restored = 0
  minimized = false

  constructor() {
    FakeWindow.created++
    FakeWindow.all.push(this)
  }

  static getAllWindows(): FakeWindow[] {
    return [...FakeWindow.all]
  }

  isMinimized(): boolean {
    return this.minimized
  }

  restore(): void {
    this.restored++
  }

  show(): void {
    this.shown++
  }

  focus(): void {
    this.focused++
  }

  on = (): void => {}
  loadURL = (): void => {}
  loadFile = (): void => {}

  readonly webContents = {
    on: (): void => {},
    once: (): void => {},
    setWindowOpenHandler: (): void => {}
  }
}

type SecondInstanceHandler = (
  event: unknown,
  argv: string[],
  workingDirectory: string,
  additionalData: unknown
) => void

interface Loaded {
  /** What index.ts passed requestSingleInstanceLock. */
  lockData: unknown
  /** What it wrote to stdout (fd 1). */
  stdout: string
  /** What it wrote to stderr (fd 2). */
  stderr: string
  /** process.exit's code, if the launch left. */
  exitCode: number | null
  quit: number
  /** The running instance's 'second-instance' listener, if it registered one. */
  secondInstance: SecondInstanceHandler | undefined
  /** Specs the running instance accepted from a handed-off launch. */
  accepted: unknown[]
}

/**
 * The running app's answer a refused VR_JOB_SPEC launch reads (handoff.ts's
 * awaitHandoffResult); null = none came, as from a build without hand-off.
 */
let handoffAnswer: HandoffResult | null = null

/**
 * Load index.ts as a launch with `env` would, with the lock already held by
 * another process (`lockHeld`) or not.
 */
async function load(lockHeld: boolean, env: Record<string, string> = {}): Promise<Loaded> {
  const handoff = await vi.importActual<typeof import('./headless/handoff')>('./headless/handoff')
  for (const k of ['VR_JOB_SPEC', 'VR_E2E_BLEND', 'VR_SHOT', 'VR_USERDATA']) {
    vi.stubEnv(k, env[k] ?? '')
  }
  const out: Loaded = {
    lockData: undefined,
    stdout: '',
    stderr: '',
    exitCode: null,
    quit: 0,
    secondInstance: undefined,
    accepted: []
  }
  const listeners = new Map<string, unknown>()
  vi.doMock('electron', () => ({
    app: {
      setPath: () => {},
      getPath: () => '/profiles/test',
      getAppPath: () => '/app',
      isPackaged: false,
      requestSingleInstanceLock: (data?: unknown) => {
        out.lockData = data
        return !lockHeld
      },
      on: (event: string, fn: unknown) => listeners.set(event, fn),
      quit: () => {
        out.quit++
      },
      // Never ready: nothing after the lock runs.
      whenReady: () => new Promise(() => {})
    },
    BrowserWindow: FakeWindow,
    protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
    shell: {}
  }))
  vi.doMock('fs', async (importOriginal) => ({
    ...(await importOriginal<typeof import('fs')>()),
    writeSync: (fd: number, text: string) => {
      if (fd === 1) out.stdout += text
      if (fd === 2) out.stderr += text
      return text.length
    }
  }))
  vi.doMock('@electron-toolkit/utils', () => ({
    electronApp: {},
    optimizer: {},
    is: { dev: false }
  }))
  vi.doMock('../../../resources/icon.png?asset', () => ({ default: 'icon.png' }))
  vi.doMock('../ipc', () => ({ registerIpc: () => {} }))
  vi.doMock('../nodes/nodeManager', () => ({
    nodeManager: {},
    setActiveWorkProvider: () => {},
    setForgetNodeProvider: () => {},
    setSlotInfoProvider: () => {}
  }))
  vi.doMock('../nodes/provisioner', () => ({}))
  vi.doMock('../blender/blendInfo', () => ({}))
  vi.doMock('../scheduler/scheduler', () => ({ scheduler: {} }))
  vi.doMock('../transfer/jobClip', () => ({ jobClips: {} }))
  vi.doMock('../settings', () => ({ getSettings: () => ({}) }))
  // The hand-off's wait and submit are handoff.test.ts's: here, the launch
  // gets `handoffAnswer` at once, and the running app records what it accepted.
  vi.doMock('./headless/handoff', () => ({
    ...handoff,
    awaitHandoffResult: () => handoffAnswer,
    acceptHandoff: async (req: unknown) => {
      out.accepted.push(req)
    }
  }))
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Exit(code ?? 0)
  }) as typeof process.exit)
  // index.ts installs its crash guard and stdio guard as it loads (plan
  // 1.21). Recorded here rather than added to the test runner's own process
  // and streams: every load would leave one of each behind for the rest of
  // the worker, writing crash lines and raising alerts for its errors.
  vi.spyOn(process, 'on').mockImplementation((() => process) as typeof process.on)
  for (const stream of [process.stdout, process.stderr]) {
    vi.spyOn(stream, 'on').mockImplementation((() => stream) as typeof stream.on)
  }

  try {
    await import('../index')
  } catch (e) {
    if (!(e instanceof Exit)) throw e
    out.exitCode = e.code
  }
  out.secondInstance = listeners.get('second-instance') as SecondInstanceHandler | undefined
  return out
}

beforeEach(() => {
  vi.resetModules()
  handoffAnswer = null
  FakeWindow.all = []
  FakeWindow.created = 0
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('a launch refused by the single-instance lock', () => {
  it('a person launching the app leaves with 0, for the running one to come forward', async () => {
    const r = await load(true)
    expect(r.exitCode).toBe(0)
    expect(r.quit).toBe(1)
    expect(r.stderr).toContain('another instance is already running on /profiles/test')
    expect(r.secondInstance).toBeUndefined()
  })

  it('an end-to-end run (VR_E2E_BLEND) leaves with 1: it submitted nothing', async () => {
    const r = await load(true, { VR_E2E_BLEND: '/scenes/e2e.blend' })
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('this headless run submitted nothing')
  })

  // A campaign launched beside a running app is that app's to submit
  // (handoff.ts): the launch hands it over and leaves with the answer.
  it('a campaign (VR_JOB_SPEC) hands its spec over and leaves with 0 when it was all submitted', async () => {
    handoffAnswer = {
      requestId: 'r',
      ok: true,
      jobs: ['job-a', 'job-b'],
      unsubmitted: [],
      settings: {}
    }
    const r = await load(true, { VR_JOB_SPEC: '/campaign/spec.json' })
    expect(r.exitCode).toBe(0)
    expect(r.quit).toBe(0)
    expect(r.stdout).toContain('spec handed to the app already running on /profiles/test')
    expect(r.stdout).toContain('job-a, job-b')
    expect(r.stderr).toBe('')
  })

  it('a campaign leaves with 1 when the running app refused part of it', async () => {
    handoffAnswer = {
      requestId: 'r',
      ok: false,
      jobs: ['job-a'],
      unsubmitted: ['/scenes/b.blend: no such file'],
      settings: {}
    }
    const r = await load(true, { VR_JOB_SPEC: '/campaign/spec.json' })
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('not submitted: /scenes/b.blend: no such file')
  })

  it('a campaign leaves with 1 when the running app never answers (a build without hand-off)', async () => {
    const r = await load(true, { VR_JOB_SPEC: '/campaign/spec.json' })
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('did not answer')
    expect(r.stderr).toContain('nothing is known to be submitted')
  })

  // A capture script (the phase gate's boot check among them) must be able
  // to tell "refused" from "captured": exit 0 with no PNG was both.
  it('a capture (VR_SHOT) leaves with 1 and says no capture was written', async () => {
    const r = await load(true, { VR_SHOT: '/tmp/boot.png' })
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('another instance is already running on /profiles/test')
    expect(r.stderr).toContain('/tmp/boot.png')
  })

  it('tells the running instance whether a person or a script launched it', async () => {
    expect((await load(true)).lockData).toEqual({ scripted: false })
    vi.resetModules()
    expect((await load(true, { VR_JOB_SPEC: '/s.json' })).lockData).toEqual({
      scripted: true,
      jobSpec: resolve('/s.json'),
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      cwd: process.cwd()
    })
    vi.resetModules()
    expect((await load(true, { VR_E2E_BLEND: '/e.blend' })).lockData).toEqual({ scripted: true })
    vi.resetModules()
    expect((await load(true, { VR_SHOT: '/tmp/x.png' })).lockData).toEqual({ scripted: true })
  })
})

describe('the running instance, on a second launch', () => {
  it("brings its window forward for a person's launch", async () => {
    const r = await load(false)
    expect(r.exitCode).toBeNull()
    const win = new FakeWindow()
    win.minimized = true
    r.secondInstance!({}, [], '/', { scripted: false })
    expect(win).toMatchObject({ restored: 1, shown: 1, focused: 1 })
  })

  it('opens a window for a person when a headless run has none', async () => {
    const r = await load(false, { VR_JOB_SPEC: '/campaign/spec.json' })
    r.secondInstance!({}, [], '/', { scripted: false })
    expect(FakeWindow.created).toBe(1)
  })

  it('treats a launch that sent nothing (an older build) as a person', async () => {
    const r = await load(false)
    const win = new FakeWindow()
    r.secondInstance!({}, [], '/', undefined)
    expect(win.shown).toBe(1)
  })

  // A resubmitted campaign or a capture, refused because this one runs, must
  // not pop a window up on a box that is rendering headless.
  it('leaves its window alone, and makes none, for a scripted launch', async () => {
    const r = await load(false, { VR_JOB_SPEC: '/campaign/spec.json' })
    r.secondInstance!({}, [], '/', { scripted: true })
    expect(FakeWindow.created).toBe(0)

    const win = new FakeWindow()
    r.secondInstance!({}, [], '/', { scripted: true })
    expect(win).toMatchObject({ restored: 0, shown: 0, focused: 0 })
    expect(FakeWindow.created).toBe(1)
    expect(r.accepted).toEqual([])
  })

  it('submits a handed-off campaign, and leaves its window alone', async () => {
    const r = await load(false)
    const win = new FakeWindow()
    const req = {
      scripted: true,
      jobSpec: '/campaign/spec.json',
      requestId: 'req-12345678',
      cwd: '/work'
    }
    r.secondInstance!({}, [], '/', req)
    expect(r.accepted).toEqual([req])
    expect(win).toMatchObject({ restored: 0, shown: 0, focused: 0 })
    expect(FakeWindow.created).toBe(1)
  })

  it('treats a malformed hand-off as a plain scripted launch', async () => {
    const r = await load(false)
    r.secondInstance!({}, [], '/', {
      scripted: true,
      jobSpec: '/s.json',
      requestId: '../../etc',
      cwd: '/'
    })
    expect(r.accepted).toEqual([])
    expect(FakeWindow.created).toBe(0)
  })
})

describe('loading index.ts here', () => {
  it("leaves no listener on the test runner's process or streams", async () => {
    const count = (): number[] => [
      process.listenerCount('uncaughtException'),
      process.listenerCount('unhandledRejection'),
      process.stdout.listenerCount('error'),
      process.stderr.listenerCount('error')
    ]
    const before = count()
    await load(false)
    vi.resetModules()
    await load(true, { VR_JOB_SPEC: '/campaign/spec.json' })
    expect(count()).toEqual(before)
  })
})
