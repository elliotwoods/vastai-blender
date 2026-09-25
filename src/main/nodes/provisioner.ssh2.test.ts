/**
 * provisioner.ts over the real SshConnection and a stand-in for ssh2 itself
 * (test/fakeSsh2.ts), for what the lifecycle harness cannot show: how a
 * command that ends without an exit status reaches the provisioner. ssh2
 * 1.17 closes the channel of a connection that went with no exit status at
 * all (`close` with undefined: Channel._exit.code starts undefined, and only
 * an exit-signal sets it null), and SshConnection passes that on as it is.
 * The harness's FakeSshConnection hands back null instead, so every scenario
 * there passed while, against real ssh2, a link that dropped under
 * restart-agent read as the restart failing with a verdict, and the node
 * that had just come back was destroyed for it (plan 1.7).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ssh2 } from '../test/fakeSsh2'
import { SshConnection } from '../ssh/sshConnection'

vi.mock('ssh2', () => import('../test/fakeSsh2'))
vi.mock('electron', () => ({ app: { getAppPath: () => '/nonexistent' } }))
vi.mock('../db/db', () => ({
  getDb: () => ({ prepare: () => ({ get: () => undefined, run: () => undefined }) })
}))
vi.mock('../events', () => ({ emit: () => {} }))
vi.mock('../ssh/sftp', () => ({ uploadTree: async () => 1 }))

const { agentAlive, agentStatus, ConnectionLostError, provisionDeps, restartAgent } =
  await import('./provisioner')
const { classify } = await import('../errors')

beforeEach(() => ssh2.reset())

function connection(): SshConnection {
  return new SshConnection({
    host: '10.0.0.1',
    port: 22,
    username: 'root',
    privateKey: Buffer.from('test key'),
    pinnedHostKey: null
  })
}

/** Let the fake ssh2's microtask replies land. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

/**
 * Run `call` until its command's channel is open, then end that channel as
 * ssh2 ends one whose connection went: `close` with no exit status.
 */
async function dropUnder<T>(pattern: RegExp, call: Promise<T>): Promise<unknown> {
  const outcome = call.then(
    (v) => v,
    (e: unknown) => e
  )
  await flush()
  const [channel] = ssh2.execsOf(pattern)
  expect(channel, `a channel for ${pattern}`).toBeDefined()
  channel.write('[provision] …\n')
  channel.exit(undefined)
  return outcome
}

describe('1.7: a command whose connection went, over the real SshConnection', () => {
  it('1.7: a restart-agent whose connection went is the link lost, not a failed restart', async () => {
    const ssh = connection()
    const e = await dropUnder(/restart-agent$/, restartAgent(ssh, 'node-1'))
    expect(e).toBeInstanceOf(ConnectionLostError)
    expect((e as Error).message).toBe('connection closed under provision.sh restart-agent')
    expect(classify(e, { via: 'ssh' })).toMatchObject({ kind: 'machine', rule: 'ssh-lost' })
    // One run: nothing is retried on a link that went.
    expect(ssh2.execsOf(/restart-agent/)).toHaveLength(1)
  })

  it('1.7: an agent-status whose connection went is the link lost, not a tree without agent-status', async () => {
    // Read as null, it sent the node through the whole of onReady, whose
    // restart-agent --force killed every live render on it.
    const e = await dropUnder(/agent-status$/, agentStatus(connection()))
    expect(e).toBeInstanceOf(ConnectionLostError)
    expect((e as Error).message).toBe('connection closed under provision.sh agent-status')
  })

  it('1.7: a provision.sh step whose connection went fails reading "(exit null)"', async () => {
    // What errors.ts's node-setup rule and admission.ts's breaker key read as
    // the link lost rather than the step's own failure.
    const e = await dropUnder(/provision\.sh deps$/, provisionDeps(connection(), 'node-1'))
    expect((e as Error).message).toBe('provision.sh deps failed (exit null)')
  })

  it('1.7: a heartbeat check whose connection went is no answer, not a dead agent', async () => {
    const e = await dropUnder(/state\/heartbeat/, agentAlive(connection()))
    expect((e as Error).message).toBe('agent heartbeat check did not answer (exit null)')
  })

  it('an answer that did arrive is still read as one', async () => {
    const ssh = connection()
    const status = agentStatus(ssh)
    await flush()
    const [channel] = ssh2.execsOf(/agent-status$/)
    channel.write('{"restartNeeded":false,"blenderProcs":2,"inboxSpecs":0}\n')
    channel.exit(0)
    await expect(status).resolves.toMatchObject({ restartNeeded: false, blenderProcs: 2 })
  })
})
