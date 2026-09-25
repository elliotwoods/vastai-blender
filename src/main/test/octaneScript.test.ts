/**
 * remote/octane/setup_octane.sh, run under bash on a stubbed node
 * (remoteNode.ts). Plan 1.18: OTOY credentials reach OctaneServer on stdin
 * only, never argv, the environment or a file; a repeated setup never kills
 * the VNC session a user may be signing in on, nor launches a second server
 * (a second floating license); `status` reads the license from the server's
 * log with failure patterns first; stop-server stops every server and only
 * servers.
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OctaneState } from '../../shared/models'
import { remoteNode, type RemoteNode } from './remoteNode'

// Every character a password can hold that a careless read would mangle:
// spaces at both ends, a backslash, quotes, a $ and a glob.
const USER = 'render-farm@example.com'
const PASS = ` p@ss w'rd\\n"$HOME"* `

// The app writes the state word of an OCTANE_STATE line to nodes.octane_state
// as it is, so the script must spell every OctaneState exactly, and nothing
// else. `satisfies` makes the typecheck fail if the two lists drift apart.
const OCTANE_STATES = {
  none: true,
  serverRunning: true,
  licensed: true,
  needsLogin: true
} satisfies Record<OctaneState, true>

/** The state an OCTANE_STATE line reports, checked against OctaneState. */
function octaneState(stdout: string): OctaneState {
  const lines = [...stdout.matchAll(/^OCTANE_STATE (.*)$/gm)]
  expect(lines, stdout).toHaveLength(1)
  const s = lines[0][1]
  expect(Object.keys(OCTANE_STATES)).toContain(s)
  return s as OctaneState
}

// Each test runs the script under bash, several times: seconds of real time,
// more when the whole suite runs in parallel (as provisioner.test.ts).
describe.skipIf(process.platform === 'win32')('setup_octane.sh', { timeout: 60_000 }, () => {
  let n: RemoteNode
  beforeEach(() => {
    n = remoteNode({ provisioned: true })
  })
  afterEach(() => n.dispose())

  const pidfile = (): string => join(n.vastai, 'state', 'octane-server.pid')
  const serverLog = (): string => join(n.vastai, 'logs', 'octane-server.log')
  const lockfile = (): string => join(n.vastai, 'state', 'octane-server.lock')
  const serverPid = (): number => Number(readFileSync(pidfile(), 'utf8').split('\n')[0])
  const state = (): OctaneState => {
    const r = n.octane(['status'])
    expect(r.code).toBe(0)
    expect(r.stdout.split('\n').filter(Boolean)).toHaveLength(1)
    return octaneState(r.stdout)
  }
  const vnc = (password = 'vncpw123'): void => {
    const r = n.octane(['start-vnc', password])
    expect(r.code, r.stdout + r.stderr).toBe(0)
  }
  const launches = (): string[] => n.calls().filter((c) => /^OctaneServer(?! --help)/.test(c))
  /** The pid TightVNC's vncserver wrote for display :0. */
  const vncPidFile = (): string =>
    join(
      n.home,
      '.vnc',
      readdirSync(join(n.home, '.vnc')).find((f) => f.endsWith(':0.pid'))!
    )

  it('1.18: scripted sign-in credentials go on stdin to the server, never argv, env or disk', () => {
    vnc()
    const r = n.octane(['start-server', '--credentials-stdin'], { input: `${USER}\n${PASS}\n` })
    expect(r.code, r.stdout + r.stderr).toBe(0)

    const [launch] = n.octaneLaunches()
    // Delivered intact: IFS= read -r keeps the edge spaces and the backslash.
    expect(launch.stdin).toEqual([USER, PASS])
    expect(octaneState(r.stdout)).toBe('serverRunning')
    expect(launch.argv).toEqual([])
    expect(launch.env).not.toContain(PASS)
    expect(launch.env).not.toContain(USER)
    // Nothing the scripts wrote on the node holds them, nor their output.
    expect(n.filesContaining(n.home, PASS)).toEqual([])
    expect(n.filesContaining(n.home, USER)).toEqual([])
    expect(r.stdout + r.stderr).not.toContain(PASS)
  })

  it('1.18: credentials an older app sends in the environment never reach the server', () => {
    vnc()
    const r = n.octane(['start-server'], { env: { OCTANE_USER: USER, OCTANE_PASS: PASS } })
    expect(r.code, r.stdout + r.stderr).toBe(0)

    const [launch] = n.octaneLaunches()
    expect(launch.argv.join(' ')).not.toContain(PASS)
    expect(launch.env).not.toContain(PASS)
    expect(launch.env).not.toContain('OCTANE_')
    expect(launch.stdin).toEqual(['', ''])
  })

  it('1.18: start-server without credentials leaves the sign-in to VNC', () => {
    vnc()
    const r = n.octane(['start-server'])
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/sign in by hand over VNC/)
    expect(n.octaneLaunches()[0].stdin).toEqual(['', ''])
  })

  it('1.18: a repeated setup never launches a second OctaneServer (a second license)', () => {
    vnc()
    expect(n.octane(['start-server']).code).toBe(0)
    const pid = serverPid()
    appendFileSync(serverLog(), 'License acquired\n')

    const again = n.octane(['start-server', '--credentials-stdin'], { input: `${USER}\n${PASS}\n` })
    expect(again.code).toBe(0)
    expect(launches()).toHaveLength(1)
    expect(serverPid()).toBe(pid)
    expect(n.alive(pid)).toBe(true)
    expect(again.stdout).toMatch(/already running/)
    // It reports the live server's state, and its log was not truncated.
    expect(octaneState(again.stdout)).toBe('licensed')
  })

  it('1.18: two setups that overlap launch one OctaneServer (one license)', async () => {
    vnc()
    // Both are under way before either can look for a server: the app's
    // prep deadline gave up on the first exec while it still ran here.
    const release = n.holdLock(lockfile())
    const first = n.octaneAsync(['start-server'])
    const second = n.octaneAsync(['start-server'])
    await new Promise((r) => setTimeout(r, 300))
    release()
    const results = await Promise.all([first, second])

    for (const r of results) expect(r.code, r.stdout + r.stderr).toBe(0)
    expect(launches()).toHaveLength(1)
    expect(results.filter((r) => /already running/.test(r.stdout))).toHaveLength(1)
  })

  it('1.18: start-server and stop-server wait for one already running; the server holds no lock', () => {
    const release = n.holdLock(lockfile())
    const quick = { env: { OCTANE_LOCK_WAIT_S: '1' } }
    vnc()
    const start = n.octane(['start-server'], quick)
    expect(start.code).toBe(1)
    expect(start.stderr).toMatch(/still running after 1s/)
    expect(launches()).toHaveLength(0)
    expect(n.octane(['stop-server'], quick).code).toBe(1)
    release()

    expect(n.octane(['start-server'], quick).code).toBe(0)
    // The server outlives the script that launched it, and must not keep its
    // lock: the next setup, and the stop on destroy, would wait on it forever.
    const again = n.octane(['start-server'], quick)
    expect(again.code, again.stdout + again.stderr).toBe(0)
    expect(again.stdout).toMatch(/already running/)
    expect(n.octane(['stop-server'], quick).stdout).toMatch(/^OCTANE_STOPPED clean$/m)
  })

  it('1.18: a server the pidfile lost is adopted, not duplicated', () => {
    vnc()
    expect(n.octane(['start-server']).code).toBe(0)
    const pid = serverPid()
    // What earlier builds left behind: a second launch overwrote the pidfile.
    writeFileSync(pidfile(), '')
    n.setProcs([{ pid, name: 'OctaneServer', args: 'OctaneServer' }])

    const r = n.octane(['start-server'])
    expect(r.code).toBe(0)
    expect(launches()).toHaveLength(1)
    expect(serverPid()).toBe(pid)
    expect(r.stdout).toMatch(/adopted/)
  })

  it('1.18: start-server refuses without a display rather than launching a GUI into nothing', () => {
    const r = n.octane(['start-server'])
    expect(r.code).toBe(1)
    expect(octaneState(r.stdout)).toBe('none')
    expect(launches()).toHaveLength(0)
  })

  it('1.18: start-vnc never kills a running VNC, but the new password takes effect', () => {
    vnc('first123')
    const vncPid = Number(readFileSync(vncPidFile(), 'utf8'))
    expect(n.alive(vncPid)).toBe(true)

    const r = n.octane(['start-vnc', '--password-stdin'], { input: 'second12\n' })
    expect(r.code).toBe(0)
    expect(n.calls().filter((c) => c.startsWith('vncserver'))).toEqual([
      expect.stringMatching(/^vncserver :0 -localhost/)
    ])
    expect(n.alive(vncPid)).toBe(true)
    expect(r.stdout).toMatch(/VNC already running on :0/)
    // Xvnc reads the password file at each authentication.
    expect(readFileSync(join(n.home, '.vnc', 'passwd'), 'utf8')).toBe('enc(second12)')
  })

  it('1.18: start-vnc refuses a :0 held by an X server that is not VNC', () => {
    // Some images run their own Xvfb on :0. Taken for a running VNC, nothing
    // would listen on 5900 for the sign-in while the app believed VNC was up.
    const xvfb = n.spawnBystander('Xvfb')
    writeFileSync(join(n.xtmp, '.X0-lock'), `${String(xvfb).padStart(10)}\n`)
    const r = n.octane(['start-vnc', 'vncpw123'])
    expect(r.code).not.toBe(0)
    expect(r.stderr).toMatch(/not VNC/)
    expect(r.stdout).not.toMatch(/VNC already running/)
    expect(n.calls().filter((c) => c.startsWith('vncserver'))).toEqual([])
    expect(n.alive(xvfb)).toBe(true)
    // It is still a display OctaneServer can run in.
    expect(n.octane(['start-server']).code).toBe(0)
  })

  it('1.18: a VNC that died is started again', () => {
    vnc()
    const vncPid = Number(readFileSync(vncPidFile(), 'utf8'))
    process.kill(vncPid, 'SIGKILL')
    for (let i = 0; i < 100 && n.alive(vncPid); i++) spawnSync('sleep', ['0.05'])
    vnc()
    expect(n.calls().filter((c) => /^vncserver :0/.test(c))).toHaveLength(2)
  })

  it('1.18: status reads the last license line, failure patterns first', () => {
    expect(state()).toBe('none')
    vnc()
    expect(n.octane(['start-server']).code).toBe(0)
    expect(state()).toBe('serverRunning')

    // The old check matched /acquir|success|.../ first and called this licensed.
    appendFileSync(serverLog(), 'ERROR: Failed to acquire license\n')
    expect(state()).toBe('needsLogin')
    appendFileSync(serverLog(), 'Octane is not activated\n')
    expect(state()).toBe('needsLogin')

    // A sign-in by hand over VNC after the failure: the latest line wins.
    appendFileSync(serverLog(), 'Successfully logged in as render-farm@example.com\n')
    expect(state()).toBe('licensed')

    // Lines that say nothing about the license change nothing.
    appendFileSync(serverLog(), 'render node connected from 127.0.0.1\n')
    expect(state()).toBe('licensed')

    appendFileSync(serverLog(), 'License expired\n')
    expect(state()).toBe('needsLogin')

    // A success word inside a failure line is still a failure.
    appendFileSync(serverLog(), 'License acquired\nlogin failed: invalid password\n')
    expect(state()).toBe('needsLogin')
  })

  it('1.18: a success line that does not name the license never reads as licensed', () => {
    vnc()
    expect(n.octane(['start-server']).code).toBe(0)
    appendFileSync(serverLog(), 'ERROR: Failed to acquire license\n')
    expect(state()).toBe('needsLogin')

    // Device and module lines a GPU server logs after a failed sign-in. Were
    // any of them read as the license, Octane chunks would go to a node where
    // every render fails, and it would bill all the while.
    appendFileSync(
      serverLog(),
      [
        'CUDA device 0 activated successfully',
        'OptiX denoiser module has been activated',
        'Network rendering is activated',
        'Activation successful',
        'Authentication successful for render node 127.0.0.1',
        'Device RTX 4090 successfully activated'
      ].join('\n') + '\n'
    )
    expect(state()).toBe('needsLogin')

    // Nor on a server that has logged nothing about its license yet.
    expect(n.octane(['stop-server']).code).toBe(0)
    expect(n.octane(['start-server']).code).toBe(0)
    appendFileSync(serverLog(), 'CUDA device 0 activated successfully\n')
    expect(state()).toBe('serverRunning')

    // A line that names the license does count.
    appendFileSync(serverLog(), 'License activation successful\n')
    expect(state()).toBe('licensed')
  })

  it('1.18: stop-server stops the server cleanly and forgets it', () => {
    vnc()
    expect(n.octane(['start-server']).code).toBe(0)
    const pid = serverPid()

    const r = n.octane(['stop-server'])
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/^OCTANE_STOPPED clean$/m)
    expect(n.alive(pid)).toBe(false)
    expect(existsSync(pidfile())).toBe(false)
    expect(state()).toBe('none')
    expect(n.octane(['stop-server']).stdout).toMatch(/^OCTANE_STOPPED none$/m)
  })

  it('1.18: stop-server also stops a server the pidfile lost, so its license is released', () => {
    vnc()
    expect(n.octane(['start-server']).code).toBe(0)
    const pid = serverPid()
    writeFileSync(pidfile(), '')
    n.setProcs([{ pid, name: 'OctaneServer', args: 'OctaneServer' }])

    expect(n.octane(['stop-server']).stdout).toMatch(/^OCTANE_STOPPED clean$/m)
    expect(n.alive(pid)).toBe(false)
  })

  it('1.18: stop-server never signals a process that merely inherited the pidfile pid', () => {
    // The server died; the kernel gave its pid to something else (a render,
    // the agent). A pidfile from before start times were kept names only a pid.
    const bystander = n.spawnBystander()
    writeFileSync(pidfile(), `${bystander}\n`)
    expect(n.octane(['stop-server']).stdout).toMatch(/^OCTANE_STOPPED none$/m)
    expect(n.alive(bystander)).toBe(true)

    // A current pidfile whose recorded start time is not the process's.
    writeFileSync(pidfile(), `${bystander}\nThu Jan 1 00:00:00 1970\n`)
    expect(n.octane(['stop-server']).stdout).toMatch(/^OCTANE_STOPPED none$/m)
    expect(n.alive(bystander)).toBe(true)
    expect(state()).toBe('none')
  })

  it('1.18: a server that crashed into a zombie is launched again, not left "running"', () => {
    vnc()
    // What a crashed OctaneServer leaves in a container whose PID 1 never
    // reaps: kill -0 still succeeds, the start time still matches, and pgrep
    // still lists it.
    const zombie = n.spawnZombie()
    const lstart = spawnSync('ps', ['-p', String(zombie), '-o', 'lstart='], { encoding: 'utf8' })
    writeFileSync(pidfile(), `${zombie}\n${lstart.stdout.trim().replace(/\s+/g, ' ')}\n`)
    writeFileSync(serverLog(), 'License acquired\n')
    n.setProcs([{ pid: zombie, name: 'OctaneServer', args: 'OctaneServer' }])

    // Not licensed: nothing is running to hold the license.
    expect(state()).toBe('none')
    const r = n.octane(['start-server'])
    expect(r.code, r.stdout + r.stderr).toBe(0)
    expect(launches()).toHaveLength(1)
    expect(serverPid()).not.toBe(zombie)
    expect(r.stdout).not.toMatch(/already running|adopted/)
  })

  it('1.18: stop-server does not wait out its 30 s on a zombie', () => {
    const zombie = n.spawnZombie()
    writeFileSync(pidfile(), `${zombie}\n`)
    n.setProcs([{ pid: zombie, name: 'OctaneServer', args: 'OctaneServer' }])
    const t0 = Date.now()
    expect(n.octane(['stop-server']).stdout).toMatch(/^OCTANE_STOPPED none$/m)

    // A server that exits on SIGTERM but that nobody reaps has stopped.
    const server = n.spawnUnreaped()
    n.setProcs([{ pid: server, name: 'OctaneServer', args: 'OctaneServer' }])
    expect(n.octane(['stop-server']).stdout).toMatch(/^OCTANE_STOPPED clean$/m)
    expect(Date.now() - t0).toBeLessThan(4_000)
  })

  it('1.18: install runs apt once; a repeated setup skips it', () => {
    expect(n.octane(['install']).code).toBe(0)
    expect(n.octane(['install']).stdout).toMatch(/already installed/)
    expect(n.calls().filter((c) => c === 'apt-get update -qq')).toHaveLength(1)
  })
})
