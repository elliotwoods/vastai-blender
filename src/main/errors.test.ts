import { describe, expect, it } from 'vitest'
import { classify, describeError, GUARD_EXIT, type AgentFailure } from './errors'

/** vastClient.ts's VastError, verbatim: its name stays 'Error', only `status` marks it. */
class VastError extends Error {
  constructor(
    message: string,
    public readonly status?: number
  ) {
    super(message)
  }
}

const vastReply = (method: string, path: string, status: number, body: string): VastError =>
  new VastError(`vast.ai ${method} ${path} → ${status}: ${body}`, status)

/** Node's shape for a system error: code, errno, syscall, and usually a message. */
const sysErr = (message: string, code: string, errno: number, syscall: string): Error =>
  Object.assign(new Error(message), { code, errno, syscall })

describe('classify: the Vast account (field incident 1d59516c)', () => {
  it('400 insufficient_credit on create is an account error, not a machine to blacklist', () => {
    const e = vastReply(
      'PUT',
      '/asks/31337/',
      400,
      '{"success": false, "error": "insufficient_credit", "msg": "Your balance is too low"}'
    )
    const c = classify(e)
    expect(c.kind).toBe('account')
    expect(c.retryable).toBe(false)
    expect(c.reason).toMatch(/400/)
    expect(c.reason).toMatch(/insufficient_credit/)
  })

  it('whatever path the caller says it came down', () => {
    // A rent inside a dispatch retry: the hint is ssh, the reply is Vast's.
    const e = vastReply('PUT', '/asks/7/', 400, '{"error": "insufficient_credit"}')
    expect(classify(e, { via: 'ssh' }).kind).toBe('account')
  })

  it('also when Vast answers 200 without a contract and says why', () => {
    const e = new VastError('create instance failed: insufficient_credit')
    expect(classify(e).kind).toBe('account')
  })

  it('401, 402 and 403 are the account, and so is a missing key', () => {
    expect(classify(vastReply('GET', '/instances/', 401, 'bad key')).kind).toBe('account')
    expect(classify(vastReply('PUT', '/asks/1/', 402, 'payment required')).kind).toBe('account')
    expect(classify(vastReply('GET', '/users/current/', 403, 'forbidden')).kind).toBe('account')
    expect(classify(new VastError('No Vast.ai API key configured')).kind).toBe('account')
  })
})

describe('classify: Vast replies', () => {
  it('429, 5xx, timeouts, network and non-JSON replies are transient', () => {
    expect(classify(vastReply('GET', '/instances/', 429, 'slow down')).kind).toBe('transient')
    expect(classify(vastReply('GET', '/instances/', 502, '<html>bad gateway')).kind).toBe(
      'transient'
    )
    expect(classify(new VastError('network error: fetch failed')).kind).toBe('transient')
    expect(classify(new VastError('vast.ai GET /instances/: non-JSON response: <html>')).kind).toBe(
      'transient'
    )
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'TimeoutError'
    })
    expect(classify(timeout, { via: 'vast' }).kind).toBe('transient')
  })

  it('does not read "load balancer" as a balance problem', () => {
    const e = vastReply('GET', '/instances/', 502, 'upstream load balancer unavailable')
    expect(classify(e).kind).toBe('transient')
  })

  it('a gone instance or a refused offer is the machine', () => {
    expect(classify(vastReply('DELETE', '/instances/9/', 404, 'not found')).kind).toBe('machine')
    const taken = vastReply('PUT', '/asks/1/', 400, '{"error": "no_such_ask"}')
    expect(classify(taken)).toMatchObject({ kind: 'machine', retryable: true })
  })

  it('a refused connection to the Vast API is a blip, not a dead node', () => {
    const e = sysErr('connect ECONNREFUSED 104.18.1.1:443', 'ECONNREFUSED', -61, 'connect')
    expect(classify(e, { via: 'vast' }).kind).toBe('transient')
    const wrapped = new VastError('network error: fetch failed')
    Object.assign(wrapped, { cause: e })
    expect(classify(wrapped).kind).toBe('transient')
    expect(classify(wrapped).reason).toMatch(/ECONNREFUSED/)
  })
})

describe('classify: SSH to a node', () => {
  it('an empty-message refusal names its code (field incident 1d59516c)', () => {
    // Node's connect to a multi-address host fails as an AggregateError with
    // message '' — the "dispatch … failed: " alerts that said nothing.
    const parts = [
      sysErr('connect ECONNREFUSED 10.0.0.7:41022', 'ECONNREFUSED', -61, 'connect'),
      sysErr('connect ECONNREFUSED ::ffff:10.0.0.7:41022', 'ECONNREFUSED', -61, 'connect')
    ]
    const agg = Object.assign(new AggregateError(parts, ''), { code: 'ECONNREFUSED' })
    expect(agg.message).toBe('')
    const c = classify(agg, { via: 'ssh' })
    expect(c.kind).toBe('machine')
    expect(c.retryable).toBe(true)
    expect(c.reason).toMatch(/ECONNREFUSED/)
    expect(c.reason).toMatch(/10\.0\.0\.7/)
  })

  it('a refused, timed-out or silent node is the machine', () => {
    const refused = sysErr('connect ECONNREFUSED 1.2.3.4:22', 'ECONNREFUSED', -61, 'connect')
    const timedOut = sysErr('connect ETIMEDOUT 1.2.3.4:22', 'ETIMEDOUT', -60, 'connect')
    expect(classify(refused).kind).toBe('machine')
    expect(classify(timedOut).kind).toBe('machine')
    expect(classify(new Error('No response from server')).kind).toBe('machine')
    const handshake = Object.assign(new Error('Timed out while waiting for handshake'), {
      level: 'client-timeout'
    })
    expect(classify(handshake).kind).toBe('machine')
    expect(classify(handshake).reason).toMatch(/client-timeout/)
  })

  it('a changed host key is never retried on that machine', () => {
    const e = Object.assign(new Error('SSH host key mismatch — possible machine change or MITM'), {
      name: 'HostKeyMismatchError'
    })
    expect(classify(e)).toMatchObject({ kind: 'machine', retryable: false })
  })

  it('a busy channel limit, an exec timeout or a dropped link is transient', () => {
    expect(classify(new Error('(SSH) Channel open failure: open failed')).kind).toBe('transient')
    expect(classify(new Error('exec timeout after 30000ms: cat /work/state/x.json')).kind).toBe(
      'transient'
    )
    expect(classify(sysErr('read ECONNRESET', 'ECONNRESET', -54, 'read')).kind).toBe('transient')
  })

  it("this computer's own network being down is not the node's fault", () => {
    const e = sysErr('getaddrinfo ENOTFOUND ssh5.vast.ai', 'ENOTFOUND', -3008, 'getaddrinfo')
    expect(classify(e, { via: 'ssh' }).kind).toBe('transient')
  })

  it('an SFTP status from the node is the machine, and says its code', () => {
    const e = Object.assign(new Error('No such file: /work/renders/c1/frames/0002.png'), {
      code: 2
    })
    const c = classify(e)
    expect(c.kind).toBe('machine')
    expect(c.reason).toMatch(/code 2/)
  })
})

describe('classify: this computer', () => {
  it('ENOSPC, EACCES and ENOENT from a local write are local, not the chunk', () => {
    const full = sysErr(
      "ENOSPC: no space left on device, write '/Users/me/renders/j/0001.exr'",
      'ENOSPC',
      -28,
      'write'
    )
    expect(classify(full)).toMatchObject({ kind: 'local', retryable: false })
    expect(classify(full).reason).toMatch(/disk full/)
    const denied = sysErr(
      "EACCES: permission denied, open '/Volumes/x/0001.exr'",
      'EACCES',
      -13,
      'open'
    )
    expect(classify(denied).kind).toBe('local')
    const gone = sysErr("ENOENT: no such file or directory, open '/x/y'", 'ENOENT', -2, 'open')
    expect(classify(gone).kind).toBe('local')
  })

  it('knows a local file error by its message when a wrapper dropped the code', () => {
    const e = new Error("ENOSPC: no space left on device, open '/Users/me/renders/x.part'")
    expect(classify(e).kind).toBe('local')
  })

  it("does not take a node's quoted stderr for this computer's disk", () => {
    const e = new Error('provision.sh base failed: npm ERR! code ENOSPC while unpacking')
    expect(classify(e).kind).not.toBe('local')
  })

  it("plan 1.10's LocalSinkError is local whatever it says", () => {
    const e = Object.assign(new Error('output folder unwritable'), { name: 'LocalSinkError' })
    expect(classify(e).kind).toBe('local')
  })
})

describe('classify: what the agent reports', () => {
  const agent = (f: Partial<AgentFailure>): AgentFailure => ({ exitCode: null, ...f })

  it('a scene guard or preflight failure is the job, and not worth retrying', () => {
    const guard = agent({
      exitCode: GUARD_EXIT,
      error: 'python script raised (exit 32) — scene guard or startup script failed; see log'
    })
    expect(classify(guard)).toMatchObject({ kind: 'job', retryable: false })
    expect(classify(agent({ exitCode: GUARD_EXIT, errorKind: 'scene' }))).toMatchObject({
      kind: 'job',
      retryable: false
    })
  })

  it('a Blender crash is the job but may not recur', () => {
    const c = classify(agent({ exitCode: 139, error: 'blender exited 139' }))
    expect(c).toMatchObject({ kind: 'job', retryable: true })
    expect(c.reason).toMatch(/139/)
  })

  it("a kill, a full node disk or a missing GPU is the machine's", () => {
    expect(classify(agent({ exitCode: -9, error: 'blender exited -9' })).kind).toBe('machine')
    expect(classify(agent({ exitCode: 137 })).kind).toBe('machine')
    const disk = agent({
      exitCode: 0,
      error: 'blender could not save 0007.exr (exit 0) — disk full or I/O error; see log'
    })
    expect(classify(disk).kind).toBe('machine')
    expect(classify(agent({ exitCode: GUARD_EXIT, errorKind: 'gpu' })).kind).toBe('machine')
    expect(classify(agent({ exitCode: 1, errorKind: 'oom', gpu: 3 })).reason).toMatch(/GPU 3/)
  })

  it('reads the exit code from the error text when the field is missing', () => {
    expect(classify(agent({ error: 'blender exited 32' })).kind).toBe('job')
    expect(classify(agent({ error: 'blender exited 32' })).retryable).toBe(false)
  })

  it('an agent failure with nothing to say still has a reason', () => {
    const c = classify(agent({}))
    expect(c.kind).toBe('machine')
    expect(c.reason.length).toBeGreaterThan(20)
  })
})

describe('describeError: never empty, always names the code', () => {
  it('names the code, errno and syscall of an error with no message', () => {
    const e = Object.assign(new Error(''), { code: 'ECONNREFUSED', errno: -61, syscall: 'connect' })
    const s = describeError(e)
    expect(s).toMatch(/ECONNREFUSED/)
    expect(s).toMatch(/errno -61/)
    expect(s).toMatch(/connect/)
  })

  it('does not repeat what the message already says', () => {
    const e = sysErr('connect ECONNREFUSED 1.2.3.4:22', 'ECONNREFUSED', -61, 'connect')
    expect(describeError(e)).toBe('connect ECONNREFUSED 1.2.3.4:22 (errno -61)')
    expect(describeError(vastReply('GET', '/x/', 429, 'slow'))).toBe('vast.ai GET /x/ → 429: slow')
  })

  it('says something for anything that can be thrown', () => {
    const thrown: unknown[] = [
      undefined,
      null,
      '',
      '   ',
      0,
      false,
      {},
      [],
      new Error(),
      new Error(''),
      new TypeError(''),
      new AggregateError([], ''),
      Object.assign(new Error(''), { cause: new Error('') }),
      Object.assign(new Error(''), { code: 4 }),
      { exitCode: null }
    ]
    for (const t of thrown) {
      const s = describeError(t)
      expect(s.trim().length, `describeError(${String(t)})`).toBeGreaterThan(0)
      expect(classify(t).reason.trim().length).toBeGreaterThan(0)
    }
  })

  it('every classified reason carries the code or errno the error had', () => {
    const coded = [
      Object.assign(new Error(''), { code: 'ECONNREFUSED', errno: -61 }),
      Object.assign(new Error('boom'), { code: 'ENOSPC', errno: -28, syscall: 'write' }),
      Object.assign(new Error('Failure'), { code: 4 }),
      Object.assign(new Error(''), { code: 'EPIPE' })
    ]
    for (const e of coded) {
      const { reason } = classify(e)
      expect(reason).toContain(String((e as { code: unknown }).code))
      const errno = (e as { errno?: number }).errno
      if (errno != null) expect(reason).toContain(String(errno))
    }
  })

  it('keeps a long reply to one alert-sized line', () => {
    expect(describeError(new Error('x'.repeat(5000))).length).toBeLessThanOrEqual(600)
  })
})
