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
import { remoteNode, type RemoteNode } from './remoteNode'

// Every character a password can hold that a careless read would mangle:
// spaces at both ends, a backslash, quotes, a $ and a glob.
const USER = 'render-farm@example.com'
const PASS = ` p@ss w'rd\\n"$HOME"* `

describe.skipIf(process.platform === 'win32')('setup_octane.sh', () => {
  let n: RemoteNode
  beforeEach(() => {
    n = remoteNode({ provisioned: true })
  })
  afterEach(() => n.dispose())

  const pidfile = (): string => join(n.vastai, 'state', 'octane-server.pid')
  const serverLog = (): string => join(n.vastai, 'logs', 'octane-server.log')
  const serverPid = (): number => Number(readFileSync(pidfile(), 'utf8').split('\n')[0])
  const state = (): string => {
    const r = n.octane(['status'])
    expect(r.code).toBe(0)
    return r.stdout.trim()
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
    expect(r.stdout).toMatch(/^OCTANE_STATE server_running$/m)
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
    appendFileSync(serverLog(), 'Activation successful\n')

    const again = n.octane(['start-server', '--credentials-stdin'], { input: `${USER}\n${PASS}\n` })
    expect(again.code).toBe(0)
    expect(launches()).toHaveLength(1)
    expect(serverPid()).toBe(pid)
    expect(n.alive(pid)).toBe(true)
    expect(again.stdout).toMatch(/already running/)
    // It reports the live server's state, and its log was not truncated.
    expect(again.stdout).toMatch(/^OCTANE_STATE licensed$/m)
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
    expect(r.stdout).toMatch(/^OCTANE_STATE none$/m)
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

  it('1.18: a VNC that died is started again', () => {
    vnc()
    const vncPid = Number(readFileSync(vncPidFile(), 'utf8'))
    process.kill(vncPid, 'SIGKILL')
    for (let i = 0; i < 100 && n.alive(vncPid); i++) spawnSync('sleep', ['0.05'])
    vnc()
    expect(n.calls().filter((c) => /^vncserver :0/.test(c))).toHaveLength(2)
  })

  it('1.18: status reads the last license line, failure patterns first', () => {
    expect(state()).toBe('OCTANE_STATE none')
    vnc()
    expect(n.octane(['start-server']).code).toBe(0)
    expect(state()).toBe('OCTANE_STATE server_running')

    // The old check matched /acquir|success|.../ first and called this licensed.
    appendFileSync(serverLog(), 'ERROR: Failed to acquire license\n')
    expect(state()).toBe('OCTANE_STATE needs_login')
    appendFileSync(serverLog(), 'Octane is not activated\n')
    expect(state()).toBe('OCTANE_STATE needs_login')

    // A sign-in by hand over VNC after the failure: the latest line wins.
    appendFileSync(serverLog(), 'Activation successful\n')
    expect(state()).toBe('OCTANE_STATE licensed')

    // Lines that say nothing about the license change nothing.
    appendFileSync(serverLog(), 'render node connected from 127.0.0.1\n')
    expect(state()).toBe('OCTANE_STATE licensed')

    appendFileSync(serverLog(), 'License expired\n')
    expect(state()).toBe('OCTANE_STATE needs_login')

    // A success word inside a failure line is still a failure.
    appendFileSync(serverLog(), 'Activation successful\nlogin failed: invalid password\n')
    expect(state()).toBe('OCTANE_STATE needs_login')
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
    expect(state()).toBe('OCTANE_STATE none')
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
    expect(state()).toBe('OCTANE_STATE none')
  })

  it('1.18: install runs apt once; a repeated setup skips it', () => {
    expect(n.octane(['install']).code).toBe(0)
    expect(n.octane(['install']).stdout).toMatch(/already installed/)
    expect(n.calls().filter((c) => c === 'apt-get update -qq')).toHaveLength(1)
  })
})
