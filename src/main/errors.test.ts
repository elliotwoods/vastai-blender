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

describe('classify: did the far end act? (plan 1.4)', () => {
  it('a create that failed with a 5xx, a timeout, a network error or a non-JSON reply may exist', () => {
    const maybeCreated = [
      vastReply('PUT', '/asks/1/', 502, '<html>bad gateway'),
      vastReply('PUT', '/asks/1/', 504, 'gateway timeout'),
      vastReply('PUT', '/asks/1/', 408, 'request timeout'),
      new VastError('network error: fetch failed'),
      new VastError('vast.ai PUT /asks/1/: non-JSON response: <html>'),
      Object.assign(new Error('The operation was aborted due to timeout'), {
        name: 'TimeoutError'
      }),
      sysErr('read ECONNRESET', 'ECONNRESET', -54, 'read'),
      sysErr('connect ETIMEDOUT 104.18.1.1:443', 'ETIMEDOUT', -60, 'connect')
    ]
    for (const e of maybeCreated) {
      const c = classify(e, { via: 'vast' })
      // Retryable, and still no leave to send the create again.
      expect(c, c.reason).toMatchObject({ kind: 'transient', outcomeUnknown: true })
    }
  })

  it('an explicit refusal made nothing', () => {
    const refused = [
      vastReply('PUT', '/asks/1/', 400, '{"error": "insufficient_credit"}'),
      vastReply('PUT', '/asks/1/', 400, '{"error": "no_such_ask"}'),
      vastReply('PUT', '/asks/1/', 401, 'bad key'),
      vastReply('PUT', '/asks/1/', 404, 'not found'),
      vastReply('PUT', '/asks/1/', 429, 'slow down'),
      new VastError('No Vast.ai API key configured')
    ]
    for (const e of refused) {
      const c = classify(e, { via: 'vast' })
      expect(c.outcomeUnknown, c.reason).toBe(false)
    }
  })

  it('a create answered 200 without a contract is a refusal from Vast, not a mystery', () => {
    const c = classify(new VastError('create instance failed: no_such_ask'), { via: 'vast' })
    expect(c).toMatchObject({ kind: 'machine', outcomeUnknown: false, retryable: true })
  })

  it('an SSH command that timed out or lost its link may have run; one never sent did not', () => {
    const ran = [
      new Error('exec timeout after 30000ms: mv /work/inbox/c1.json.tmp /work/inbox/c1.json'),
      new Error('No response from server'),
      sysErr('read ECONNRESET', 'ECONNRESET', -54, 'read')
    ]
    for (const e of ran) expect(classify(e, { via: 'ssh' }).outcomeUnknown).toBe(true)
    const notSent = [
      sysErr('connect ECONNREFUSED 1.2.3.4:22', 'ECONNREFUSED', -61, 'connect'),
      Object.assign(new Error('SSH host key mismatch'), { name: 'HostKeyMismatchError' }),
      new Error('(SSH) Channel open failure: open failed'),
      sysErr("ENOSPC: no space left on device, write '/x'", 'ENOSPC', -28, 'write')
    ]
    for (const e of notSent) expect(classify(e, { via: 'ssh' }).outcomeUnknown).toBe(false)
    expect(classify({ exitCode: 1, error: 'blender exited 1' }).outcomeUnknown).toBe(false)
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
    expect(classify(full)).toMatchObject({ kind: 'localFs', retryable: false })
    expect(classify(full).reason).toMatch(/disk full/)
    const denied = sysErr(
      "EACCES: permission denied, open '/Volumes/x/0001.exr'",
      'EACCES',
      -13,
      'open'
    )
    expect(classify(denied).kind).toBe('localFs')
    const gone = sysErr("ENOENT: no such file or directory, open '/x/y'", 'ENOENT', -2, 'open')
    expect(classify(gone).kind).toBe('localFs')
  })

  it('knows a local file error by its message when a wrapper dropped the code', () => {
    const e = new Error("ENOSPC: no space left on device, open '/Users/me/renders/x.part'")
    expect(classify(e).kind).toBe('localFs')
  })

  it("does not take a node's quoted stderr for this computer's disk", () => {
    const e = new Error('provision.sh base failed: npm ERR! code ENOSPC while unpacking')
    expect(classify(e).kind).not.toBe('localFs')
  })

  it("plan 1.10's LocalSinkError is local whatever it says", () => {
    const e = Object.assign(new Error('output folder unwritable'), { name: 'LocalSinkError' })
    expect(classify(e).kind).toBe('localFs')
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

describe('classify: what nothing recognises', () => {
  it('is charged to the job, so the render retries bound it and the user sees why', () => {
    // Called transient, a bug of ours could be retried until the
    // infrastructure budget ran out, never reaching the job breaker.
    const ours = new TypeError("Cannot read properties of undefined (reading 'numGpus')")
    const c = classify(ours, { via: 'ssh' })
    expect(c).toMatchObject({ kind: 'job', retryable: true, rule: 'unclassified' })
    expect(c.reason).toMatch(/numGpus/)
    expect(classify(new Error('path escapes the job folder: ../../etc')).kind).toBe('job')
    expect(classify('something odd').kind).toBe('job')
    expect(classify(undefined).kind).toBe('job')
  })

  it('from Vast stays transient, with its outcome unknown: there is no job to charge', () => {
    const c = classify(new VastError('vast.ai said something new'), { via: 'vast' })
    expect(c).toMatchObject({ kind: 'transient', outcomeUnknown: true })
    expect(classify('odd', { via: 'vast' }).kind).toBe('transient')
  })

  it("knows this app's own SSH and transfer failures, so none is charged to the job", () => {
    const infra: Array<[Error, string]> = [
      [new Error('execStream timeout after 600000ms: provision.sh base'), 'transient'],
      [new Error('SFTP readFile /work/state/c1.json: no answer for 30s'), 'transient'],
      [new Error('SFTP channel open timed out after 20000ms'), 'transient'],
      [new Error('unexpected EOF at 1048576 of 4194304 (/work/renders/c1/0001.exr)'), 'transient'],
      [new Error('size mismatch downloading /work/renders/c1/0001.exr: 10 != 20'), 'transient'],
      [new Error('hash mismatch downloading /work/renders/c1/0001.exr'), 'transient'],
      [new Error('upload verify failed for scene.blend'), 'transient'],
      [new Error('transfer aborted (/work/renders/c1/0001.exr)'), 'transient'],
      [new Error('node vanished'), 'machine'],
      [new Error('no SSH endpoint yet'), 'machine'],
      // sshConnection's own words, even when the caller gave no source.
      [new Error('connection closed'), 'machine'],
      [new Error('reconnect budget exhausted: connect ECONNREFUSED 1.2.3.4:22'), 'machine'],
      [new Error('provision.sh base failed: No space left on device'), 'machine']
    ]
    for (const [e, kind] of infra) {
      const c = classify(e)
      expect(c.kind, `${e.message} → ${c.rule}`).toBe(kind)
      expect(c.rule).not.toBe('unclassified')
    }
    const sftpTimeout = classify(new Error('SFTP writeFile /work/inbox/c1.json: no answer for 30s'))
    expect(sftpTimeout.outcomeUnknown).toBe(true)
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
