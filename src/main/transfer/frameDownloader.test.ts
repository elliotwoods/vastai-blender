import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SshConnection } from '../ssh/sshConnection'
import { REMOTE_ROOT } from '../test/fakeSsh'
import { setup, type FakeMachine, type World } from '../test/harness'
import type { ChunkDownloader, DrainResult } from './frameDownloader'

// The final download pass on its own: a real ChunkDownloader against a fake
// node's manifest, with the manifest read broken in the ways a busy or dying
// node breaks it. What must hold is that a read that did not happen is never
// mistaken for a manifest with nothing left in it.

let w: World
beforeEach(async () => {
  w = await setup()
})
afterEach(() => w.dispose())

interface Rig {
  jobId: string
  chunkId: string
  machine: FakeMachine
  downloader: ChunkDownloader
}

/** A job (frames 1-4, one chunk) and a downloader for its chunk on a fresh fake node. */
async function rig(): Promise<Rig> {
  const app = await w.boot({ start: false })
  const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 4, chunkSize: 4 })
  const [{ id: chunkId }] = w.all<{ id: string }>('SELECT id FROM chunks WHERE job_id = ?', jobId)
  const inst = w.vast.addInstance()
  const machine = w.vast.machine(inst.id)
  const [ep] = machine.endpoints
  // The mocked class, as the scheduler gets it.
  const ssh = await import('../ssh/sshConnection')
  const conn: SshConnection = new ssh.SshConnection({
    host: ep.host,
    port: ep.port,
    username: 'root',
    privateKey: Buffer.from('harness private key'),
    pinnedHostKey: null
  })
  const { ChunkDownloader } = await import('./frameDownloader')
  const downloader = new ChunkDownloader({
    jobId,
    chunkId,
    nodeId: 'node-under-test',
    ssh: conn,
    remoteChunkDir: `${REMOTE_ROOT}/renders/${chunkId}`
  })
  return { jobId, chunkId, machine, downloader }
}

/** drain() to completion on the fake clock. */
async function drain(r: Rig): Promise<DrainResult> {
  let out: DrainResult | null = null
  void r.downloader.drain().then((d) => (out = d))
  await w.until(() => out !== null, 'drain returns')
  return out!
}

function downloaded(jobId: string): number[] {
  return w
    .all<{ frame: number }>(
      "SELECT frame FROM frames WHERE job_id = ? AND state = 'downloaded' ORDER BY frame",
      jobId
    )
    .map((f) => f.frame)
}

const manifest = /manifest\.jsonl/

describe('ChunkDownloader.drain', () => {
  it('retries a final manifest read that throws, then fetches what it lists', async () => {
    const r = await rig()
    r.machine.agent.render(r.chunkId, [1, 2, 3, 4])
    // "Channel open failure" is what execChannel gives up with once the node's
    // session cap has held for its whole retry budget.
    r.machine.onExec(manifest, () => Promise.reject(new Error('(SSH) Channel open failure')), 2)

    const result = await drain(r)

    expect(r.machine.ran(manifest)).toHaveLength(3)
    expect(result).toEqual({ manifestRead: true, lost: [] })
    expect(downloaded(r.jobId)).toEqual([1, 2, 3, 4])
  })

  it('treats a read whose channel closed (exit null) as failed, not as an empty manifest', async () => {
    const r = await rig()
    r.machine.agent.render(r.chunkId, [1, 2, 3, 4])
    // ssh2 resolves, rather than rejects, when the channel closes under a
    // command: exit null and whatever output had arrived.
    r.machine.onExec(manifest, { code: null, stdout: '' }, 1)

    const result = await drain(r)

    expect(result.manifestRead).toBe(true)
    expect(downloaded(r.jobId)).toEqual([1, 2, 3, 4])
  })

  it('reports a manifest it never managed to read as unread, not as nothing lost', async () => {
    const r = await rig()
    r.machine.agent.render(r.chunkId, [1, 2, 3, 4])
    r.machine.onExec(manifest, () => Promise.reject(new Error('exec timeout after 30000ms')))
    const started = Date.now()

    const result = await drain(r)

    expect(result.manifestRead).toBe(false)
    expect(r.machine.ran(manifest).length).toBeGreaterThan(1)
    // A few tries over tens of seconds, not the whole ten-minute budget.
    expect(Date.now() - started).toBeLessThan(2 * 60_000)
    expect(downloaded(r.jobId)).toEqual([])
  })

  it('takes a manifest the agent has not written yet as read and empty, without retrying', async () => {
    const r = await rig()
    const started = Date.now()

    // cat exits 1 with nothing on stdout: a chunk that failed before its first frame.
    const result = await drain(r)

    expect(result).toEqual({ manifestRead: true, lost: [] })
    expect(r.machine.ran(manifest)).toHaveLength(1)
    expect(Date.now()).toBe(started)
  })

  it('returns at once when stopped mid-drain, without waiting out the retries', async () => {
    const r = await rig()
    r.machine.onExec(manifest, () => Promise.reject(new Error('(SSH) Channel open failure')))
    let out: DrainResult | null = null
    void r.downloader.drain().then((d) => (out = d))
    await w.until(() => r.machine.ran(manifest).length === 1, 'first read failed')

    r.downloader.stop()
    await w.until(() => out !== null, 'drain returns')

    // Only the backoff already under way; no read after the stop.
    expect(r.machine.ran(manifest)).toHaveLength(1)
  })
})
