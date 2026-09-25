import { describe, expect, it } from 'vitest'
import { classify, describeError, GUARD_EXIT, type AgentFailure } from './errors'
import { RetryAbortedError } from './ssh/connectRetry'
import { TransferAbortedError, TransferStalledError } from './ssh/pipelinedGet'
import { SftpTimeoutError } from './ssh/sftp'
import { ExecTimeoutError, HostKeyMismatchError, SftpOpenTimeoutError } from './ssh/sshConnection'

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
      [new ExecTimeoutError('execStream', 'provision.sh base', 600_000), 'transient'],
      [new ExecTimeoutError('exec', 'cat /work/state/c1.json', 30_000), 'transient'],
      [new SftpTimeoutError('readFile /work/state/c1.json', 30_000), 'transient'],
      [new SftpOpenTimeoutError(20_000), 'transient'],
      [new Error('unexpected EOF at 1048576 of 4194304 (/work/renders/c1/0001.exr)'), 'transient'],
      [new Error('size mismatch downloading /work/renders/c1/0001.exr: 10 != 20'), 'transient'],
      [new Error('hash mismatch downloading /work/renders/c1/0001.exr'), 'transient'],
      [new Error('upload verify failed for scene.blend'), 'transient'],
      [new TransferAbortedError('/work/renders/c1/0001.exr'), 'transient'],
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
    const sftpTimeout = classify(new SftpTimeoutError('writeFile /work/inbox/c1.json', 30_000))
    expect(sftpTimeout.outcomeUnknown).toBe(true)
  })

  describe('a flaky node on the dispatch and download paths never spends render retries (job 1d59516c)', () => {
    // ChunkRun.dispatch runs installBlender, setupOctane, installExtension and
    // uploadFileVerified inside withNodePrep before anything renders, and the
    // downloader runs pipelinedGet's stall guard. Charged to the job, one bad
    // node's stalls and resets used up chunks' render retries, and the same
    // class on a second node put the job in "needs attention" while the fleet
    // billed. Each of these is the app's own error, thrown as it throws it.
    const infra: Array<[string, unknown, string, string]> = [
      [
        'the download stall guard',
        new TransferStalledError('/work/renders/c1/0001.exr', 61_000, 1_048_576),
        'transient',
        'transfer-stalled'
      ],
      [
        'an SFTP open given up on',
        new Error('SFTP channel given up on while it opened'),
        'transient',
        'sftp-open-reset'
      ],
      [
        'an SFTP open reset under it',
        new Error('SFTP channel reset while it opened'),
        'transient',
        'sftp-open-reset'
      ],
      [
        'a connect retry the caller gave up on',
        new RetryAbortedError(),
        'transient',
        'retry-aborted'
      ],
      // ssh2's words when the node's sshd refuses a request on a channel.
      ['ssh2 refusing an exec', new Error('Unable to exec'), 'transient', 'ssh-request-refused'],
      [
        'ssh2 refusing the SFTP subsystem',
        new Error('Unable to start subsystem: sftp'),
        'transient',
        'ssh-request-refused'
      ],
      [
        'a channel already closed',
        new Error('Channel is not open'),
        'transient',
        'ssh-request-refused'
      ],
      ['no channel left', new Error('No free channels available'), 'transient', 'ssh-channels'],
      [
        'SFTP end of file',
        Object.assign(new Error('End of file'), { code: 1 }),
        'transient',
        'transfer-damaged'
      ],
      [
        "sftp.ts's remote mkdir",
        new Error(
          "mkdir failed: mkdir: cannot create directory '/work/renders/c1': Read-only file system"
        ),
        'machine',
        'node-setup'
      ],
      // provisioner's runLogged, for each step dispatch can run.
      [
        'provision.sh base',
        new Error('provision.sh base failed (exit 1)'),
        'machine',
        'node-setup'
      ],
      [
        'a Blender install whose every mirror failed',
        new Error('install blender 4.5.3 failed (exit 22)'),
        'machine',
        'node-setup'
      ],
      [
        'an extension install',
        new Error('install extension my_addon failed (exit 1)'),
        'machine',
        'node-setup'
      ],
      [
        'an extension extract',
        new Error('extract extension my_addon failed (exit 2)'),
        'machine',
        'node-setup'
      ],
      [
        'a step killed by a signal',
        new Error('install blender 4.5.3 failed (exit null)'),
        'machine',
        'node-setup'
      ],
      // octaneLicense.setupOctane.
      [
        'the Octane install',
        new Error('octane install failed: E: Unable to locate package'),
        'machine',
        'node-setup'
      ],
      ['the VNC start', new Error('vnc start failed: Xvfb exited'), 'machine', 'node-setup'],
      [
        'the OctaneServer launch',
        new Error('OctaneServer launch failed: no display'),
        'machine',
        'node-setup'
      ],
      // nodeManager.driveToReady's first connection.
      [
        'a first connection that answered oddly',
        new Error(
          'unexpected echo result: bash: echo: write error (gave up after 4 attempts over 190s)'
        ),
        'machine',
        'node-not-ready'
      ],
      ['a first echo', new Error('echo failed'), 'machine', 'node-not-ready'],
      [
        'an instance that never ran',
        new Error('instance not running after 8 min (status: loading)'),
        'machine',
        'node-not-ready'
      ],
      // ssh2's own connection failures, with and without the caller's hint.
      [
        'a keepalive timeout',
        Object.assign(new Error('Keepalive timeout'), { level: 'client-timeout' }),
        'machine',
        'ssh-lost'
      ],
      [
        'a connection lost before its handshake',
        Object.assign(new Error('Connection lost before handshake'), {
          level: 'protocol',
          fatal: true
        }),
        'machine',
        'ssh-lost'
      ],
      [
        'a host key that changed',
        new HostKeyMismatchError('SHA256:a', 'SHA256:b'),
        'machine',
        'ssh-hostkey'
      ]
    ]
    for (const [what, e, kind, rule] of infra) {
      it(`${what} → ${kind}`, () => {
        for (const via of [undefined, 'ssh'] as const) {
          const c = classify(e, { via })
          expect(c.kind, `${c.reason} → ${c.rule}`).toBe(kind)
          expect(c.rule).toBe(rule)
        }
      })
    }

    it("a transfer the node stalled on is the machine side's, and says where", () => {
      const c = classify(new TransferStalledError('/work/renders/c1/0001.exr', 61_000, 1_048_576))
      expect(c).toMatchObject({ kind: 'transient', retryable: true, outcomeUnknown: false })
      expect(c.reason).toMatch(/no data for 61s at 1048576 bytes/)
      expect(c.reason).toMatch(/0001\.exr/)
    })

    it('a refused exec or subsystem never ran, so its outcome is known', () => {
      expect(classify(new Error('Unable to exec'), { via: 'ssh' }).outcomeUnknown).toBe(false)
      expect(classify(new Error('Unable to start subsystem: sftp')).outcomeUnknown).toBe(false)
    })
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
