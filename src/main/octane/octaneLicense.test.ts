/**
 * octaneLicense.ts: what the app sends a node to set Octane up, and what it
 * makes of the answers.
 *
 * - Plan 1.8: every command has a deadline, since it runs inside the
 *   scheduler's per-node prep lock, and a label, which is what an error
 *   names instead of the command text.
 * - Plan 1.18 (#40 #85 #156): the OTOY credentials are sent only when the
 *   user opted in to a scripted sign-in, and then only on the exec's stdin,
 *   never in a command, a label or an error; the VNC password likewise.
 *   octane_state follows setup_octane.sh's OCTANE_STATE lines, a server
 *   with no licence past a minute needs a sign-in, a dispatch waits for it
 *   once, and a repeat of the setup restarts nothing.
 *
 * The node here is scripted by hand; octaneLicense.script.test.ts runs the
 * same calls against the real setup_octane.sh.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OctaneState, SettingsPublic } from '../../shared/models'
import type { Db } from '../db/db'
import type { ExecOptions, ExecResult, SshConnection } from '../ssh/sshConnection'
import { openTestDb } from '../test/sqlite'

const alerts: Array<{ level: string; message: string }> = []
const secrets: Record<string, string> = {}
const h = vi.hoisted(() => ({
  db: null as unknown as Db,
  settings: {} as Partial<SettingsPublic>
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => {
      throw new Error('octaneLicense.test: getDb() must not reach electron')
    }
  }
}))
vi.mock('../db/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db/db')>()),
  getDb: () => h.db
}))
vi.mock('../events', () => ({
  emit: (channel: string, e: { level: string; message?: string }) => {
    if (channel === 'alert' && e.message) alerts.push({ level: e.level, message: e.message })
  }
}))
vi.mock('../settings', () => ({
  getSecret: (k: string) => secrets[k] ?? null,
  getSettings: () => h.settings
}))
// provisioner.ts reaches for electron and the transfer code; these three are all octaneLicense uses.
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
const PASS = "hun ter2\\'x"
const NODE = 'node-1-aaaaaaaa'

interface Call {
  command: string
  opts: ExecOptions & { stdin?: string }
}

/**
 * A node whose exec answers `reply(command, opts)`, or never answers when it
 * returns null; like the real one, a call with a deadline then fails at it.
 */
function node(reply: (command: string, opts: Call['opts']) => ExecResult | null): {
  ssh: SshConnection
  calls: Call[]
} {
  const calls: Call[] = []
  const exec = (command: string, opts: Call['opts'] = {}): Promise<ExecResult> => {
    calls.push({ command, opts })
    const r = reply(command, opts)
    if (r) return Promise.resolve(r)
    return new Promise((_resolve, reject) => {
      if (opts.timeoutMs) {
        setTimeout(
          () => reject(new Error(`exec timeout after ${opts.timeoutMs}ms: ${opts.label}`)),
          opts.timeoutMs
        )
      }
    })
  }
  const forwardOut = (): Promise<never> => Promise.reject(new Error('not in this test'))
  return { ssh: { exec, forwardOut } as unknown as SshConnection, calls }
}

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' })

/**
 * setup_octane.sh as the app sees it: `state.now` is what status says, and a
 * start-server launches a server (serverRunning) unless one runs.
 */
function octaneNode(state: { now: OctaneState }): ReturnType<typeof node> {
  return node((c) => {
    if (/start-server/.test(c)) {
      if (state.now === 'none') {
        state.now = 'serverRunning'
        return ok('[octane] OctaneServer launched (pid 4242)\nOCTANE_STATE serverRunning\n')
      }
      return ok(
        `[octane] OctaneServer already running (pid 4242) — left as is\nOCTANE_STATE ${state.now}\n`
      )
    }
    if (/setup_octane\.sh status/.test(c)) return ok(`OCTANE_STATE ${state.now}\n`)
    return ok()
  })
}

function row(): { octane_state: string; octane_ready: number } {
  return h.db.prepare('SELECT octane_state, octane_ready FROM nodes WHERE id = ?').get(NODE) as {
    octane_state: string
    octane_ready: number
  }
}

beforeEach(async () => {
  alerts.length = 0
  h.settings = {}
  vi.useFakeTimers()
  const { applySchema } = await vi.importActual<typeof import('../db/db')>('../db/db')
  h.db = openTestDb(applySchema)
  h.db
    .prepare(
      `INSERT INTO nodes (id, instance_id, state, gpu_name) VALUES (?, 1, 'rendering', 'RTX 4090')`
    )
    .run(NODE)
  vi.resetModules()
  octane = await import('./octaneLicense')
})
afterEach(() => {
  vi.useRealTimers()
  for (const k of Object.keys(secrets)) delete secrets[k]
})

describe('setupOctane: deadlines and labels (1.8)', () => {
  it('1.8: every command has a deadline and a label, and no label carries the credentials', async () => {
    secrets.otoyUsername = USER
    secrets.otoyPassword = PASS
    h.settings = { octane: { scriptedSignIn: true, secureCloudOnly: false } }
    const state = { now: 'none' as OctaneState }
    const { ssh, calls } = octaneNode(state)
    const setup = octane.setupOctane(ssh, NODE)
    await vi.advanceTimersByTimeAsync(1_000)
    // Launched; the scripted sign-in takes.
    state.now = 'licensed'
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(setup).resolves.toBe('licensed')

    expect(calls.map((c) => c.opts.label)).toEqual([
      'check OctaneBlender',
      'install Octane',
      'start VNC',
      'start OctaneServer',
      'read Octane state'
    ])
    for (const c of calls) expect(c.opts.timeoutMs).toBeGreaterThan(0)
    const launchOpts: Call['opts'] = { ...calls[3].opts }
    delete launchOpts.stdin
    expect(JSON.stringify([...calls.map((c) => c.command), launchOpts])).not.toMatch(
      /hun ter2|artist@/
    )
  })

  it('1.8: a state read that never answers ends at the wait, not never', async () => {
    const { ssh } = node((c) => {
      if (/start-server/.test(c)) {
        return ok('[octane] OctaneServer launched (pid 1)\nOCTANE_STATE serverRunning\n')
      }
      if (/status/.test(c)) return null
      return ok()
    })
    let settled = false
    const setup = octane.setupOctane(ssh, NODE).catch((e: Error) => {
      settled = true
      return e
    })
    await vi.advanceTimersByTimeAsync(
      octane.OCTANE_LICENSE_WAIT_MS + octane.OCTANE_LOGIN_WAIT_MS + 60_000
    )
    expect(settled).toBe(true)
    expect(await setup).toBeInstanceOf(octane.OctaneLoginNeededError)
    // A node that never answered never asked anyone to sign in.
    expect(octane.octaneSignInHold()).toBeNull()
  })
})

describe('setupOctane: credentials (1.18, #40 #156)', () => {
  it('1.18: by default no credential leaves this computer, saved or not: the sign-in is by hand', async () => {
    secrets.otoyUsername = USER
    secrets.otoyPassword = PASS
    const state = { now: 'none' as OctaneState }
    const { ssh, calls } = octaneNode(state)
    const setup = octane.setupOctane(ssh, NODE)
    await vi.advanceTimersByTimeAsync(20_000)
    state.now = 'licensed'
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(setup).resolves.toBe('licensed')

    const launch = calls.find((c) => /start-server/.test(c.command))!
    expect(launch.command).toBe('bash /root/vastai/octane/setup_octane.sh start-server')
    expect(launch.opts.stdin).toBeUndefined()
    expect(JSON.stringify(calls)).not.toMatch(/hun ter2|artist@|OCTANE_USER|OCTANE_PASS/)
  })

  it('1.18: opted in, the credentials go on the exec stdin only, one per line, byte for byte', async () => {
    secrets.otoyUsername = USER
    secrets.otoyPassword = PASS
    h.settings = { octane: { scriptedSignIn: true, secureCloudOnly: false } }
    const state = { now: 'none' as OctaneState }
    const { ssh, calls } = octaneNode(state)
    const setup = octane.setupOctane(ssh, NODE)
    await vi.advanceTimersByTimeAsync(1_000)
    // Launched; the scripted sign-in takes.
    state.now = 'licensed'
    await vi.advanceTimersByTimeAsync(10_000)
    await setup

    const launch = calls.find((c) => /start-server/.test(c.command))!
    expect(launch.command).toBe(
      'bash /root/vastai/octane/setup_octane.sh start-server --credentials-stdin'
    )
    expect(launch.opts.stdin).toBe(`${USER}\n${PASS}\n`)
    // Nowhere else: no other command carries them on its stdin.
    expect(calls.filter((c) => c.opts.stdin?.includes('hun ter2'))).toEqual([launch])
  })

  it('1.18: opted in without both credentials saved is the sign-in by hand', async () => {
    secrets.otoyUsername = USER
    h.settings = { octane: { scriptedSignIn: true, secureCloudOnly: false } }
    const state = { now: 'none' as OctaneState }
    const { ssh, calls } = octaneNode(state)
    const setup = octane.setupOctane(ssh, NODE)
    await vi.advanceTimersByTimeAsync(1_000)
    // Launched; the scripted sign-in takes.
    state.now = 'licensed'
    await vi.advanceTimersByTimeAsync(10_000)
    await setup
    const launch = calls.find((c) => /start-server/.test(c.command))!
    expect(launch.command).not.toContain('--credentials-stdin')
    expect(launch.opts.stdin).toBeUndefined()
  })

  it('1.18 (review): with secure cloud only, the credentials go only to a node rented through it; any other signs in by hand', async () => {
    secrets.otoyUsername = USER
    secrets.otoyPassword = PASS
    h.settings = { octane: { scriptedSignIn: true, secureCloudOnly: true } }

    /** One setup on a fresh node rented as `rental`: the start-server call, and the alerts it raised. */
    async function launchOn(
      rental: import('./octaneLicense').OctaneRentalFacts | null | 'noProvider'
    ): Promise<{ launch: Call; alerts: string[] }> {
      vi.resetModules()
      octane = await import('./octaneLicense')
      if (rental !== 'noProvider') octane.setRentalFacts((id) => (id === NODE ? rental : null))
      h.db.prepare(`UPDATE nodes SET octane_state = 'none' WHERE id = ?`).run(NODE)
      alerts.length = 0
      const state = { now: 'none' as OctaneState }
      const { ssh, calls } = octaneNode(state)
      const setup = octane.setupOctane(ssh, NODE)
      // Past the licence wait: the node asks for a sign-in by hand, unless
      // the credentials went.
      await vi.advanceTimersByTimeAsync(octane.OCTANE_LICENSE_WAIT_MS + 5_000)
      state.now = 'licensed'
      await vi.advanceTimersByTimeAsync(10_000)
      await expect(setup).resolves.toBe('licensed')
      return {
        launch: calls.find((c) => /start-server/.test(c.command))!,
        alerts: alerts.map((a) => a.message)
      }
    }

    // A Cycles node on someone's own machine that an Octane chunk reached,
    // a node rented without its engine, one from before a restart: none of
    // them is known to be a datacenter host.
    for (const rental of [
      { engine: 'cycles' as const, secureCloud: false },
      { engine: null, secureCloud: false },
      { engine: 'octane' as const, secureCloud: false },
      null,
      'noProvider' as const
    ]) {
      const { launch, alerts: said } = await launchOn(rental)
      expect(launch.command).toBe('bash /root/vastai/octane/setup_octane.sh start-server')
      expect(launch.opts.stdin).toBeUndefined()
      expect(said).toEqual([
        expect.stringMatching(
          /is waiting for a sign-in: .*Open VNC login.* The scripted sign-in was not used: this node was not rented as a datacenter \(secure cloud\) host/
        ),
        expect.stringMatching(/is signed in/)
      ])
    }

    // Rented through the filter: the scripted sign-in goes ahead.
    const { launch, alerts: said } = await launchOn({ engine: 'octane', secureCloud: true })
    expect(launch.command).toBe(
      'bash /root/vastai/octane/setup_octane.sh start-server --credentials-stdin'
    )
    expect(launch.opts.stdin).toBe(`${USER}\n${PASS}\n`)
    expect(said.join('\n')).not.toMatch(/scripted sign-in was not used/)
  })

  it('1.18: the VNC password goes on stdin, stays the same for the node, and is what the tunnel hands out', async () => {
    const state = { now: 'licensed' as OctaneState }
    const { ssh, calls } = octaneNode(state)
    await octane.setupOctane(ssh, NODE)
    await octane.setupOctane(ssh, NODE)
    const vncs = calls.filter((c) => /start-vnc/.test(c.command))
    expect(vncs.map((c) => c.command)).toEqual([
      'bash /root/vastai/octane/setup_octane.sh start-vnc --password-stdin',
      'bash /root/vastai/octane/setup_octane.sh start-vnc --password-stdin'
    ])
    const password = vncs[0].opts.stdin!.trim()
    expect(password).toMatch(/^[\w-]{12}$/)
    expect(vncs[1].opts.stdin).toBe(`${password}\n`)

    vi.useRealTimers()
    const tunnel = await octane.openVncTunnel(ssh, NODE)
    try {
      expect(tunnel.password).toBe(password)
      expect(tunnel.localPort).toBeGreaterThan(0)
      expect(await octane.openVncTunnel(ssh, NODE)).toEqual(tunnel)
    } finally {
      octane.closeVncTunnel(NODE)
    }
  })

  it('1.18: after a restart the tunnel sets a password of its own, so the one it hands out works', async () => {
    vi.useRealTimers()
    const { ssh, calls } = octaneNode({ now: 'needsLogin' })
    const tunnel = await octane.openVncTunnel(ssh, NODE)
    try {
      expect(tunnel.password).not.toBe('')
      const [vnc] = calls.filter((c) => /start-vnc/.test(c.command))
      expect(vnc.opts.stdin).toBe(`${tunnel.password}\n`)
    } finally {
      octane.closeVncTunnel(NODE)
    }
  })

  it('1.18 (review): after a restart, a setup and an Open VNC login at once send the node one password, the one the tunnel hands out', async () => {
    vi.useRealTimers()
    const state = { now: 'licensed' as OctaneState }
    const inner = octaneNode(state)
    // start-vnc answers only once both have asked, as two commands in
    // flight on the node at once would.
    const release: Array<() => void> = []
    const exec = (command: string, opts: Call['opts'] = {}): Promise<ExecResult> => {
      if (!/start-vnc/.test(command)) return inner.ssh.exec(command, opts)
      inner.calls.push({ command, opts })
      return new Promise((resolve) => release.push(() => resolve(ok())))
    }
    const ssh = { ...inner.ssh, exec } as unknown as SshConnection
    const setup = octane.setupOctane(ssh, NODE)
    const opening = octane.openVncTunnel(ssh, NODE)
    await vi.waitFor(() => expect(release).toHaveLength(2))
    for (const r of release) r()
    const [, tunnel] = await Promise.all([setup, opening])
    try {
      const sent = inner.calls.filter((c) => /start-vnc/.test(c.command)).map((c) => c.opts.stdin)
      expect(sent).toEqual([`${tunnel.password}\n`, `${tunnel.password}\n`])
    } finally {
      octane.closeVncTunnel(NODE)
    }
  })

  it('1.18 (review): a refusal the script prints on plain stdout is what the error says', async () => {
    // What every setup met while the exec sent no stdin.
    const { ssh } = node((c) =>
      /start-vnc/.test(c) ? { code: 1, stdout: 'missing vnc password\n', stderr: '' } : ok()
    )
    await expect(octane.setupOctane(ssh, NODE)).rejects.toThrow(
      /^vnc start failed: missing vnc password$/
    )
  })

  it("1.18: a node whose display is some other X server's has no VNC sign-in, and says so", async () => {
    vi.useRealTimers()
    const { ssh } = node((c) =>
      /start-vnc/.test(c)
        ? {
            code: 1,
            stdout: '',
            stderr:
              '[octane] display :0 is held by an X server that is not VNC (pid 12: Xorg :0) — ' +
              'left as is; no VNC sign-in on this node\n'
          }
        : ok()
    )
    await expect(octane.openVncTunnel(ssh, NODE)).rejects.toThrow(/no VNC sign-in on this node/)
    await expect(octane.setupOctane(ssh, NODE)).rejects.toThrow(
      /^vnc start failed: .*no way to sign in to Octane by hand/
    )
  })
})

describe('setupOctane: the node and its state (1.18, #85)', () => {
  it('1.18: octane_state follows the script: a server with no licence past a minute needs a sign-in, and one by hand licenses it', async () => {
    const heard: OctaneState[] = []
    octane.onOctaneState((id, s) => {
      if (id === NODE) heard.push(s)
    })
    const state = { now: 'none' as OctaneState }
    const { ssh } = octaneNode(state)
    const setup = octane.setupOctane(ssh, NODE)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(row()).toEqual({ octane_state: 'serverRunning', octane_ready: 0 })
    await vi.advanceTimersByTimeAsync(35_000)
    expect(row()).toEqual({ octane_state: 'needsLogin', octane_ready: 0 })
    expect(alerts).toEqual([
      {
        level: 'warn',
        message: expect.stringMatching(
          /^Octane on RTX 4090 node-1-a is waiting for a sign-in: .*Open VNC login.*bills meanwhile/
        )
      }
    ])

    // The user signs in over VNC; the dispatch that waited goes on.
    state.now = 'licensed'
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(setup).resolves.toBe('licensed')
    expect(row()).toEqual({ octane_state: 'licensed', octane_ready: 1 })
    expect(heard).toEqual(['serverRunning', 'needsLogin', 'licensed'])
    expect(alerts.at(-1)).toEqual({
      level: 'info',
      message: 'Octane on RTX 4090 node-1-a is signed in: its Octane chunks can render'
    })
  })

  it('1.18: a dispatch waits for the sign-in once; the next one on the same node fails at once', async () => {
    const state = { now: 'needsLogin' as OctaneState }
    const { ssh } = octaneNode(state)
    let first: unknown = null
    const setup = octane.setupOctane(ssh, NODE).catch((e: unknown) => (first = e))
    await vi.advanceTimersByTimeAsync(octane.OCTANE_LOGIN_WAIT_MS - 10_000)
    expect(first).toBeNull()
    await vi.advanceTimersByTimeAsync(20_000)
    await setup
    expect(first).toBeInstanceOf(octane.OctaneLoginNeededError)
    expect((first as Error).message).toMatch(/Open VNC login/)

    const t = Date.now()
    await expect(octane.setupOctane(ssh, NODE)).rejects.toBeInstanceOf(
      octane.OctaneLoginNeededError
    )
    expect(Date.now()).toBe(t)
    // One alert for the whole while it needed a sign-in.
    expect(alerts.filter((a) => a.level === 'warn')).toHaveLength(1)
  })

  it('1.18 (review, A1): a sign-in nobody made holds: no other node waits for one, until someone signs in or acts', async () => {
    const NODE_B = 'node-2-bbbbbbbb'
    h.db
      .prepare(
        `INSERT INTO nodes (id, instance_id, state, gpu_name) VALUES (?, 2, 'rendering', 'RTX 4090')`
      )
      .run(NODE_B)
    const a = { now: 'needsLogin' as OctaneState }
    const nodeA = octaneNode(a)
    expect(octane.octaneSignInHold()).toBeNull()
    const waited = octane.setupOctane(nodeA.ssh, NODE).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(octane.OCTANE_LOGIN_WAIT_MS + 10_000)
    expect(await waited).toBeInstanceOf(octane.OctaneLoginNeededError)
    const since = octane.octaneSignInHold()?.since
    expect(octane.octaneSignInHold()).toEqual({
      nodeId: NODE,
      since: expect.any(Number),
      reason:
        'nobody signed in to Octane on RTX 4090 node-1-a within 10 min: sign in over VNC ' +
        '(Fleet → the node → Open VNC login)'
    })
    expect(octane.octaneUnfit(NODE)).toMatch(/^nobody signed in to Octane on this node/)

    // Another node gets no wait of its own: nobody is there to sign it in
    // either. Only the licence wait a scripted sign-in would need.
    const b = { now: 'none' as OctaneState }
    const nodeB = octaneNode(b)
    const t = Date.now()
    const second = octane.setupOctane(nodeB.ssh, NODE_B).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(octane.OCTANE_LICENSE_WAIT_MS + 10_000)
    expect(await second).toBeInstanceOf(octane.OctaneLoginNeededError)
    expect(Date.now() - t).toBeLessThanOrEqual(octane.OCTANE_LICENSE_WAIT_MS + 10_000)
    expect(octane.octaneUnfit(NODE_B)).not.toBeNull()
    // The hold names the first miss, and outlives the node that missed it.
    octane.forgetOctaneNode(NODE)
    expect(octane.octaneSignInHold()).toMatchObject({ nodeId: NODE, since })

    // Someone signs in on B: the hold is over, and A may wait once more.
    b.now = 'licensed'
    expect(await octane.refreshOctaneState(nodeB.ssh, NODE_B)).toBe('licensed')
    expect(octane.octaneSignInHold()).toBeNull()
    expect(octane.octaneUnfit(NODE_B)).toBeNull()

    // Missed again, then released by the user (the job resumed): each node
    // may be waited on once more.
    const again = octane.setupOctane(nodeA.ssh, NODE).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(octane.OCTANE_LOGIN_WAIT_MS + 10_000)
    expect(await again).toBeInstanceOf(octane.OctaneLoginNeededError)
    expect(octane.octaneSignInHold()).not.toBeNull()
    octane.releaseOctaneSignInHold()
    expect(octane.octaneSignInHold()).toBeNull()
    expect(octane.octaneUnfit(NODE)).toBeNull()
    let settled = false
    const third = octane.setupOctane(nodeA.ssh, NODE).finally(() => (settled = true))
    third.catch(() => {})
    await vi.advanceTimersByTimeAsync(octane.OCTANE_LOGIN_WAIT_MS - 30_000)
    expect(settled).toBe(false)
    a.now = 'licensed'
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(third).resolves.toBe('licensed')
  })

  it('1.18 (review 2, A1): a node licensed before the miss, read again by the licence poll, does not end the hold', async () => {
    // The likely A1 night: the user signed one node in, then left. Its
    // licence, read again every 30 s, used to end the hold at the next read,
    // and the next node was rented for another 10-minute wait, with no end.
    const NODE_B = 'node-2-bbbbbbbb'
    const NODE_C = 'node-3-cccccccc'
    for (const [id, instance] of [
      [NODE_B, 2],
      [NODE_C, 3]
    ] as const) {
      h.db
        .prepare(
          `INSERT INTO nodes (id, instance_id, state, gpu_name) VALUES (?, ?, 'rendering', 'RTX 4090')`
        )
        .run(id, instance)
    }
    const b = { now: 'licensed' as OctaneState }
    const nodeB = octaneNode(b)
    await expect(octane.setupOctane(nodeB.ssh, NODE_B)).resolves.toBe('licensed')

    const waited = octane
      .setupOctane(octaneNode({ now: 'needsLogin' }).ssh, NODE)
      .catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(octane.OCTANE_LOGIN_WAIT_MS + 10_000)
    expect(await waited).toBeInstanceOf(octane.OctaneLoginNeededError)
    const hold = octane.octaneSignInHold()
    expect(hold).toMatchObject({ nodeId: NODE })

    // The licence poll reads B, licensed as it was: nobody signed in.
    for (let i = 0; i < 3; i++) {
      expect(await octane.refreshOctaneState(nodeB.ssh, NODE_B)).toBe('licensed')
      await vi.advanceTimersByTimeAsync(30_000)
    }
    expect(octane.octaneSignInHold()).toEqual(hold)
    // Nor did B's setup, run again for its next chunk.
    await expect(octane.setupOctane(nodeB.ssh, NODE_B)).resolves.toBe('licensed')
    expect(octane.octaneSignInHold()).toEqual(hold)

    // So a fresh node is not waited on for a sign-in: the licence wait only.
    const t = Date.now()
    const fresh = octane
      .setupOctane(octaneNode({ now: 'none' }).ssh, NODE_C)
      .catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(octane.OCTANE_LICENSE_WAIT_MS + 10_000)
    expect(await fresh).toBeInstanceOf(octane.OctaneLoginNeededError)
    expect(Date.now() - t).toBeLessThanOrEqual(octane.OCTANE_LICENSE_WAIT_MS + 10_000)
    expect(octane.octaneUnfit(NODE_C)).not.toBeNull()

    // B's server restarted and signed in again is a sign-in: the hold ends.
    b.now = 'none'
    expect(await octane.refreshOctaneState(nodeB.ssh, NODE_B)).toBe('none')
    b.now = 'licensed'
    expect(await octane.refreshOctaneState(nodeB.ssh, NODE_B)).toBe('licensed')
    expect(octane.octaneSignInHold()).toBeNull()
  })

  it('1.18 (review): opening the VNC login is the user acting: the hold ends, and that node may wait again', async () => {
    const a = { now: 'needsLogin' as OctaneState }
    const { ssh } = octaneNode(a)
    const waited = octane.setupOctane(ssh, NODE).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(octane.OCTANE_LOGIN_WAIT_MS + 10_000)
    expect(await waited).toBeInstanceOf(octane.OctaneLoginNeededError)
    expect(octane.octaneSignInHold()).not.toBeNull()
    vi.useRealTimers()
    await octane.openVncTunnel(ssh, NODE)
    octane.closeVncTunnel(NODE)
    expect(octane.octaneSignInHold()).toBeNull()
    expect(octane.octaneUnfit(NODE)).toBeNull()
  })

  it('1.18: the licence poll moves a node that needed a sign-in to licensed, and a dead server to none', async () => {
    const state = { now: 'needsLogin' as OctaneState }
    const { ssh } = octaneNode(state)
    h.db.prepare(`UPDATE nodes SET octane_state = 'needsLogin' WHERE id = ?`).run(NODE)
    // A restart since: the server still says serverRunning, and the app's verdict stands.
    state.now = 'serverRunning'
    expect(await octane.refreshOctaneState(ssh, NODE)).toBe('needsLogin')
    state.now = 'licensed'
    expect(await octane.refreshOctaneState(ssh, NODE)).toBe('licensed')
    expect(row()).toEqual({ octane_state: 'licensed', octane_ready: 1 })
    state.now = 'none'
    expect(await octane.refreshOctaneState(ssh, NODE)).toBe('none')
    expect(row()).toEqual({ octane_state: 'none', octane_ready: 0 })
    // A read that fails changes nothing, and does not throw.
    const silent = node(() => ({ code: 1, stdout: '', stderr: 'boom' }))
    expect(await octane.refreshOctaneState(silent.ssh, NODE)).toBeNull()
    expect(row().octane_state).toBe('none')
  })

  it('1.18 (#85): a repeat of the setup on a licensed node restarts nothing and waits for nothing', async () => {
    const state = { now: 'licensed' as OctaneState }
    const { ssh, calls } = octaneNode(state)
    await octane.setupOctane(ssh, NODE)
    const before = calls.length
    const t = Date.now()
    await expect(octane.setupOctane(ssh, NODE)).resolves.toBe('licensed')
    expect(Date.now()).toBe(t)
    expect(calls.slice(before).map((c) => c.command)).toEqual([
      'test -x /usr/local/OctaneBlender/blender',
      'chmod +x /root/vastai/octane/setup_octane.sh && bash /root/vastai/octane/setup_octane.sh install',
      'bash /root/vastai/octane/setup_octane.sh start-vnc --password-stdin',
      'bash /root/vastai/octane/setup_octane.sh start-server'
    ])
    expect(calls.map((c) => c.command).join('\n')).not.toMatch(/stop-server|-kill|pkill/)
  })

  it('1.18 (#85): no OctaneBlender on the node fails before any VNC, server or licence', async () => {
    const { ssh, calls } = node((c) =>
      /^test -x/.test(c) ? { code: 1, stdout: '', stderr: '' } : ok()
    )
    const e = await octane.setupOctane(ssh, NODE).catch((err: unknown) => err)
    expect(e).toBeInstanceOf(octane.OctaneBlenderMissingError)
    expect((e as Error).message).toMatch(/OctaneBlender is not installed on this node/)
    expect(calls.map((c) => c.opts.label)).toEqual(['check OctaneBlender'])
  })

  it('1.18 (review): no OctaneBlender is the Octane image’s fault only on a node rented from it; any other node is unfit, not the job', async () => {
    const missing = node((c) => (/^test -x/.test(c) ? { code: 1, stdout: '', stderr: '' } : ok()))
    const rentals = new Map<string, import('./octaneLicense').OctaneRentalFacts>()
    octane.setRentalFacts((id) => rentals.get(id) ?? null)

    // Rented for Cycles, or not by this session: the node's, not the job's.
    for (const rental of [{ engine: 'cycles' as const, secureCloud: false }, null]) {
      if (rental) rentals.set(NODE, rental)
      else rentals.delete(NODE)
      const e = (await octane
        .setupOctane(missing.ssh, NODE)
        .catch((err: unknown) => err)) as import('./octaneLicense').OctaneBlenderMissingError
      expect(e.octaneImage).toBe(false)
      expect(e.message).toMatch(/not installed on this node .*rented from the docker image set/)
      expect(octane.octaneUnfit(NODE)).toMatch(/OctaneBlender is not installed on this node/)
    }

    // Rented for Octane, so from the image set for it: that image lacks it.
    rentals.set(NODE, { engine: 'octane', secureCloud: false })
    const e = (await octane
      .setupOctane(missing.ssh, NODE)
      .catch((err: unknown) => err)) as import('./octaneLicense').OctaneBlenderMissingError
    expect(e.octaneImage).toBe(true)
    expect(e.message).toMatch(/the docker image set for Octane nodes has no OctaneBlender/)

    // Installed by hand since: the node is fit again.
    const { ssh } = octaneNode({ now: 'licensed' })
    await expect(octane.setupOctane(ssh, NODE)).resolves.toBe('licensed')
    expect(octane.octaneUnfit(NODE)).toBeNull()
  })

  it('1.18: a start the script could not make says why, a busy lock included', async () => {
    const busy = node((c) =>
      /start-server/.test(c)
        ? {
            code: 1,
            stdout: '',
            stderr:
              '[octane] another start-server or stop-server still running after 40s — nothing done\n'
          }
        : ok()
    )
    await expect(octane.setupOctane(busy.ssh, NODE)).rejects.toThrow(
      /^OctaneServer launch failed: another start or stop of OctaneServer is still running/
    )
    const noDisplay = node((c) =>
      /start-server/.test(c)
        ? {
            code: 1,
            stdout:
              '[octane] no X display on :0 for OctaneServer — run start-vnc first\nOCTANE_STATE none\n',
            stderr: ''
          }
        : ok()
    )
    await expect(octane.setupOctane(noDisplay.ssh, NODE)).rejects.toThrow(
      /^OctaneServer launch failed: \[octane\] no X display on :0/
    )
    const silent = node(() => ok())
    await expect(octane.setupOctane(silent.ssh, NODE)).rejects.toThrow(
      'OctaneServer launch failed: setup_octane.sh reported no state'
    )
  })

  it('1.18 (n4): a command the link dropped under is a lost connection, not a failed install', async () => {
    for (const code of [null, undefined]) {
      const { ssh } = node((c) =>
        /install/.test(c) ? ({ code, stdout: '', stderr: '' } as unknown as ExecResult) : ok()
      )
      const e = await octane.setupOctane(ssh, NODE).catch((err: Error) => err)
      expect((e as Error).name).toBe('ConnectionLostError')
      expect((e as Error).message).toBe('connection closed under install Octane')
    }
  })

  it('1.18: the wait ends when the chunk is taken back', async () => {
    const { ssh } = octaneNode({ now: 'needsLogin' })
    const stop = new AbortController()
    const setup = octane.setupOctane(ssh, NODE, { signal: stop.signal }).catch((e: Error) => e)
    await vi.advanceTimersByTimeAsync(7_000)
    stop.abort()
    await vi.advanceTimersByTimeAsync(0)
    expect(((await setup) as Error).message).toMatch(/Octane setup stopped/)
  })
})

describe('parseOctaneState', () => {
  it("1.18: reads the script's line, and nothing else", () => {
    expect(octane.parseOctaneState('[octane] x\nOCTANE_STATE needsLogin\n')).toBe('needsLogin')
    expect(octane.parseOctaneState('OCTANE_STATE serverRunning')).toBe('serverRunning')
    expect(octane.parseOctaneState('OCTANE_STATE server_running\n')).toBeNull()
    expect(octane.parseOctaneState('the log said OCTANE_STATE licensed\n')).toBeNull()
    expect(octane.asOctaneState('licensed')).toBe('licensed')
    expect(octane.asOctaneState('server_running')).toBe('none')
  })
})
