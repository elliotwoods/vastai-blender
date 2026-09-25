/**
 * setupOctane's commands (plan 1.8): each has a deadline, since it runs
 * inside the scheduler's per-node prep lock, and a label, which is what an
 * error names instead of the command text, which can carry OTOY credentials.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecOptions, ExecResult, SshConnection } from '../ssh/sshConnection'

const alerts: string[] = []
const secrets: Record<string, string> = {}

vi.mock('../db/db', () => ({
  getDb: () => ({ prepare: () => ({ run: () => undefined }) })
}))
vi.mock('../events', () => ({
  emit: (channel: string, e: { message?: string }) => {
    if (channel === 'alert' && e.message) alerts.push(e.message)
  }
}))
vi.mock('../settings', () => ({ getSecret: (k: string) => secrets[k] ?? null }))
vi.mock('../nodes/provisioner', () => ({ REMOTE_ROOT: '/root/vastai' }))

const { setupOctane } = await import('./octaneLicense')

interface Call {
  command: string
  opts: ExecOptions
}

/**
 * An SshConnection whose exec answers `reply(command)`, or never answers
 * when it returns null; like the real one, a call with a deadline then
 * fails at it.
 */
function node(reply: (command: string) => ExecResult | null): {
  ssh: SshConnection
  calls: Call[]
} {
  const calls: Call[] = []
  const exec = (command: string, opts: ExecOptions = {}): Promise<ExecResult> => {
    calls.push({ command, opts })
    const r = reply(command)
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
  return { ssh: { exec } as unknown as SshConnection, calls }
}

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' })

beforeEach(() => {
  alerts.length = 0
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  for (const k of Object.keys(secrets)) delete secrets[k]
})

describe('setupOctane', () => {
  it('1.8: every command has a deadline and a label, and no label carries the credentials', async () => {
    secrets.otoyUsername = 'artist@example.com'
    secrets.otoyPassword = 'hunter2'
    const { ssh, calls } = node((c) => (c.includes('grep') ? ok('License acquired') : ok()))

    await setupOctane(ssh, 'node-1')

    expect(calls.map((c) => c.opts.label)).toEqual([
      'install Octane',
      'start VNC',
      'start OctaneServer',
      'read OctaneServer log'
    ])
    for (const c of calls) expect(c.opts.timeoutMs).toBeGreaterThan(0)
    expect(JSON.stringify(calls.map((c) => c.opts))).not.toMatch(/hunter2|artist@/)
    expect(alerts).toEqual([])
  })

  it('1.8: a log read that never answers ends at the licence wait, not never', async () => {
    const { ssh } = node((c) => (c.includes('grep') ? null : ok()))
    let done = false
    const setup = setupOctane(ssh, 'node-1').then(() => {
      done = true
    })

    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect(done).toBe(true)
    await setup
    expect(alerts.join('\n')).toMatch(/Octane license not confirmed/)
  })
})
