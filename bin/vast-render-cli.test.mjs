import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  EXIT_NOT_RUNNING,
  EXIT_OK,
  EXIT_REFUSED,
  UsageError,
  apiFileCandidates,
  buildSpec,
  discoverApi,
  main,
  parseArgs,
  parseFrames,
  requestFor
} from './vast-render-cli.mjs'

describe('parseArgs', () => {
  it('splits the command, its arguments and flags', () => {
    expect(parseArgs(['submit', 'a.blend', '--frames', '1-10', '--share', '--name=hero'])).toEqual({
      command: 'submit',
      args: ['a.blend'],
      flags: { frames: '1-10', share: true, name: 'hero' }
    })
    expect(parseArgs(['list', '--json', '--all']).flags).toEqual({ json: true, all: true })
    expect(parseArgs(['rm', '--', '--odd-id']).args).toEqual(['--odd-id'])
  })

  it('refuses unknown flags and missing values', () => {
    expect(() => parseArgs(['list', '--nope'])).toThrow(UsageError)
    expect(() => parseArgs(['submit', '--frames'])).toThrow(/needs a value/)
    expect(() => parseArgs(['list', '--json=1'])).toThrow(/takes no value/)
  })
})

describe('building requests', () => {
  it('parseFrames', () => {
    expect(parseFrames('1-120')).toEqual({ frameStart: 1, frameEnd: 120 })
    expect(parseFrames('7')).toEqual({ frameStart: 7, frameEnd: 7 })
    expect(() => parseFrames('10-1')).toThrow(UsageError)
    expect(() => parseFrames('a-b')).toThrow(UsageError)
  })

  it('submit makes every blend path full, from where it was run', () => {
    const spec = buildSpec(
      ['shots/a.blend', '/abs/b.blend'],
      { frames: '1-20', engine: 'cycles', chunk: '5', name: 'n', share: true, dedupe: 'never' },
      '/work'
    )
    expect(spec).toEqual({
      blends: [resolve('/work', 'shots/a.blend'), resolve('/abs/b.blend')],
      frameStart: 1,
      frameEnd: 20,
      engine: 'cycles',
      chunkSize: 5,
      name: 'n',
      shareNode: true,
      dedupe: 'never'
    })
  })

  it('submit --spec reads the file and makes its paths full, leaving network paths for the app to refuse', () => {
    const files = {
      [resolve('/work', 'c.json')]: JSON.stringify({
        blends: ['a.blend', { path: 'b.blend', name: 'B' }, '//server/x.blend'],
        addonZips: ['z.zip'],
        maxActiveNodes: 2
      })
    }
    const spec = buildSpec([], { spec: 'c.json' }, '/work', (p) => files[p])
    expect(spec).toEqual({
      blends: [
        resolve('/work', 'a.blend'),
        { path: resolve('/work', 'b.blend'), name: 'B' },
        '//server/x.blend'
      ],
      addonZips: [resolve('/work', 'z.zip')],
      maxActiveNodes: 2
    })
  })

  it.each([
    [['list'], {}, ['GET', '/v1/jobs']],
    [['list'], { all: true }, ['GET', '/v1/jobs?hidden=1']],
    [['status', 'j1'], {}, ['GET', '/v1/jobs/j1']],
    [['cancel', 'j1'], {}, ['POST', '/v1/jobs/j1/cancel', undefined]],
    [['retry', 'j1'], {}, ['POST', '/v1/jobs/j1/retry-missing', undefined]],
    [['rm', 'j1'], { cancel: true }, ['DELETE', '/v1/jobs/j1?cancel=1']],
    [['move', 'j1'], {}, ['POST', '/v1/jobs/j1/move', { before: null }]],
    [['move', 'j1'], { before: 'j2' }, ['POST', '/v1/jobs/j1/move', { before: 'j2' }]],
    [['group', 'j1', 'j2'], {}, ['POST', '/v1/jobs/j1/group', { withJobId: 'j2' }]],
    [['share', 'j1', 'off'], {}, ['PATCH', '/v1/jobs/j1', { shareNode: false }]],
    [['fleet'], {}, ['GET', '/v1/fleet']],
    [['cost'], {}, ['GET', '/v1/fleet/cost']],
    [['queue'], {}, ['GET', '/v1/queue']]
  ])('%j %j', ([command, ...args], flags, want) => {
    expect(requestFor(command, args, flags)).toEqual(want)
  })

  it('refuses a command it does not know, or the wrong arguments', () => {
    expect(() => requestFor('frobnicate', [], {})).toThrow(/unknown command/)
    expect(() => requestFor('cancel', [], {})).toThrow(UsageError)
    expect(() => requestFor('share', ['j1', 'maybe'], {})).toThrow(/on or off/)
  })
})

describe('finding api.json', () => {
  it('VR_API_FILE, then VR_USERDATA, then the profile folders', () => {
    expect(
      apiFileCandidates({ VR_API_FILE: '/x/api.json', VR_USERDATA: '/u' }, 'linux', '/h')
    ).toEqual(['/x/api.json'])
    expect(apiFileCandidates({ VR_USERDATA: '/u' }, 'linux', '/h')).toEqual([
      join('/u', 'api.json')
    ])
    expect(apiFileCandidates({}, 'darwin', '/Users/me')).toEqual([
      join('/Users/me/Library/Application Support/Vast Render/api.json'),
      join('/Users/me/Library/Application Support/vastai-blender/api.json')
    ])
    expect(
      apiFileCandidates({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'win32', 'C:\\Users\\me')
    ).toEqual([
      join('C:\\Users\\me\\AppData\\Roaming', 'Vast Render', 'api.json'),
      join('C:\\Users\\me\\AppData\\Roaming', 'vastai-blender', 'api.json')
    ])
    expect(apiFileCandidates({}, 'linux', '/home/me')).toEqual([
      join('/home/me/.config/Vast Render/api.json'),
      join('/home/me/.config/vastai-blender/api.json')
    ])
  })

  const good = {
    version: 1,
    url: 'http://127.0.0.1:5000',
    port: 5000,
    token: 't',
    pid: 42,
    startedAt: 1
  }

  it('takes the first that parses and whose app is alive', () => {
    const files = {
      '/a': '{not json',
      '/b': JSON.stringify({ ...good, pid: 7 }),
      '/c': JSON.stringify(good)
    }
    const info = discoverApi({
      candidates: ['/missing', '/a', '/b', '/c'],
      exists: (p) => p in files,
      readFile: (p) => files[p],
      alive: (pid) => pid === 42
    })
    expect(info).toEqual({ ...good, path: '/c' })
  })

  it('refuses a file that points anywhere but loopback', () => {
    const files = { '/a': JSON.stringify({ ...good, url: 'http://evil.example:5000' }) }
    expect(
      discoverApi({
        candidates: ['/a'],
        exists: () => true,
        readFile: (p) => files[p],
        alive: () => true
      })
    ).toBeNull()
  })
})

describe('main', () => {
  let dir
  let server
  let seen
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vr-cli-'))
    seen = []
  })
  afterEach(async () => {
    if (server) await new Promise((r) => server.close(r))
    server = null
    rmSync(dir, { recursive: true, force: true })
  })

  /** A stand-in API answering each request with `reply(method, url, body)`. */
  async function fakeApi(reply) {
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body })
        const [status, answer] = reply(req.method, req.url, body)
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(answer))
      })
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const port = server.address().port
    const file = join(dir, 'api.json')
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        url: `http://127.0.0.1:${port}`,
        port,
        token: 'tok',
        pid: process.pid,
        startedAt: 1
      })
    )
    return file
  }

  function io(file) {
    const lines = { out: [], err: [] }
    return {
      lines,
      io: {
        out: (s) => lines.out.push(s),
        err: (s) => lines.err.push(s),
        cwd: dir,
        discover: file ? { candidates: [file] } : { candidates: [join(dir, 'none.json')] }
      }
    }
  }

  it('2 when the app is not running', async () => {
    const t = io(null)
    expect(await main(['list'], t.io)).toBe(EXIT_NOT_RUNNING)
    expect(t.lines.err.join('\n')).toMatch(/not running/)
  })

  it('0 on an answer, with the token sent', async () => {
    const file = await fakeApi(() => [200, { ok: true, value: [] }])
    const t = io(file)
    expect(await main(['list'], t.io)).toBe(EXIT_OK)
    expect(t.lines.out).toEqual(['no jobs'])
    expect(seen).toEqual([{ method: 'GET', url: '/v1/jobs', auth: 'Bearer tok', body: '' }])
  })

  it('1 on a refusal, saying why', async () => {
    const file = await fakeApi(() => [
      409,
      { ok: false, code: 'active', message: 'job j1 is running' }
    ])
    const t = io(file)
    expect(await main(['rm', 'j1'], t.io)).toBe(EXIT_REFUSED)
    expect(t.lines.err).toEqual(['vast-render-cli: active: job j1 is running'])
  })

  it('submit sends full paths; --json prints the raw value', async () => {
    const file = await fakeApi(() => [
      201,
      { ok: true, value: { jobs: ['j1'], unsubmitted: [], settings: {} } }
    ])
    const t = io(file)
    expect(await main(['submit', 'a.blend', '--frames', '1-4', '--json'], t.io)).toBe(EXIT_OK)
    expect(JSON.parse(seen[0].body)).toEqual({
      blends: [join(dir, 'a.blend')],
      frameStart: 1,
      frameEnd: 4
    })
    expect(JSON.parse(t.lines.out[0])).toEqual({ jobs: ['j1'], unsubmitted: [], settings: {} })
  })

  it('1 for a usage error, before anything is sent', async () => {
    const file = await fakeApi(() => [200, { ok: true, value: null }])
    const t = io(file)
    expect(await main(['share', 'j1', 'maybe'], t.io)).toBe(EXIT_REFUSED)
    expect(seen).toEqual([])
  })
})
