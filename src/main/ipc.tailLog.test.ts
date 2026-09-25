import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setup, type World } from './test/harness'

// logs:getTail reads a log on a node over SSH. The chunk id from the
// renderer named the file inside single quotes of its own, so a quote in it
// ended the quoting and ran the rest on the node, and a '/' or '..' read any
// file there (#159: an IPC argument is only as typed as the renderer that
// sent it).

let w: World
beforeEach(async () => {
  w = await setup()
})
afterEach(() => w.dispose())

describe('logs:getTail', () => {
  it('1.14: reads a chunk log under a quoted path, and refuses an id that is not a chunk id', async () => {
    const app = await w.boot()
    const nodeId = await w.readyNode(app)
    const machine = w.machineFor(nodeId)
    const log = '/root/vastai/logs/abc12345-1-4.log'
    machine.files.set(log, Buffer.from('one\ntwo\nthree'))

    const lines = await w.invoke('logs:getTail', { nodeId, chunkId: 'abc12345-1-4', lines: 2 })
    expect(lines.filter(Boolean)).toEqual(['two', 'three'])
    expect(machine.ran(/^tail /)).toEqual([`tail -n 2 '${log}' 2>/dev/null`])

    for (const chunkId of ["x'; echo INJECTED; '", '../../../etc/shadow', 'a/b']) {
      expect(await w.invoke('logs:getTail', { nodeId, chunkId, lines: 5 })).toEqual([])
    }
    // A line count that is not a number reads a bounded default.
    await w.invoke('logs:getTail', { nodeId, lines: Number.NaN })
    expect(machine.ran(/^tail /)).toEqual([
      `tail -n 2 '${log}' 2>/dev/null`,
      `tail -n 200 '/root/vastai/logs/agent.log' 2>/dev/null`
    ])
  })
})
