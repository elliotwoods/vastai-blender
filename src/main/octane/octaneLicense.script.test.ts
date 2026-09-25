/**
 * octaneLicense.ts against the real remote/octane/setup_octane.sh, run under
 * bash on a stubbed node (test/remoteNode.ts), plan 1.18: the commands the
 * app sends and the stdin it gives them, read by the script as it reads
 * them, and the OCTANE_STATE lines it prints read back into octane_state.
 *
 * What only the pair can show (#40 #156): the OTOY credentials, when the
 * user opted in to a scripted sign-in, reach OctaneServer's stdin and
 * nowhere else on the node; by default nothing does and the sign-in is by
 * hand; the VNC password the tunnel hands out is the one the node's VNC
 * takes; and a second setup starts no second VNC or server (#85).
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OctaneState, SettingsPublic } from '../../shared/models'
import type { Db } from '../db/db'
import type { ExecOptions, ExecResult, SshConnection } from '../ssh/sshConnection'
import { remoteNode, type RemoteNode } from '../test/remoteNode'
import { openTestDb } from '../test/sqlite'

const alerts: string[] = []
const secrets: Record<string, string> = {}
const h = vi.hoisted(() => ({
  db: null as unknown as Db,
  settings: {} as Partial<SettingsPublic>
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => {
      throw new Error('octaneLicense.script.test: getDb() must not reach electron')
    }
  }
}))
vi.mock('../db/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db/db')>()),
  getDb: () => h.db
}))
vi.mock('../events', () => ({
  emit: (channel: string, e: { message?: string }) => {
    if (channel === 'alert' && e.message) alerts.push(e.message)
  }
}))
vi.mock('../settings', () => ({
  getSecret: (k: string) => secrets[k] ?? null,
  getSettings: () => h.settings
}))
vi.mock('../nodes/provisioner', () => ({
  REMOTE_ROOT: '/root/vastai',
  exitStatus: (code: number | null | undefined) => code ?? null,
  ConnectionLostError: class ConnectionLostError extends Error {
    override readonly name = 'ConnectionLostError'
    constructor(label: string) {
      super(`connection closed under ${label}`)
    }
  }
}))

type Octane = typeof import('./octaneLicense')
let octane: Octane

const USER = 'artist@example.com'
const PASS = " two words\\ and a quote' "
const NODE = 'node-1-aaaaaaaa'

/**
 * An SshConnection whose node is a RemoteNode: `bash
 * /root/vastai/octane/setup_octane.sh <args>` runs the real script there,
 * with the exec's stdin as its stdin, as ssh2 would give it.
 */
class ScriptSsh {
  readonly commands: string[] = []
  octaneBlender = true

  constructor(private readonly n: RemoteNode) {}

  async exec(command: string, opts: ExecOptions & { stdin?: string } = {}): Promise<ExecResult> {
    this.commands.push(command)
    if (command === 'test -x /usr/local/OctaneBlender/blender') {
      return { code: this.octaneBlender ? 0 : 1, stdout: '', stderr: '' }
    }
    // The last `setup_octane.sh <args>` in it: `chmod +x … && bash … install`.
    const m = /.*setup_octane\.sh (.+?)(; fi)?$/.exec(command)
    if (!m) throw new Error(`ScriptSsh: no stand-in for ${command}`)
    if (
      /^if \[ -f /.test(command) &&
      !existsSync(join(this.n.vastai, 'state', 'octane-server.pid'))
    ) {
      return { code: 0, stdout: '', stderr: '' }
    }
    running++
    try {
      const r = await this.n.octaneAsync(m[1].split(' '), { input: opts.stdin ?? '' })
      return { code: r.code, stdout: r.stdout, stderr: r.stderr }
    } finally {
      running--
    }
  }

  forwardOut(): Promise<never> {
    return Promise.reject(new Error('not in this test'))
  }

  get ssh(): SshConnection {
    return this as unknown as SshConnection
  }
}

function state(): OctaneState {
  return (
    h.db.prepare('SELECT octane_state FROM nodes WHERE id = ?').get(NODE) as {
      octane_state: OctaneState
    }
  ).octane_state
}

/** The real setTimeout, taken before the tests fake it: the scripts' processes run in real time. */
const realSetTimeout = globalThis.setTimeout

/**
 * Let the setup run until `until` holds. Fake time (setupOctane's waits,
 * and Date) moves a second at a time, but only while no command is running
 * on the node: a script takes real time (ps is slow), and fake time moving
 * meanwhile would make its answers late by an amount that depends on the
 * machine. At most `maxMs` of fake time, and 45 s of real time.
 */
async function drive(until: () => boolean, maxMs = 20 * 60_000): Promise<void> {
  const realEnd = performance.now() + 45_000
  for (let t = 0; t < maxMs && !until() && performance.now() < realEnd;) {
    if (running === 0) {
      await vi.advanceTimersByTimeAsync(1_000)
      t += 1_000
    }
    await new Promise((r) => realSetTimeout(r, 5))
  }
}

/** Commands running on the node now (ScriptSsh). */
let running = 0

describe.skipIf(process.platform === 'win32')(
  'octaneLicense.ts with the real setup_octane.sh',
  { timeout: 60_000 },
  () => {
    let n: RemoteNode
    let ssh: ScriptSsh
    beforeEach(async () => {
      alerts.length = 0
      h.settings = {}
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      const { applySchema } = await vi.importActual<typeof import('../db/db')>('../db/db')
      h.db = openTestDb(applySchema)
      h.db
        .prepare(
          `INSERT INTO nodes (id, instance_id, state, gpu_name) VALUES (?, 1, 'rendering', 'RTX 4090')`
        )
        .run(NODE)
      vi.resetModules()
      octane = await import('./octaneLicense')
      n = remoteNode({ provisioned: true })
      ssh = new ScriptSsh(n)
    })
    afterEach(() => {
      vi.useRealTimers()
      n.dispose()
      for (const k of Object.keys(secrets)) delete secrets[k]
    })

    const serverLog = (): string => join(n.vastai, 'logs', 'octane-server.log')
    /** What OctaneServer logs once someone has signed it in. */
    const signIn = (): void => appendFileSync(serverLog(), 'License acquired\n')

    async function settle<T>(p: Promise<T>): Promise<T | Error> {
      let done = false
      const out = p.then(
        (v) => {
          done = true
          return v
        },
        (e: Error) => {
          done = true
          return e
        }
      )
      await drive(() => done)
      return out
    }

    it('1.18 (#156): opted in, the credentials reach OctaneServer on its stdin, and nowhere else on the node', async () => {
      secrets.otoyUsername = USER
      secrets.otoyPassword = PASS
      h.settings = { octane: { scriptedSignIn: true, secureCloudOnly: false } }
      const setup = octane.setupOctane(ssh.ssh, NODE)
      await drive(() => n.octaneLaunches().length > 0 && existsSync(serverLog()))
      expect(state()).toBe('serverRunning')
      signIn()
      expect(await settle(setup)).toBe('licensed')
      expect(state()).toBe('licensed')

      const [launch] = n.octaneLaunches()
      expect(launch.stdin).toEqual([USER, PASS])
      expect(launch.argv).toEqual([])
      expect(launch.env).not.toContain(USER)
      expect(launch.env).not.toMatch(/OCTANE_(USER|PASS)=/)
      expect(n.filesContaining(n.home, 'two words')).toEqual([])
      expect(n.filesContaining(n.home, USER)).toEqual([])
      expect(ssh.commands.join('\n')).not.toMatch(/two words|artist@/)
    })

    it('1.18 (#40): by default nothing is sent: the server waits for a sign-in by hand, and says so', async () => {
      secrets.otoyUsername = USER
      secrets.otoyPassword = PASS
      const setup = octane.setupOctane(ssh.ssh, NODE)
      await drive(() => state() === 'needsLogin', 5 * 60_000)
      expect(state()).toBe('needsLogin')
      const [launch] = n.octaneLaunches()
      expect(launch.stdin).toEqual(['', ''])
      expect(alerts.join('\n')).toMatch(/waiting for a sign-in: .*Open VNC login/)

      // The user opens the tunnel and signs in on the node's desktop.
      const tunnel = await octane.openVncTunnel(ssh.ssh, NODE)
      try {
        expect(readFileSync(join(n.home, '.vnc', 'passwd'), 'utf8')).toBe(`enc(${tunnel.password})`)
      } finally {
        octane.closeVncTunnel(NODE)
      }
      signIn()
      expect(await settle(setup)).toBe('licensed')
      expect(n.filesContaining(n.home, 'two words')).toEqual([])
    })

    it('1.18 (#85): a second setup starts no second VNC or server, and the licence it finds stands', async () => {
      const first = octane.setupOctane(ssh.ssh, NODE)
      await drive(() => n.octaneLaunches().length > 0 && existsSync(serverLog()))
      signIn()
      expect(await settle(first)).toBe('licensed')

      expect(await settle(octane.setupOctane(ssh.ssh, NODE))).toBe('licensed')
      expect(n.octaneLaunches()).toHaveLength(1)
      expect(n.calls().filter((c) => /^vncserver :0/.test(c))).toHaveLength(1)
      expect(n.calls().filter((c) => /-kill/.test(c))).toEqual([])
      // The licence poll reads it as the script does.
      expect(await settle(octane.refreshOctaneState(ssh.ssh, NODE))).toBe('licensed')
    })

    it('1.18: the destroy-time stop runs only where a server was started, and ends it', async () => {
      await settle(octane.stopOctaneServer(ssh.ssh, { onlyIfStarted: true }))
      expect(n.calls().filter((c) => /OctaneServer/.test(c))).toEqual([])

      const setup = octane.setupOctane(ssh.ssh, NODE)
      await drive(() => n.octaneLaunches().length > 0 && existsSync(serverLog()))
      signIn()
      await settle(setup)
      await settle(octane.stopOctaneServer(ssh.ssh, { onlyIfStarted: true }))
      expect(await settle(octane.refreshOctaneState(ssh.ssh, NODE))).toBe('none')
      expect(state()).toBe('none')
    })

    it('1.18 (#85): a node without OctaneBlender gets no VNC, no server and no sign-in', async () => {
      ssh.octaneBlender = false
      const e = await settle(octane.setupOctane(ssh.ssh, NODE))
      expect(e).toBeInstanceOf(octane.OctaneBlenderMissingError)
      expect(n.calls()).toEqual([])
    })
  }
)
