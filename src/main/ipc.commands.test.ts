import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setup, type World } from './test/harness'

// The shared command layer (commands/registry.ts): the job and queue IPC
// channels check their arguments before anything runs, and main/api runs the
// same commands. A malformed argument is refused "bad_request: …" and
// changes nothing; a domain refusal keeps the words the renderer shows.

let w: World
beforeEach(async () => {
  w = await setup()
  await w.boot({ start: false })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(async () => {
  vi.restoreAllMocks()
  await w.dispose()
})

/** Invoke with arguments the contract does not allow, as a broken or hostile caller could. */
function invokeRaw(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = w.ipcHandlers.get(channel)
  if (!handler) throw new Error(`no handler for ${channel}`)
  return Promise.resolve(handler({}, ...args))
}

describe('job and queue channels refuse bad arguments', () => {
  it.each([
    ['job:cancel', [42]],
    ['job:cancel', ['']],
    ['job:cancel', ['../../etc']],
    ['job:get', [{ id: 'x' }]],
    ['job:setShareNode', ['job-1', 'yes']],
    ['job:setShareNode', ['job-1']],
    ['job:move', [{ jobId: 'a' }]],
    ['job:move', [{ jobId: 'a', before: 7 }]],
    ['job:move', [{ jobId: 'a', before: null, extra: 1 }]],
    ['job:group', [{ jobId: 'a', withJobId: null }]],
    ['job:ungroup', [null]],
    ['job:remove', [['a']]],
    ['job:restore', []],
    ['jobs:list', [{ includeHidden: 'true' }]],
    ['jobs:list', [{}, 'extra']],
    ['queue:list', ['extra']],
    ['job:create', ['C:/scene.blend']],
    ['job:retryMissing', [undefined]],
    ['job:resume', [1]]
  ])('%s %j', async (channel, args) => {
    await expect(invokeRaw(channel, ...args)).rejects.toThrow(/^bad_request: /)
  })

  it('a bad argument changes nothing', async () => {
    const { jobId } = await w.invoke('job:create', {
      blendPath: w.blend(),
      engine: 'cycles',
      frameStart: 1,
      frameEnd: 4,
      frameStep: 1,
      addonIds: [],
      chunkSize: 4
    })
    await expect(invokeRaw('job:setShareNode', jobId, 1)).rejects.toThrow(/bad_request/)
    expect(w.get('SELECT share_node FROM jobs WHERE id = ?', jobId)).toEqual({ share_node: 0 })
  })
})

describe('refusals', () => {
  it('an unknown job is not_found', async () => {
    await expect(w.invoke('job:cancel', 'nope')).rejects.toThrow('not_found: no job nope')
    await expect(w.invoke('job:resume', 'nope')).rejects.toThrow('not_found: no job nope')
  })

  it("a queue refusal keeps its own 'code: message'", async () => {
    await expect(w.invoke('job:remove', 'nope')).rejects.toThrow(/^not_found: /)
  })

  it("createJob's reason reaches the renderer in its own words", async () => {
    const err = await w
      .invoke('job:create', {
        blendPath: '\\\\server\\share\\a.blend',
        engine: 'cycles',
        frameStart: 1,
        frameEnd: 4,
        frameStep: 1,
        addonIds: [],
        chunkSize: 4
      })
      .catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/on this computer/)
    expect((err as Error).message).not.toMatch(/^bad_request/)
  })
})

describe('runCommand: the result envelope', () => {
  it('answers ok with the value, or the code and message', async () => {
    const { runCommand } = await import('./commands/registry')
    expect(await runCommand('queue:list', [])).toEqual({ ok: true, value: [] })
    expect(await runCommand('job:cancel', [7])).toEqual({
      ok: false,
      code: 'bad_request',
      message: expect.stringMatching(/job:cancel\[0\] must be a string/)
    })
    expect(await runCommand('job:get', ['missing'])).toEqual({ ok: true, value: null })
    expect(await runCommand('job:restore', ['missing'])).toEqual({
      ok: false,
      code: 'not_found',
      message: expect.stringContaining('missing')
    })
  })

  it('job:submitSpec refuses a relative or network scene path before anything is submitted', async () => {
    const { runCommand } = await import('./commands/registry')
    for (const blends of [['scene.blend'], ['//server/share/a.blend'], []]) {
      const r = await runCommand('job:submitSpec', [{ blends, engine: 'cycles' }])
      expect(r).toMatchObject({ ok: false, code: 'bad_request' })
    }
    expect(w.all('SELECT id FROM jobs')).toEqual([])
  })

  it('job:submitSpec submits an inline spec, named', async () => {
    const { runCommand } = await import('./commands/registry')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const r = await runCommand('job:submitSpec', [
      { blends: [w.blend()], engine: 'cycles', frameStart: 1, frameEnd: 4, name: 'hero pass' }
    ])
    expect(r).toMatchObject({ ok: true, value: { unsubmitted: [], settings: {} } })
    const jobs = (r as { value: { jobs: string[] } }).value.jobs
    expect(jobs).toHaveLength(1)
    expect(w.get('SELECT name FROM jobs WHERE id = ?', jobs[0])).toEqual({ name: 'hero pass' })
  })
})
