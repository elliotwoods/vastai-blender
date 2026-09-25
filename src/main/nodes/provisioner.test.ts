/**
 * provisioner.ts against the real remote/provision.sh, run under bash on a
 * stubbed node (test/remoteNode.ts): the commands the app sends, and how it
 * reads what the script says back. Plans 1.7, 1.8 and 1.9: a node brought
 * back mid-session must keep a live agent's renders, so the app has to read
 * restart-agent's verdict and agent-status's line exactly as the script
 * writes them; and every step has a deadline.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecOptions, ExecResult, SshConnection } from '../ssh/sshConnection'
import { remoteNode, type RemoteNode } from '../test/remoteNode'

const logged: string[] = []
const uploads: string[] = []

// The repo root, as the harness has it: remote/ is found there (and uploadTree is stubbed).
vi.mock('electron', () => ({
  app: { getAppPath: () => new URL('../../../', import.meta.url).pathname }
}))
vi.mock('../db/db', () => ({
  getDb: () => ({
    prepare: () => ({ get: () => undefined, run: () => undefined })
  })
}))
vi.mock('../events', () => ({
  emit: (_channel: string, e: { line: string }) => {
    logged.push(e.line)
  }
}))
vi.mock('../ssh/sftp', () => ({
  uploadTree: async (_ssh: unknown, _local: string, remote: string) => {
    uploads.push(remote)
    return 1
  }
}))

const {
  AgentBusyError,
  ConnectionLostError,
  agentAlive,
  agentStatus,
  DEPS_TIMEOUT_MS,
  INSTALL_BLENDER_TIMEOUT_MS,
  installBlender,
  parseAgentRestart,
  parseAgentStatus,
  probeEevee,
  provisionBase,
  REMOTE_ROOT,
  restartAgent,
  RESTART_AGENT_TIMEOUT_MS
} = await import('./provisioner')
const { classify } = await import('../errors')

interface Call {
  kind: 'exec' | 'execStream'
  command: string
  opts: ExecOptions
}

/**
 * An SshConnection whose node is a RemoteNode: `bash /root/vastai/provision.sh
 * <args>` runs the real script there, with its output streamed line by line
 * as ssh2 would. Anything else answers as `reply` says.
 */
class ScriptSsh {
  readonly calls: Call[] = []
  env: Record<string, string> = {}
  reply: (command: string) => ExecResult | null = () => null

  constructor(private readonly n: RemoteNode) {}

  private async run(command: string): Promise<ExecResult> {
    const scripted = this.reply(command)
    if (scripted) return scripted
    // The last `provision.sh <args>` in the command: `chmod +x … && bash … deps`.
    const m = /.*provision\.sh (.+)$/.exec(command)
    if (!m) return { code: 0, stdout: '', stderr: '' }
    const r = await this.n.provisionAsync(m[1].split(' '), { env: this.env })
    return { code: r.code, stdout: r.stdout, stderr: r.stderr }
  }

  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    this.calls.push({ kind: 'exec', command, opts })
    return this.run(command)
  }

  async execStream(
    command: string,
    onLine: (line: string) => void,
    opts: ExecOptions = {}
  ): Promise<{ stop: () => void; done: Promise<number | null> }> {
    this.calls.push({ kind: 'execStream', command, opts })
    const done = this.run(command).then((r) => {
      for (const line of r.stdout.split('\n')) if (line) onLine(line)
      return r.code
    })
    return { stop: () => {}, done }
  }

  get ssh(): SshConnection {
    return this as unknown as SshConnection
  }
}

beforeEach(() => {
  logged.length = 0
  uploads.length = 0
})

// Each test runs the script several times under bash: seconds of real time,
// more when the whole suite runs in parallel.
describe.skipIf(process.platform === 'win32')(
  'provisioner.ts with the real provision.sh',
  { timeout: 60_000 },
  () => {
    let n: RemoteNode
    let ssh: ScriptSsh
    beforeEach(() => {
      n = remoteNode()
      ssh = new ScriptSsh(n)
    })
    afterEach(() => n.dispose())

    const agentProc = (): string => `python3 ${n.vastai}/agent/noderunner.py`
    /** A node mid-render: two Blenders running and a spec queued. */
    const rendering = (): void => {
      writeFileSync(join(n.vastai, 'jobs', 'inbox', 'job1-1-10.json'), '{}')
      n.setProcs([
        { pid: 4101, name: 'blender', args: `${n.vastai}/blender/5.1.0/blender -b x.blend` },
        { pid: 4102, name: 'blender', args: `${n.vastai}/blender/5.1.0/blender -b y.blend` }
      ])
    }

    it('1.7 81fe2875: restartAgent keeps a live, current agent with its renders, and says it kept it', async () => {
      expect(await restartAgent(ssh.ssh, 'node-1')).toEqual({
        restarted: true,
        reason: 'no agent session'
      })
      rendering()

      expect(await restartAgent(ssh.ssh, 'node-1')).toEqual({ restarted: false, reason: null })
      // Nothing killed: both renders and the queued spec are still there.
      expect(n.procs().map((p) => p.pid)).toEqual([4101, 4102])
      expect(n.calls().filter((c) => c.startsWith('pkill'))).toEqual([
        // Only the first restart's, on a node with nothing running yet.
        `pkill -f ${agentProc()}`,
        `pkill -f ${n.vastai}/blender/`
      ])
    })

    it('1.7: restartAgent restarts a dead agent, and says why, so its runs can be forgotten', async () => {
      await restartAgent(ssh.ssh, 'node-1')
      rendering()
      n.age(join(n.vastai, 'state', 'heartbeat'), 300)

      const r = await restartAgent(ssh.ssh, 'node-1')
      expect(r.restarted).toBe(true)
      expect(r.reason).toMatch(/^heartbeat stale \(\d+s\)$/)
      expect(n.procs()).toEqual([])
    })

    it('1.7: agentStatus reads the line agent-status writes', async () => {
      let s = await agentStatus(ssh.ssh)
      expect(s).toMatchObject({
        agentSession: false,
        heartbeatAgeS: null,
        heartbeatStale: true,
        blenderProcs: 0,
        inboxSpecs: 0,
        restartNeeded: true,
        restartReason: 'no agent session'
      })

      await provisionBase(ssh.ssh, 'node-1')
      rendering()
      s = await agentStatus(ssh.ssh)
      expect(s).toMatchObject({
        agentCurrent: true,
        agentSession: true,
        heartbeatStale: false,
        blenderProcs: 2,
        inboxSpecs: 1,
        depsCurrent: true,
        restartNeeded: false,
        restartReason: ''
      })
      expect(s!.agentHash).toMatch(/^[0-9a-f]{64}$/)
    })

    it('1.8/1.9: provisionBase is base as its two steps, each with its own deadline and label', async () => {
      const r = await provisionBase(ssh.ssh, 'node-1')

      expect(r).toEqual({ restarted: true, reason: 'forced' })
      expect(uploads).toEqual([REMOTE_ROOT])
      expect(ssh.calls.map((c) => [c.kind, c.command.replace(/^.*&& /, ''), c.opts])).toEqual([
        [
          'execStream',
          `bash ${REMOTE_ROOT}/provision.sh deps`,
          { timeoutMs: DEPS_TIMEOUT_MS, label: 'provision.sh deps' }
        ],
        [
          'execStream',
          `bash ${REMOTE_ROOT}/provision.sh restart-agent --force`,
          { timeoutMs: RESTART_AGENT_TIMEOUT_MS, label: 'provision.sh restart-agent --force' }
        ]
      ])
      // The script's own lines reach the node's log.
      expect(logged).toContain('[provision] deps installed')
      expect(logged).toContain('AGENT_RESTARTED forced')
    })

    it('1.8: a restart-agent that finds another still running waits once more, then calls the node busy', async () => {
      ssh.env = { AGENT_LOCK_WAIT_S: '1' }
      const release = n.holdLock(join(n.vastai, 'state', 'restart-agent.lock'))
      try {
        await expect(restartAgent(ssh.ssh, 'node-1')).rejects.toBeInstanceOf(AgentBusyError)
        expect(ssh.calls.map((c) => c.command)).toEqual([
          `bash ${REMOTE_ROOT}/provision.sh restart-agent`,
          `bash ${REMOTE_ROOT}/provision.sh restart-agent`
        ])
      } finally {
        release()
      }
      // The other one done, the next restart goes ahead.
      expect(await restartAgent(ssh.ssh, 'node-1')).toMatchObject({ restarted: true })
    })

    it('1.8: an agent that dies at start-up fails restartAgent with the script’s last word', async () => {
      ssh.env = { FAKE_AGENT: 'crash' }
      await expect(restartAgent(ssh.ssh, 'node-1')).rejects.toThrow(
        /^provision\.sh restart-agent failed \(exit 1\): .*fake crash/
      )
    })
  }
)

describe('provisioner.ts, what it makes of an answer', () => {
  const stub = (reply: ExecResult): ScriptSsh => {
    const s = new ScriptSsh(null as unknown as RemoteNode)
    s.reply = () => reply
    return s
  }

  it('1.7: a restart-agent that exits 0 with no verdict counts as a restart', async () => {
    // What a provision.sh too old to know restart-agent would not do, and
    // what a lost last line would look like: the runs are forgotten.
    const s = stub({ code: 0, stdout: '[provision] starting agent…\n', stderr: '' })
    expect(await restartAgent(s.ssh, 'node-1')).toEqual({ restarted: true, reason: null })
  })

  it('1.7: agentStatus is null for a tree without agent-status, and throws when the connection went', async () => {
    const usage = stub({ code: 1, stdout: 'usage: provision.sh deps …\n', stderr: '' })
    await expect(agentStatus(usage.ssh)).resolves.toBeNull()
    const missing = stub({ code: 127, stdout: '', stderr: 'No such file' })
    await expect(agentStatus(missing.ssh)).resolves.toBeNull()
    const dropped = stub({ code: null, stdout: '', stderr: '' })
    await expect(agentStatus(dropped.ssh)).rejects.toBeInstanceOf(ConnectionLostError)
  })

  it('1.7: a restart-agent or agent-status whose connection went reads as the link lost, not a verdict', async () => {
    // What ssh2 hands back for a channel whose connection dropped: no exit
    // status. Neither the restart's outcome nor the status is known, and the
    // alert must not read "unrecognised error".
    const dropped = stub({ code: null, stdout: '', stderr: '' })
    const errors = await Promise.all([
      restartAgent(dropped.ssh, 'node-1').catch((e: unknown) => e),
      agentStatus(dropped.ssh).catch((e: unknown) => e)
    ])
    expect(dropped.calls).toHaveLength(2) // no second restart-agent on a dropped link
    for (const e of errors) {
      expect(e).toBeInstanceOf(ConnectionLostError)
      expect(classify(e, { via: 'ssh' })).toMatchObject({ kind: 'machine', rule: 'ssh-lost' })
      expect(classify(e)).toMatchObject({ rule: 'ssh-lost' })
    }
    expect((errors[0] as Error).message).toBe('connection closed under provision.sh restart-agent')
    expect((errors[1] as Error).message).toBe('connection closed under provision.sh agent-status')
  })

  it('1.8: installBlender and probeEevee each pass a deadline and a label, never command text', async () => {
    const s = stub({ code: 0, stdout: 'PROBE_OK\n', stderr: '' })
    await installBlender(s.ssh, 'node-1', '5.1.0')
    await installBlender(s.ssh, 'node-1', '5.1.0', { timeoutMs: 60_000 })
    await probeEevee(s.ssh, 'node-1', '5.1.0')
    expect(s.calls.map((c) => c.opts)).toEqual([
      { timeoutMs: INSTALL_BLENDER_TIMEOUT_MS, label: 'install blender 5.1.0' },
      { timeoutMs: 60_000, label: 'install blender 5.1.0' },
      { timeoutMs: 120_000, label: 'EEVEE probe 5.1.0' }
    ])
  })

  it('parses the verdict from the last line only', () => {
    expect(parseAgentRestart(['[provision] …', 'AGENT_KEPT', ''])).toEqual({
      restarted: false,
      reason: null
    })
    expect(parseAgentRestart(['AGENT_RESTARTED agent code changed'])).toEqual({
      restarted: true,
      reason: 'agent code changed'
    })
    // A verdict followed by anything else is not the script's last word.
    expect(parseAgentRestart(['AGENT_KEPT', '[provision] something after'])).toBeNull()
    expect(parseAgentRestart([])).toBeNull()
  })

  it('refuses a status line without what the app decides on', () => {
    expect(parseAgentStatus('')).toBeNull()
    expect(parseAgentStatus('{not json')).toBeNull()
    expect(parseAgentStatus('{"restartNeeded":false,"blenderProcs":1}')).toBeNull()
    expect(
      parseAgentStatus('noise\n{"restartNeeded":false,"blenderProcs":1,"inboxSpecs":0}\n')
    ).toMatchObject({ restartNeeded: false, blenderProcs: 1, inboxSpecs: 0, heartbeatStale: true })
  })
})

describe.skipIf(process.platform === 'win32')('agentAlive', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'vr-agent-alive-'))
    mkdirSync(join(home, 'state'))
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  /** Runs the check the app sends under bash, against `home` as the node's ~/vastai. */
  const onNode = (): ScriptSsh => {
    const s = new ScriptSsh(null as unknown as RemoteNode)
    s.reply = (command) => {
      const r = spawnSync('bash', ['-c', command.split(REMOTE_ROOT).join(home)], {
        encoding: 'utf8'
      })
      return { code: r.status, stdout: r.stdout, stderr: r.stderr }
    }
    return s
  }
  const beatAgo = (seconds: number): void => {
    const p = join(home, 'state', 'heartbeat')
    writeFileSync(p, '')
    const t = Date.now() / 1000 - seconds
    utimesSync(p, t, t)
  }

  it('1.7: an agent is dead past provision.sh’s 60 s, as the supervisor and restart-agent judge it', async () => {
    beatAgo(45)
    expect(await agentAlive(onNode().ssh)).toBe(true)
    beatAgo(75)
    expect(await agentAlive(onNode().ssh)).toBe(false)
    rmSync(join(home, 'state', 'heartbeat'))
    expect(await agentAlive(onNode().ssh)).toBe(false)
  })

  it('1.7: a check that never ran is not a dead agent', async () => {
    const dropped = new ScriptSsh(null as unknown as RemoteNode)
    dropped.reply = () => ({ code: null, stdout: '', stderr: '' })
    await expect(agentAlive(dropped.ssh)).rejects.toThrow(/did not answer/)
    expect(dropped.calls[0].opts).toEqual({ timeoutMs: 30_000, label: 'agent heartbeat' })
  })
})
