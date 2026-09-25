/**
 * What kind of failure is this, and what does it say?
 *
 * One classifier for every error that can stop a rental, a dispatch or a
 * download, so each of those paths decides the same way what happens next
 * (plan 1.17, audit A12):
 *
 *   transient  Try the same thing again later. Nothing is known to be wrong:
 *              a Vast 5xx or 429, a timeout, this computer's own network, an
 *              SSH channel limit.
 *   machine    This node or offer is the problem. Move the work elsewhere and
 *              count the failure against the machine, never against the
 *              render's retries.
 *   account    The Vast account is the problem: no credit, a bad key, access
 *              refused. Stop renting and say why. Retrying, or blacklisting
 *              one machine after another, only piles up failed rows: job
 *              1d59516c made 12 rent attempts, each refused with 400
 *              insufficient_credit.
 *   job        The job itself: a scene check or startup script failed, or
 *              Blender exited with an error. Also any error nothing here
 *              recognises, so that it is bounded by the render retries and
 *              shown to the user (see the end of classify).
 *   localFs    This computer: disk full, permission denied, an output folder
 *              gone. Nothing remote is wrong, and failing chunks for it throws
 *              away renders already paid for.
 *
 * The classes are shared/models.ts's ErrorClass, which chunks and job
 * attention carry to the renderer.
 *
 * The reason is never empty and always carries the error's code, errno, HTTP
 * status or exit code. In job 1d59516c, 16 chunks burned all their retries
 * on "dispatch … failed: " with nothing after the colon. Node reports a
 * refused connection to a host with several addresses as an AggregateError
 * whose message is empty and whose code says what happened.
 *
 * Pure and duck-typed: VastError, ssh2's errors, Node's system errors and the
 * agent's failure state are recognised by their shape, not their class, so
 * this module imports no code and an error that was re-wrapped still sorts.
 */

import type { ErrorClass } from '../shared/models'

export type { ErrorClass }

/** Where the error came from, when the caller knows. It only breaks ties. */
export type ErrorSource = 'vast' | 'ssh' | 'agent' | 'local'

export interface Classification {
  kind: ErrorClass
  /** One line for alerts, logs and scale status. Never empty. */
  reason: string
  /**
   * Might trying again succeed? A transient error on the same target, a
   * machine error on another machine, a job error only for a Blender crash
   * that may not recur. Account and local errors wait until their cause is
   * fixed.
   */
  retryable: boolean
  /**
   * The far end may have done what was asked before the error came back: a
   * Vast 5xx, timeout, network error or non-JSON reply, a create answered
   * with neither a contract nor a reason, an SSH command that timed out or
   * lost its connection, or an error nothing here recognises.
   * For a call that is not safe to repeat, above all a create (PUT /asks),
   * this means "find out", never "retry": the instance may exist and bill
   * under its label, so plan 1.4 looks it up by label and adopts it or
   * confirms it absent before anything is rented again. `retryable` only
   * says a later attempt might succeed, not that this one did nothing.
   */
  outcomeUnknown: boolean
  /** The rule that matched, for tests and logs. */
  rule: string
}

/**
 * A chunk the agent reported as failed: its state file's `exitCode`, `error`
 * and (from plan 1.11 and 1.16) `errorKind` and `gpu`.
 */
export interface AgentFailure {
  exitCode: number | null
  error?: string | null
  errorKind?: string | null
  gpu?: number | null
  /** The chunk log's last lines, which a failed state carries (noderunner LOG_TAIL_LINES). */
  logTail?: readonly string[] | null
}

/** Blender's exit code when a --python script raised (noderunner.py GUARD_EXIT). */
export const GUARD_EXIT = 32

interface ErrorLike {
  name?: unknown
  /** OctaneBlenderMissingError: the node was rented from the Octane image. */
  octaneImage?: unknown
  message?: unknown
  code?: unknown
  errno?: unknown
  syscall?: unknown
  status?: unknown
  level?: unknown
  cause?: unknown
  errors?: unknown
}

/** Connection failures where the far end did not answer. */
const UNREACHABLE = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'EHOSTDOWN', 'ETIMEDOUT'])
/** Connection failures that say more about this computer's network than the far end. */
const LOCAL_NET = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'ENETDOWN'])
/** A name that did not resolve: no connection was made, so nothing was sent. */
const DNS = new Set(['ENOTFOUND', 'EAI_AGAIN'])
/** A connection that was up and dropped. */
const DROPPED = new Set(['ECONNRESET', 'ECONNABORTED', 'EPIPE'])
/** Node file-system codes: only local file operations raise them with a string code. */
const LOCAL_FS = new Set([
  'ENOSPC',
  'EDQUOT',
  'EACCES',
  'EPERM',
  'EROFS',
  'ENOENT',
  'ENOTDIR',
  'EISDIR',
  'EEXIST',
  'EBUSY',
  'EMFILE',
  'ENFILE',
  'EIO',
  'EFBIG',
  'ENAMETOOLONG'
])

/** Vast's words for "your balance cannot pay for this". */
const NO_CREDIT =
  /insufficient[_ ]?(credit|funds|balance)|not enough (credit|funds|balance)|out of credit|negative balance/i

function isObject(e: unknown): e is ErrorLike {
  return typeof e === 'object' && e !== null
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** Does `text` mention `token` as a word of its own ("2" is not in "429")? */
function mentions(text: string, token: string): boolean {
  const t = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^\\w-])${t}($|[^\\w])`).test(text)
}

function isAgentFailure(e: unknown): e is AgentFailure {
  return isObject(e) && !(e instanceof Error) && ('exitCode' in e || 'errorKind' in e)
}

/** The first system error code anywhere on the error: itself, its cause, an aggregate's parts. */
function systemCode(e: ErrorLike, depth = 0): string | null {
  if (typeof e.code === 'string' && /^E[A-Z0-9_]+$/.test(e.code)) return e.code
  if (depth > 3) return null
  if (isObject(e.cause)) {
    const c = systemCode(e.cause, depth + 1)
    if (c) return c
  }
  if (Array.isArray(e.errors)) {
    for (const part of e.errors) {
      if (!isObject(part)) continue
      const c = systemCode(part, depth + 1)
      if (c) return c
    }
  }
  // A wrapper may keep only the message. Node writes network errors as
  // "connect ECONNREFUSED 1.2.3.4:22", and file errors as "ENOSPC: no space
  // left on device, write", code first. A file code anywhere else in a
  // message is more likely a node's stderr quoted back, so it does not count.
  const message = str(e.message)
  const lead = /^(E[A-Z]+): /.exec(message)
  if (lead && LOCAL_FS.has(lead[1])) return lead[1]
  for (const m of message.matchAll(/(?:^|[\s:(])(E[A-Z]{3,})(?=[:\s)]|$)/g)) {
    if (UNREACHABLE.has(m[1]) || LOCAL_NET.has(m[1]) || DROPPED.has(m[1])) return m[1]
  }
  return null
}

/**
 * vastClient.createInstance throws "create instance failed: …" for a 200
 * without a contract. After the colon is Vast's `error` or `msg` when the
 * reply had one: a refusal in Vast's own words. Otherwise it is the whole
 * reply as JSON, and a reply that neither says no nor carries a contract (a
 * contract field renamed, say) may have rented one, as nodeManager's
 * createRefused already assumes of a create with no status. true = refused,
 * false = may exist, null = not this message.
 */
function createReplyRefused(message: string): boolean | null {
  const m = /^create instance failed:([\s\S]*)$/i.exec(message)
  if (!m) return null
  const rest = m[1].trim()
  if (!rest) return false
  let body: unknown
  try {
    body = JSON.parse(rest)
  } catch {
    return true
  }
  return isObject(body) && (body as { success?: unknown }).success === false
}

/**
 * Did the connection fail while it was being made, before anything could be
 * sent on it? Node says so with syscall 'connect' (or 'getaddrinfo'), and in
 * its message ("connect ENETUNREACH 1.2.3.4:22"); a wrapper may keep only the
 * message, or the error as its cause, and a multi-address connect fails as an
 * AggregateError of such parts.
 */
function failedConnecting(e: ErrorLike, depth = 0): boolean {
  if (e.syscall === 'connect' || e.syscall === 'getaddrinfo') return true
  if (/(^|[\s:])(connect|getaddrinfo) E[A-Z]+\b/.test(str(e.message))) return true
  if (depth > 3) return false
  if (isObject(e.cause) && failedConnecting(e.cause, depth + 1)) return true
  if (Array.isArray(e.errors) && e.errors.length > 0) {
    return e.errors.every((part) => isObject(part) && failedConnecting(part, depth + 1))
  }
  return false
}

/**
 * pipelinedGet's LocalSinkError: the local disk would not take a file. Its
 * class sets no name, so its shape marks it too: an fs code as a string and
 * a needBytes field (undefined but present unless a free-space check set it),
 * without the errno and syscall of the system error it may have wrapped.
 */
function isLocalSink(e: ErrorLike): boolean {
  if (str(e.name) === 'LocalSinkError') return true
  return (
    typeof e.code === 'string' &&
    /^E[A-Z0-9_]+$/.test(e.code) &&
    'needBytes' in e &&
    e.errno === undefined &&
    e.syscall === undefined
  )
}

function localFsLabel(code: string): string | null {
  if (code === 'ENOSPC' || code === 'EDQUOT' || code === 'EFBIG') {
    return 'disk full on this computer'
  }
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    return 'permission denied on this computer'
  }
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'a local file or folder is missing'
  if (code === 'EIO') return 'the local disk failed'
  return null
}

/** The HTTP status of a Vast reply, from VastError.status or its message ("→ 400:"). */
function httpStatus(e: ErrorLike): number | null {
  if (typeof e.status === 'number' && e.status >= 100 && e.status < 600) return e.status
  const m = /→ (\d{3}):/.exec(str(e.message))
  return m ? Number(m[1]) : null
}

function looksLikeVast(e: ErrorLike): boolean {
  return (
    str(e.name) === 'VastError' ||
    httpStatus(e) != null ||
    /^(vast\.ai |network error:|create instance failed)/i.test(str(e.message)) ||
    /Vast\.ai API key/i.test(str(e.message))
  )
}

/**
 * ssh2 marks its own errors with `level` (client-socket, client-timeout, ...);
 * sshConnection.ts words its own as "connection closed" and so on.
 */
function looksLikeSsh(e: ErrorLike): boolean {
  return (
    typeof e.level === 'string' ||
    str(e.name) === 'HostKeyMismatchError' ||
    /\(SSH\)|\bssh\b|handshake|No response from server|authentication methods failed|host key/i.test(
      str(e.message)
    ) ||
    /^(connection closed|reconnect budget exhausted|Not connected)\b/i.test(str(e.message))
  )
}

/**
 * The error as one non-empty line that names its code, errno, HTTP status,
 * ssh2 level or exit code, whichever it has, and says what was thrown when
 * nothing else does.
 */
export function describeError(e: unknown): string {
  return clip(describe(e, 0))
}

/**
 * Secrets an error's text can carry. vastClient puts the API key in every
 * URL (api_key=) and in a Bearer header, and a fetch failure such as
 * undici's "Failed to parse URL from …?api_key=…" quotes the URL back.
 * Credentials passed as an environment assignment at the front of a command
 * (Octane's sign-in once was) can be quoted by an error that names it.
 * Reasons go into alerts, chunks.lastError and scale status, which are
 * stored and shown, so every one is scrubbed, before it is cut to length so
 * no cut leaves part of a key behind.
 */
const SECRETS: ReadonlyArray<[RegExp, string]> = [
  [/\b(api[_-]?key=)[^&\s"'<>]+/gi, '$1[redacted]'],
  [/\b(Bearer\s+)[^\s"',;)]+/gi, '$1[redacted]'],
  [
    // NAME='…' as shq quotes it ('\'' inside), "…", or a bare word; a quote
    // an error cut short runs to the end.
    /\b([A-Z][A-Z0-9_]*(?:PASS|PASSWORD|PASSWD|SECRET|TOKEN|API_KEY))=('(?:[^']|'\\'')*(?:'|$)|"[^"]*(?:"|$)|[^\s;&|]+)/g,
    '$1=[redacted]'
  ]
]

function redact(s: string): string {
  let out = s
  for (const [pattern, replacement] of SECRETS) out = out.replace(pattern, replacement)
  return out
}

function clip(s: string): string {
  const r = redact(s)
  return r.length > 600 ? `${r.slice(0, 597)}...` : r
}

function describe(e: unknown, depth: number): string {
  if (e === undefined || e === null) return `unknown error (${String(e)} was thrown)`
  if (isAgentFailure(e)) return describeAgent(e)
  if (!isObject(e)) {
    const s = String(e).trim()
    return s || `unknown error (an empty ${typeof e} was thrown)`
  }
  let msg = str(e.message).trim()
  if (!msg && Array.isArray(e.errors) && depth < 3) {
    // AggregateError: Node's refused connection to a multi-address host.
    msg = e.errors
      .map((part) => describe(part, depth + 1))
      .filter((s, i, all) => s && all.indexOf(s) === i)
      .join('; ')
  }
  if (!msg && isObject(e.cause) && depth < 3) msg = describe(e.cause, depth + 1)

  const tags: string[] = []
  const tag = (label: string, value: unknown): void => {
    if (value === undefined || value === null || value === '') return
    const v = String(value)
    if (!mentions(msg, v)) tags.push(label ? `${label} ${v}` : v)
  }
  if (typeof e.code === 'number') {
    // ssh2's SFTP statuses are small numbers, and "2" alone is easy to find
    // in a path, so a numeric code is always named.
    tags.push(`code ${e.code}`)
  } else if (typeof e.code === 'string') {
    tag('', e.code)
  }
  const cause = isObject(e.cause) ? e.cause : null
  if (cause && typeof cause.code === 'string') tag('', cause.code)
  if (typeof e.errno === 'number' || typeof e.errno === 'string') tag('errno', e.errno)
  if (typeof e.syscall === 'string') tag('syscall', e.syscall)
  const status = httpStatus(e)
  if (status != null) tag('HTTP', status)
  if (typeof e.level === 'string') tag('ssh', e.level)

  if (!msg) {
    const name = str(e.name)
    msg = name && name !== 'Error' ? name : tags.length ? 'error' : 'error with no message'
  }
  return tags.length ? `${msg} (${tags.join(', ')})` : msg
}

function exitOf(f: AgentFailure): number | null {
  if (typeof f.exitCode === 'number') return f.exitCode
  const m = /\bexit(?:ed)? (-?\d+)/.exec(str(f.error))
  return m ? Number(m[1]) : null
}

/**
 * What a failed render's log says went wrong, when the agent gave no error
 * of its own: the last line of its logTail that reads as an error, or
 * failing that its last line, clipped. The log is the host's to write, so
 * only ever shown, never classified by.
 */
function logTailLine(tail: AgentFailure['logTail']): string | null {
  if (!Array.isArray(tail)) return null
  const lines = tail
    .filter((l): l is string => typeof l === 'string')
    // eslint-disable-next-line no-control-regex -- matching control characters is the point
    .map((l) => l.replace(/[\u0000-\u001f\u007f]/g, ' ').trim())
    .filter((l) => l !== '')
  const pick =
    [...lines]
      .reverse()
      .find((l) => /error|exception|traceback|killed|fail|out of memory/i.test(l)) ?? lines.at(-1)
  if (!pick) return null
  return pick.length > 200 ? `${pick.slice(0, 199)}…` : pick
}

function describeAgent(f: AgentFailure): string {
  const code = exitOf(f)
  let msg = str(f.error).trim()
  // Job 1d59516c's alerts ended at "failed: ": the agent had said nothing,
  // and the log it sent back, which did, was never read (plan 1.20).
  const logged = msg ? null : logTailLine(f.logTail)
  if (logged) msg = `blender's log ends: ${logged}`
  if (!msg) msg = code == null ? 'no error text from the agent' : 'blender failed'
  const tags: string[] = []
  if (code != null && !mentions(msg, String(code))) tags.push(`exit ${code}`)
  if (f.errorKind && !mentions(msg, f.errorKind)) tags.push(`kind ${f.errorKind}`)
  if (typeof f.gpu === 'number') tags.push(`GPU ${f.gpu}`)
  return tags.length ? `${msg} (${tags.join(', ')})` : msg
}

/**
 * The rules after which the request may have been carried out. Everything
 * else is a definite answer (a 4xx, the agent's own report, an SSH
 * connection or channel refused) or never left this computer. A Vast
 * connection failure counts as unknown whatever its code, bar a name that did
 * not resolve: a lookup by label costs far less than an instance billing
 * unseen. The network-down rule (net-local) decides per error: see classify.
 */
const OUTCOME_UNKNOWN = new Set([
  'vast-5xx',
  'vast-timeout',
  'vast-network',
  'vast-unreachable',
  'vast-create-unknown',
  'timeout',
  'net-dropped',
  'ssh-exec-timeout',
  'sftp-timeout',
  'ssh-lost',
  'unclassified'
])

function result(
  kind: ErrorClass,
  rule: string,
  label: string,
  e: unknown,
  retryable: boolean,
  /** For a rule whose outcome depends on the error: overrides OUTCOME_UNKNOWN. */
  outcomeUnknown?: boolean
): Classification {
  return {
    kind,
    rule,
    retryable,
    outcomeUnknown: outcomeUnknown ?? OUTCOME_UNKNOWN.has(rule),
    reason: clip(`${label}: ${describe(e, 0)}`)
  }
}

function classifyAgent(f: AgentFailure): Classification {
  const code = exitOf(f)
  const text = str(f.error)
  const kind = str(f.errorKind)
  if (kind === 'scene') {
    return result('job', 'agent-scene', 'scene check failed', f, false)
  }
  if (kind === 'oom') {
    return result('machine', 'agent-oom', 'out of GPU memory on this node', f, true)
  }
  if (kind === 'disk' || /could not save|No space left on device|disk full/i.test(text)) {
    return result('machine', 'agent-disk', "the node's disk is full or failing", f, true)
  }
  // Before the guard rule: enable_gpu.py raising for a missing GPU (plan
  // 1.16) exits GUARD_EXIT too, but the fault is the machine's, not the
  // scene's. The agent tells them apart with errorKind 'gpu'.
  if (
    kind === 'gpu' ||
    /no (cycles )?gpu device|CUDA error|OptiX error|GPU has fallen off/i.test(text)
  ) {
    return result('machine', 'agent-gpu', "the node's GPU failed", f, true)
  }
  if (code === GUARD_EXIT || /python script raised|scene guard/i.test(text)) {
    return result('job', 'agent-guard', 'a scene guard or startup script raised', f, false)
  }
  // SIGKILL: the kernel's OOM killer (host RAM), or the node being stopped.
  if (code === 137 || code === -9) {
    return result('machine', 'agent-killed', 'blender was killed (out of memory?)', f, true)
  }
  if (code == null) {
    return result('machine', 'agent-no-exit', 'the render ended without an exit code', f, true)
  }
  return result('job', 'agent-exit', 'render failed', f, true)
}

/**
 * Sort a failure into transient / machine / account / job / local, with a
 * reason fit for an alert. `via` names where it came from when the shape
 * alone cannot tell: a bare ECONNREFUSED is a dead node over SSH but a blip
 * from the Vast API. Without it, a bare connection error is taken to be SSH,
 * because vastClient wraps its own network errors.
 */
export function classify(e: unknown, opts: { via?: ErrorSource } = {}): Classification {
  if (isAgentFailure(e)) return classifyAgent(e)
  if (!isObject(e)) return unrecognised(e, opts.via === 'vast', 'unrecognised failure')
  const message = str(e.message)
  const name = str(e.name)
  // An HTTP status or Vast's own wording says Vast whatever `via` says; `via`
  // only decides what a bare network code means.
  const status = httpStatus(e)
  const vast = opts.via === 'vast' || (opts.via == null && looksLikeVast(e))
  const ssh = opts.via === 'ssh' || (opts.via == null && !vast && looksLikeSsh(e))
  const code = systemCode(e)

  // --- Local sink (plan 1.10's LocalSinkError), whatever its message says. ---
  if (isLocalSink(e)) {
    const label = localFsLabel(str(e.code)) ?? 'cannot write output on this computer'
    return result('localFs', 'local-sink', label, e, false)
  }

  // --- The account: before anything retries or blacklists. ---
  if (NO_CREDIT.test(message) || (status === 400 && /credit/i.test(message))) {
    return result('account', 'vast-credit', 'Vast balance too low', e, false)
  }
  if (/No Vast\.ai API key/i.test(message)) {
    return result('account', 'vast-no-key', 'no Vast.ai API key', e, false)
  }
  if (status === 401)
    return result('account', 'vast-401', 'Vast rejected the API key (invalid or revoked)', e, false)
  if (status === 402) return result('account', 'vast-402', 'Vast wants payment', e, false)
  if (status === 403)
    return result(
      'account',
      'vast-403',
      'the Vast API key lacks a permission this needs (Settings → Vast.ai API)',
      e,
      false
    )

  // --- Vast HTTP replies. ---
  if (status === 429) return result('transient', 'vast-429', 'Vast.ai rate limit', e, true)
  if (status === 408) return result('transient', 'vast-timeout', 'Vast.ai timed out', e, true)
  if (status != null && status >= 500) {
    return result('transient', 'vast-5xx', 'Vast.ai server error', e, true)
  }
  if (status === 404 || status === 410) {
    return result('machine', 'vast-gone', 'Vast says the instance or offer is gone', e, true)
  }
  const createReply = vast ? createReplyRefused(message) : null
  if (status == null && createReply === false) {
    return result(
      'transient',
      'vast-create-unknown',
      'Vast answered the create with neither a contract nor a reason',
      e,
      true
    )
  }
  if ((status != null && status >= 400) || createReply === true) {
    // An offer rented by someone else, or no longer on the market: another
    // offer can succeed where this one cannot. A create answered 200 with no
    // contract and Vast's reason (or success: false) is as definite a no.
    // An unrecognised 4xx can equally be our own request (an image, a disk
    // size or a field Vast rejects), which fails on every offer the same
    // way. So the rent path must bound these per batch (requestNodes stops
    // after 3) and count them toward plan 1.17's scale backoff, not only
    // blacklist one machine after another.
    return result('machine', 'vast-refused', 'Vast refused the request', e, true)
  }

  // --- Timeouts. ---
  if (name === 'TimeoutError' || name === 'AbortError') {
    return result('transient', 'timeout', vast ? 'Vast.ai timed out' : 'timed out', e, true)
  }

  // --- SSH: the node's host key changed. Never retried on that machine. ---
  if (name === 'HostKeyMismatchError' || /host key mismatch/i.test(message)) {
    return result('machine', 'ssh-hostkey', "the node's SSH host key changed", e, false)
  }

  // --- Network codes. ---
  if (code && LOCAL_NET.has(code)) {
    const label = 'network unavailable on this computer'
    // A name that did not resolve sent nothing. A network that went down or
    // lost its route can take a connection that was already up, after a
    // request was written: from Vast (a keep-alive socket carrying a create)
    // that is as unknown as any other Vast connection failure, and over SSH
    // as unknown as a dropped link, unless it failed while connecting.
    if (DNS.has(code)) return result('transient', 'net-local', label, e, true, false)
    if (vast) return result('transient', 'vast-unreachable', label, e, true)
    return result('transient', 'net-local', label, e, true, !failedConnecting(e))
  }
  if (code && DROPPED.has(code)) {
    return result(
      'transient',
      'net-dropped',
      vast ? 'Vast.ai connection dropped' : 'connection dropped',
      e,
      true
    )
  }
  if (code && UNREACHABLE.has(code)) {
    if (vast) return result('transient', 'vast-unreachable', 'could not reach Vast.ai', e, true)
    return result('machine', 'ssh-unreachable', 'node unreachable over SSH', e, true)
  }

  // --- SSH messages without a system code. ---
  if (/channel open failure|^No free channels available/i.test(message)) {
    return result('transient', 'ssh-channels', 'SSH channel limit on the node', e, true)
  }
  // ssh2's words when the node's sshd answers an exec or subsystem request
  // with a refusal, or the channel closed before the request went out: the
  // command never started.
  if (/^Unable to (exec|start subsystem)\b|^Channel is not open\b/i.test(message)) {
    return result('transient', 'ssh-request-refused', 'the node refused an SSH request', e, true)
  }
  if (/^exec(Stream)? timeout/i.test(message)) {
    return result('transient', 'ssh-exec-timeout', 'a command on the node timed out', e, true)
  }
  if (/^SFTP\b.*\bno answer for\b|^SFTP channel open timed out/i.test(message)) {
    return result('transient', 'sftp-timeout', 'the node did not answer a file transfer', e, true)
  }
  // sshConnection gives up on an SFTP open in flight when the connection is
  // reset under it or the open is abandoned: nothing was done on the channel.
  if (/^SFTP channel (given up on|reset) while it opened/i.test(message)) {
    return result('transient', 'sftp-open-reset', 'the SFTP channel was reset', e, true)
  }
  // connectRetry's RetryAbortedError: the caller stopped waiting because the
  // node was destroyed or replaced meanwhile. Nothing is wrong with the work.
  if (name === 'RetryAbortedError' || /^aborted$/i.test(message.trim())) {
    return result('transient', 'retry-aborted', 'stopped waiting for the node', e, true)
  }
  if (
    ssh &&
    (/No response from server|handshake|authentication methods failed|connection closed|reconnect budget exhausted|Not connected/i.test(
      message
    ) ||
      e.level === 'client-socket' ||
      e.level === 'client-timeout' ||
      e.level === 'client-authentication')
  ) {
    return result('machine', 'ssh-lost', 'lost the SSH connection to the node', e, true)
  }

  // --- This computer's disk. ---
  if (code && LOCAL_FS.has(code)) {
    return result('localFs', `local-${code}`, localFsLabel(code) ?? 'local file error', e, false)
  }

  // --- The node's disk, quoted back in its stderr (not a local code above). ---
  if (/No space left on device|Disk quota exceeded|\bENOSPC\b/i.test(message)) {
    return result('machine', 'node-disk', "the node's disk is full", e, true)
  }

  // --- ssh2 SFTP statuses (numeric codes): the node's side of a transfer. ---
  // 1 is SFTP's end of file: the node's file ended before the read did.
  if (typeof e.code === 'number' && e.code === 1) {
    return result('transient', 'transfer-damaged', 'a transfer arrived short or damaged', e, true)
  }
  if (typeof e.code === 'number' && e.code >= 2 && e.code <= 8) {
    return result('machine', 'sftp-status', 'the node refused a file transfer', e, true)
  }

  // --- Transfers this app checks itself (sftp.ts, pipelinedGet.ts). ---
  if (/^transfer aborted\b/i.test(message)) {
    return result('transient', 'transfer-aborted', 'the transfer was stopped', e, true)
  }
  // pipelinedGet's stall guard: the node sent nothing for a minute. The
  // contract charges it to the machine side (ChunkSnapshot.infraRetries),
  // never to the render.
  if (/^transfer stalled\b/i.test(message)) {
    return result('transient', 'transfer-stalled', 'a download stalled', e, true)
  }
  if (
    /^unexpected EOF at\b|^(size|hash) mismatch downloading\b|^upload verify failed\b/i.test(
      message
    )
  ) {
    return result('transient', 'transfer-damaged', 'a transfer arrived short or damaged', e, true)
  }

  // --- Octane (plan 1.18), by the error's name: octaneLicense.ts. ---
  // Nobody signed in by hand: the user's to fix, not the node's or the
  // job's. The scheduler holds the job for the sign-in, and charges nothing.
  if (name === 'OctaneLoginNeededError') {
    return result('transient', 'octane-login', 'Octane is waiting for a sign-in', e, true)
  }
  // Rented without the secure-cloud filter the Octane settings ask for: only
  // this node is unfit for Octane. Not counted by the breaker, no blacklist.
  if (name === 'OctaneHostNotVettedError') {
    return result('machine', 'octane-unvetted', 'this node may not be used for Octane', e, true)
  }
  if (name === 'OctaneBlenderMissingError') {
    // Rented from the image set for Octane, which lacks OctaneBlender: every
    // node from it would too, so the job cannot render until the setting
    // changes. Otherwise only this node lacks it.
    if (e.octaneImage === true) {
      return result('job', 'octane-image', 'the Octane docker image has no OctaneBlender', e, false)
    }
    return result('machine', 'octane-no-blender', 'this node has no OctaneBlender', e, true)
  }
  // The Octane wait given up because the chunk was taken back: as a retry
  // the caller aborted, nothing is wrong with the work.
  if (/^Octane setup stopped: the chunk was taken back/.test(message)) {
    return result('transient', 'retry-aborted', 'stopped waiting for the node', e, true)
  }

  // --- The node left the fleet under the caller (scheduler, nodeManager). ---
  if (/^node vanished\b|^no SSH endpoints?\b/i.test(message)) {
    return result('machine', 'node-gone', 'the node is no longer usable', e, true)
  }

  // --- Setting the node up (provisioner, octaneLicense, nodeManager). ---
  // Every dispatch runs these first inside withNodePrep (a Blender install,
  // Octane setup, an extension install, the scene upload), so a flaky node
  // failing them must not spend the chunk's render retries. A step that
  // fails the same way on a second node is more likely the job's (a Blender
  // version no mirror has, an add-on that will not enable): the job breaker,
  // counting this rule across nodes, is what says so.
  if (
    /^.+ failed \(exit (-?\d+|null)\)$/.test(message) ||
    /^(octane install|vnc start|OctaneServer launch) failed:/i.test(message) ||
    /^mkdir failed:/i.test(message)
  ) {
    return result('machine', 'node-setup', 'setting up the node failed', e, true)
  }
  // The first connection to a new instance (nodeManager.driveToReady).
  if (/^unexpected echo result:|^echo failed\b|^instance not running after\b/i.test(message)) {
    return result('machine', 'node-not-ready', 'the node never became usable', e, true)
  }

  // --- Vast replies with no status. ---
  if (vast && /network error:|non-JSON response/i.test(message)) {
    return result('transient', 'vast-network', 'could not reach Vast.ai', e, true)
  }

  return unrecognised(e, vast, 'unrecognised error')
}

/**
 * Nothing above recognised it. Called transient, an error nobody knows (a
 * TypeError in our own code, a path resolveInside refused) could be retried
 * until the infrastructure budget ran out, never reaching the job breaker,
 * while the fleet it ran on billed. So it is charged to the job: bounded by
 * the render retries, and on a second node the breaker puts its reason in
 * front of the user. From Vast it stays transient, with its outcome unknown:
 * there is no job to charge, and the rent batch's failure count and the scale
 * backoff bound it. Give an error its own rule before relying on its class.
 */
function unrecognised(e: unknown, vast: boolean, label: string): Classification {
  if (vast) return result('transient', 'unclassified', `${label} from Vast.ai`, e, true)
  return result('job', 'unclassified', label, e, true)
}
