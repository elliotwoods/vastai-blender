import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  /** What it wrote to stderr (fd 2). */
  stderr: string
  /** process.exit's code, if the launch left. */
  exitCode: number | null
  quit: number
  /** The running instance's 'second-instance' listener, if it registered one. */
  secondInstance: SecondInstanceHandler | undefined
}

/**
 * Load index.ts as a launch with `env` would, with the lock already held by
 * another process (`lockHeld`) or not.
 */
async function load(lockHeld: boolean, env: Record<string, string> = {}): Promise<Loaded> {
  for (const k of ['VR_JOB_SPEC', 'VR_E2E_BLEND', 'VR_SHOT', 'VR_USERDATA']) {
    vi.stubEnv(k, env[k] ?? '')
  }
  const out: Loaded = {
    lockData: undefined,
    stderr: '',
    exitCode: null,
    quit: 0,
    secondInstance: undefined
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
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Exit(code ?? 0)
  }) as typeof process.exit)

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

  it.each([['VR_JOB_SPEC'], ['VR_E2E_BLEND']])(
    'a headless run (%s) leaves with 1: it submitted nothing',
    async (key) => {
      const r = await load(true, { [key]: '/campaign/spec.json' })
      expect(r.exitCode).toBe(1)
      expect(r.stderr).toContain('this headless run submitted nothing')
    }
  )

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
    expect((await load(true, { VR_JOB_SPEC: '/s.json' })).lockData).toEqual({ scripted: true })
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
  })
})
