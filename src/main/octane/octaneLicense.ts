/**
 * Octane on a node (plan 1.18): an X11/VNC desktop, OctaneServer in it, and
 * the OTOY sign-in its floating licence needs.
 *
 * Any credential used on a rented node is disclosed to the host's owner:
 * root there can read OctaneServer's memory, whatever route the credential
 * took to it. So the sign-in is by hand by default, on the node's desktop
 * over VNC, which listens on the node's localhost only and is reached
 * through the node's SSH connection (openVncTunnel, node:openVncTunnel: the
 * node panel's Open VNC login, which the alerts below name). A scripted
 * sign-in is the user's explicit opt-in (settings.octane.scriptedSignIn,
 * off unless set): the credentials then go on the exec channel's stdin to
 * `setup_octane.sh start-server --credentials-stdin`, which hands them on
 * to OctaneServer's stdin. They are never in a command line, the
 * environment, a file on the node, or an error's text (exec errors name
 * the label). With settings.octane.secureCloudOnly on as well, they go only
 * to a node this session rented through that filter (setRentalFacts); any
 * other node an Octane chunk reaches signs in by hand. The per-node VNC
 * password goes on stdin too, and is kept in memory only: after a restart
 * the app sets a new one when it next opens the tunnel.
 *
 * nodes.octane_state says where a node's Octane is, as setup_octane.sh's
 * `OCTANE_STATE <word>` lines say it (OctaneState: none | serverRunning |
 * licensed | needsLogin), with one rule of the app's: a server that has run
 * OCTANE_LICENSE_WAIT_MS with no licence line in its log is waiting for a
 * sign-in (needsLogin). octane_ready is kept in step for older builds on the
 * same profile. setupOctane is safe to repeat: the script never starts a
 * second VNC or server, nor stops a running one. nodeManager polls the state
 * of every node that has run Octane (refreshOctaneState), which is how a
 * sign-in by hand moves a node from needsLogin to licensed.
 *
 * Every destroy (nodeManager's ensureInstanceGone) SIGTERMs the server and
 * waits, up to 20 s, for a clean exit (which releases the floating license)
 * BEFORE destroying the instance, on any node with an OctaneServer pidfile
 * that it still has a connection to. A node already unreachable, or one
 * destroyed at start-up before it was reconnected, is not stopped — see
 * docs/OCTANE.md for the manual recovery path.
 */

import { randomBytes } from 'crypto'
import { createServer, type Server } from 'net'
import { getDb } from '../db/db'
import { emit } from '../events'
import { ConnectionLostError, exitStatus, REMOTE_ROOT } from '../nodes/provisioner'
import { getSecret, getSettings } from '../settings'
import type { ExecOptions, ExecResult, SshConnection } from '../ssh/sshConnection'
import type { EngineId, OctaneState, VncTunnelInfo } from '../../shared/models'

const SCRIPT = `${REMOTE_ROOT}/octane/setup_octane.sh`

/** Where Octane jobs' Blender must be: noderunner.py's OCTANE_BLENDER. */
export const OCTANE_BLENDER = '/usr/local/OctaneBlender/blender'

/**
 * How long a server may run with no licence line in its log before it is
 * taken to be waiting for a sign-in (needsLogin). A scripted sign-in that
 * works logs one within seconds.
 */
export const OCTANE_LICENSE_WAIT_MS = 60_000

/**
 * How long an Octane dispatch waits, once, for the user to sign in by hand
 * on a node that needs it, holding the chunk rather than failing it: the
 * first Octane chunk on a new node always meets a server that needs a
 * sign-in, since that is the default. Once per node while it still needs
 * one, or every chunk given back to it would wait again, the node billing
 * idle each time.
 */
export const OCTANE_LOGIN_WAIT_MS = 10 * 60_000

/** How often setupOctane asks for the state while it waits. */
const STATE_POLL_MS = 5_000

const STATUS_TIMEOUT_MS = 30_000

/** The one line `status` and `start-server` print, its word an OctaneState. */
const STATE_LINE = /^OCTANE_STATE (none|serverRunning|licensed|needsLogin)$/m

/** start-vnc's refusal when display :0 is some other X server's (no VNC sign-in possible). */
const NOT_VNC = /not VNC/

/** start-server or stop-server gave up waiting for another on the node. */
const LOCK_BUSY = /another start-server or stop-server still running/

/**
 * Setup gave up waiting for a sign-in (OCTANE_LOGIN_WAIT_MS, once per node):
 * the node's OctaneServer runs with no licence. Nothing is wrong with the
 * machine or the job; the node is not usable for Octane until someone signs
 * in over VNC.
 *
 * Nothing but the user ends that, so the chunk must not simply go back to
 * the queue uncharged: sent again it fails again, and while it is pending it
 * keeps every idle node billing. Its job waits on the user instead (the
 * scheduler's jobs.attention) until a node reads licensed or the user acts
 * (octaneSignInHold).
 */
export class OctaneLoginNeededError extends Error {
  override readonly name = 'OctaneLoginNeededError'

  constructor() {
    super(
      'Octane is not signed in on this node: sign in to OTOY over VNC (Fleet → the node → ' +
        'Open VNC login), or destroy the node, which bills meanwhile'
    )
  }
}

/**
 * The node's image has no OctaneBlender, so no Octane job can render there
 * (stock Blender renders an Octane scene with another engine, #85). Found
 * before anything is set up: a VNC sign-in on such a node, or a licence
 * taken by a scripted one, would be for nothing.
 *
 * Whose fault that is turns on how the node was rented. `octaneImage`: this
 * session rented it for Octane, so from the docker image set for Octane
 * nodes, and every node rented from that image will lack it too: the job
 * cannot render until the setting changes. Otherwise (a node rented for
 * another engine, or from before a restart) only this node is unfit for
 * Octane (octaneUnfit), and a node rented from the Octane image may still
 * render the job.
 */
export class OctaneBlenderMissingError extends Error {
  override readonly name = 'OctaneBlenderMissingError'

  constructor(readonly octaneImage = false) {
    super(
      octaneImage
        ? `Octane job, but the docker image set for Octane nodes has no OctaneBlender ` +
            `(${OCTANE_BLENDER}): set one that has it (Settings → Docker image for Octane)`
        : `Octane job, but OctaneBlender is not installed on this node (${OCTANE_BLENDER}): ` +
            'Octane chunks need a node rented from the docker image set for Octane nodes'
    )
  }
}

/** exec's options, and the stdin the command reads its secrets from. */
type StdinExecOptions = ExecOptions & { stdin?: string }

/** The state word of setup_octane.sh's OCTANE_STATE line, or null without one. */
export function parseOctaneState(stdout: string): OctaneState | null {
  const m = STATE_LINE.exec(stdout)
  return m ? (m[1] as OctaneState) : null
}

/** A nodes.octane_state value as an OctaneState; anything else is 'none'. */
export function asOctaneState(v: unknown): OctaneState {
  return v === 'serverRunning' || v === 'licensed' || v === 'needsLogin' ? v : 'none'
}

// -- per node, this session ------------------------------------------------------

const vncSessions = new Map<
  string,
  { server: Server; port: number; password: string; ssh: SshConnection }
>()
/** The VNC password this session set on each node (start-vnc). */
const vncPasswords = new Map<string, string>()
/** When each node's server was first seen running with no licence line, this session. */
const unlicensedSince = new Map<string, number>()
/** Nodes a dispatch has already waited OCTANE_LOGIN_WAIT_MS on, while they still need a sign-in. */
const loginWaited = new Set<string>()
/** Nodes whose needsLogin has been announced, while it lasts. */
const loginAlerted = new Set<string>()
/** Nodes the setup found without OctaneBlender, until a later check finds it. */
const blenderMissing = new Set<string>()
/**
 * A sign-in by hand that nobody made (octaneSignInHold): the node whose
 * wait ran out, and when.
 */
let signInMissed: { nodeId: string; since: number } | null = null

const stateListeners = new Set<(nodeId: string, state: OctaneState) => void>()

/**
 * Hear each change of a node's octane_state, whoever made it (setupOctane,
 * the licence poll): nodeManager pushes the node's snapshot. Returns the
 * unsubscribe function.
 */
export function onOctaneState(listener: (nodeId: string, state: OctaneState) => void): () => void {
  stateListeners.add(listener)
  return () => {
    stateListeners.delete(listener)
  }
}

// -- what each node was rented as --------------------------------------------------

/**
 * What nodeManager rented a node as, this session: the engine the rental
 * was for (for Octane, the docker image set for Octane nodes), and whether
 * only datacenter (secure cloud) hosts could take it. Null when not known:
 * a node from before a restart, the facts being kept in memory only.
 */
export interface OctaneRentalFacts {
  engine: EngineId | null
  secureCloud: boolean
}

let rentalFacts: (nodeId: string) => OctaneRentalFacts | null = () => null

/**
 * nodeManager's rentals, by node (plan 1.18 review). Unset, or null for a
 * node, is not known: no secure host, no Octane image.
 */
export function setRentalFacts(provider: (nodeId: string) => OctaneRentalFacts | null): void {
  rentalFacts = provider
}

function rentedAs(nodeId: string): OctaneRentalFacts | null {
  try {
    return rentalFacts(nodeId)
  } catch {
    return null
  }
}

/**
 * Whether the OTOY credentials may go to a node rented as `rental`, and are
 * there to go: the user opted in to the scripted sign-in (off unless set),
 * and, with secure cloud only on, the node was rented through that filter.
 * That setting keeps Octane rentals off hosts nobody vetted; without this
 * the credentials still reached one whenever an Octane chunk did (a Cycles
 * node on someone's own machine in a mixed queue, a rental made without its
 * engine, a node from before a restart). Anything not known to be secure is
 * taken not to be: it signs in by hand.
 */
export function scriptedSignInFor(rental: OctaneRentalFacts | null): boolean {
  const o = getSettings().octane
  if (o?.scriptedSignIn !== true) return false
  if (o.secureCloudOnly === true && rental?.secureCloud !== true) return false
  return !!getSecret('otoyUsername') && !!getSecret('otoyPassword')
}

/** The user opted in to the scripted sign-in, but the node is not one the credentials may go to. */
function signInWithheld(rental: OctaneRentalFacts | null): boolean {
  const o = getSettings().octane
  return o?.scriptedSignIn === true && o.secureCloudOnly === true && rental?.secureCloud !== true
}

/**
 * Why no Octane chunk should go to this node now, or null: for the
 * scheduler's dispatch and its idle scale-down, so a node that cannot render
 * the Octane work queued is let go rather than kept for it. Found by this
 * session's setups only.
 */
export function octaneUnfit(nodeId: string): string | null {
  if (blenderMissing.has(nodeId)) {
    return `OctaneBlender is not installed on this node (${OCTANE_BLENDER})`
  }
  if (loginWaited.has(nodeId)) {
    return 'nobody signed in to Octane on this node while its first Octane chunk waited'
  }
  if (signInMissed && storedState(nodeId) === 'needsLogin') {
    return 'its Octane waits for a sign-in, and one was already missed on another node'
  }
  return null
}

// -- a sign-in nobody made ----------------------------------------------------------

/** A sign-in by hand nobody made, as octaneSignInHold gives it. */
export interface OctaneSignInHold {
  nodeId: string
  since: number
  reason: string
}

/**
 * A sign-in by hand that nobody made (plan 1.18 review, field incident A1:
 * the user away, overnight). Set when a node's wait for a sign-in runs out,
 * and kept past that node, until a node reads licensed, the user opens a VNC
 * login (openVncTunnel), or releaseOctaneSignInHold. Null while there is
 * none.
 *
 * While it stands, no setup waits for a sign-in again (a scripted one still
 * gets the licence wait), and nodeManager rents no Octane node for
 * scale-up. Each such node would wait for a user who is not there, go idle,
 * be let go, and be rented again in its place, with no end. The scheduler
 * holds the job for the user on the OctaneLoginNeededError it gets. Kept in
 * memory only: a restart is the user acting.
 */
export function octaneSignInHold(): OctaneSignInHold | null {
  const m = signInMissed
  if (!m) return null
  return {
    ...m,
    reason:
      `nobody signed in to Octane on ${nodeName(m.nodeId)} within ` +
      `${Math.round(OCTANE_LOGIN_WAIT_MS / 60_000)} min: sign in over VNC (Fleet → the node → ` +
      'Open VNC login)'
  }
}

/**
 * The user acted on a missed sign-in: resumed the job, or released the hold
 * by hand. Each node may be waited on once more, and says so again.
 */
export function releaseOctaneSignInHold(): void {
  signInMissed = null
  loginWaited.clear()
  loginAlerted.clear()
}

function storedState(nodeId: string): OctaneState {
  const row = getDb().prepare('SELECT octane_state FROM nodes WHERE id = ?').get(nodeId) as
    { octane_state: string } | undefined
  return asOctaneState(row?.octane_state)
}

/** How alerts name a node: its GPU and the first 8 characters of its id. */
function nodeName(nodeId: string): string {
  const row = getDb().prepare('SELECT gpu_name FROM nodes WHERE id = ?').get(nodeId) as
    { gpu_name: string | null } | undefined
  return `${row?.gpu_name ?? 'node'} ${nodeId.slice(0, 8)}`
}

function writeState(nodeId: string, state: OctaneState): void {
  const was = storedState(nodeId)
  getDb()
    .prepare('UPDATE nodes SET octane_state = ?, octane_ready = ? WHERE id = ?')
    .run(state, state === 'licensed' ? 1 : 0, nodeId)
  if (state === 'licensed' || state === 'none') {
    loginWaited.delete(nodeId)
    loginAlerted.delete(nodeId)
    unlicensedSince.delete(nodeId)
  }
  // Someone signed in: whoever missed one before is back.
  if (state === 'licensed') signInMissed = null
  if (was === state) return
  if (was === 'needsLogin' && state === 'licensed') {
    emit('alert', {
      level: 'info',
      message: `Octane on ${nodeName(nodeId)} is signed in: its Octane chunks can render`
    })
  }
  for (const l of [...stateListeners]) {
    try {
      l(nodeId, state)
    } catch {
      // A listener's failure is its own.
    }
  }
}

/**
 * The state the script reported, as the app takes it. A server running
 * with no licence line (serverRunning) past OCTANE_LICENSE_WAIT_MS is
 * waiting for a sign-in; one the app already judged so stays so (after a
 * restart the clock starts again, and the node would flicker back),
 * unless it is a server just launched (`fresh`).
 */
function judge(nodeId: string, word: OctaneState, fresh = false, now = Date.now()): OctaneState {
  if (word !== 'serverRunning') return word
  if (fresh) unlicensedSince.set(nodeId, now)
  else if (storedState(nodeId) === 'needsLogin') return 'needsLogin'
  const since = unlicensedSince.get(nodeId) ?? now
  unlicensedSince.set(nodeId, since)
  return now - since >= OCTANE_LICENSE_WAIT_MS ? 'needsLogin' : 'serverRunning'
}

/** A command that ended with no exit status never answered: the link went (provisioner's rule). */
function answered(r: ExecResult, label: string): ExecResult {
  if (exitStatus(r.code) === null) throw new ConnectionLostError(label)
  return r
}

/**
 * What a failed command said: its stderr, else the script's last log line,
 * else its last other line but a state word. setup_octane.sh prints some
 * refusals on plain stdout: start-vnc's "missing vnc password", which every
 * setup meets while the exec sends no stdin, read "vnc start failed: exit 1".
 */
function said(r: ExecResult): string {
  const err = r.stderr.trim()
  if (err) return err.slice(0, 300)
  const lines = r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !/^OCTANE_[A-Z]+ /.test(l))
  const logged = lines.filter((l) => l.startsWith('[octane]')).at(-1) ?? lines.at(-1)
  return logged ? logged.slice(0, 300) : `exit ${r.code}`
}

/**
 * The node's VNC password for this session: the one already chosen, or a
 * new one, recorded before anything is sent. After a restart a dispatch's
 * setup and the user's Open VNC login can both reach start-vnc at once;
 * each choosing its own left the node with whichever landed last, while the
 * tunnel handed out the other for as long as the connection lasted.
 * start-vnc writes the password even while VNC runs, so every caller
 * sending this one leaves the node taking it.
 */
function vncPassword(nodeId: string): string {
  let password = vncPasswords.get(nodeId)
  if (!password) {
    password = randomBytes(9).toString('base64url')
    vncPasswords.set(nodeId, password)
  }
  return password
}

/**
 * Set the node's VNC password and start VNC on :0 unless it runs (the
 * script never restarts a running one, so a sign-in under way is kept).
 * The password goes on stdin. Resolves 'ok', or 'notVnc' when display :0
 * belongs to an X server that is not VNC: no sign-in by hand is possible
 * on that node.
 */
async function startVnc(ssh: SshConnection, password: string): Promise<'ok' | 'notVnc'> {
  const opts: StdinExecOptions = { timeoutMs: 60_000, label: 'start VNC', stdin: `${password}\n` }
  const vnc = answered(
    await ssh.exec(`bash ${SCRIPT} start-vnc --password-stdin`, opts),
    'start VNC'
  )
  if (vnc.code === 0) return 'ok'
  if (NOT_VNC.test(vnc.stderr)) return 'notVnc'
  throw new Error(`vnc start failed: ${said(vnc)}`)
}

/** `status`, judged and kept. Throws if it could not be read. */
async function readState(ssh: SshConnection, nodeId: string): Promise<OctaneState> {
  const r = answered(
    await ssh.exec(`bash ${SCRIPT} status`, {
      timeoutMs: STATUS_TIMEOUT_MS,
      label: 'read Octane state'
    }),
    'read Octane state'
  )
  const word = r.code === 0 ? parseOctaneState(r.stdout) : null
  if (!word) throw new Error(`Octane state unreadable: ${said(r)}`)
  const state = judge(nodeId, word)
  writeState(nodeId, state)
  return state
}

/**
 * The licence poll (nodeManager, for every node that has run Octane): read
 * the node's state and keep octane_state to it. A sign-in by hand moves it
 * to licensed; a server that died, to none. Null when the state could not
 * be read; never rejects.
 */
export async function refreshOctaneState(
  ssh: SshConnection,
  nodeId: string
): Promise<OctaneState | null> {
  try {
    return await readState(ssh, nodeId)
  } catch {
    return null
  }
}

/** The scripted sign-in was withheld from this node: see scriptedSignInFor. */
const WITHHELD =
  ' The scripted sign-in was not used: this node was not rented as a datacenter (secure ' +
  'cloud) host, which the Octane settings send the OTOY credentials to only.'

function announceLogin(nodeId: string, withheld: boolean): void {
  if (loginAlerted.has(nodeId)) return
  loginAlerted.add(nodeId)
  emit('alert', {
    level: 'warn',
    message:
      `Octane on ${nodeName(nodeId)} is waiting for a sign-in: open the node in Fleet, use ` +
      'Open VNC login, and sign in to OTOY there. Its Octane chunks start once it is licensed; ' +
      `the node bills meanwhile.${withheld ? WITHHELD : ''}`
  })
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms)
    function done(): void {
      clearTimeout(t)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done)
  })
}

/**
 * Make the node ready for an Octane chunk: OctaneBlender present, the X11/VNC
 * desktop up, OctaneServer running and licensed. Resolves 'licensed'.
 * Safe to repeat: nothing running is restarted.
 *
 * A server that needs a sign-in is waited on, OCTANE_LOGIN_WAIT_MS at most
 * and once per node while it still needs one (OctaneLoginNeededError after
 * that), with one alert telling the user where to sign in; not at all once
 * a sign-in has been missed (octaneSignInHold). `signal` ends the wait
 * early. Credentials are sent only when the user opted in to the
 * scripted sign-in, only to a node they may go to (scriptedSignInFor), and
 * only on stdin.
 *
 * Throws OctaneBlenderMissingError, OctaneLoginNeededError,
 * ConnectionLostError (a command the link dropped under), or a setup
 * failure ('octane install failed: …', 'vnc start failed: …',
 * 'OctaneServer launch failed: …', the node-setup rule in errors.ts).
 */
export async function setupOctane(
  ssh: SshConnection,
  nodeId: string,
  opts: { loginWaitMs?: number; signal?: AbortSignal } = {}
): Promise<OctaneState> {
  const check = answered(
    await ssh.exec(`test -x ${OCTANE_BLENDER}`, {
      timeoutMs: 30_000,
      label: 'check OctaneBlender'
    }),
    'check OctaneBlender'
  )
  if (check.code !== 0) {
    blenderMissing.add(nodeId)
    throw new OctaneBlenderMissingError(rentedAs(nodeId)?.engine === 'octane')
  }
  blenderMissing.delete(nodeId)

  const install = answered(
    await ssh.exec(`chmod +x ${SCRIPT} && bash ${SCRIPT} install`, {
      timeoutMs: 10 * 60_000,
      label: 'install Octane'
    }),
    'install Octane'
  )
  if (install.code !== 0) throw new Error(`octane install failed: ${said(install)}`)

  const rental = rentedAs(nodeId)
  const scripted = scriptedSignInFor(rental)
  const withheld = signInWithheld(rental)
  if ((await startVnc(ssh, vncPassword(nodeId))) === 'notVnc' && !scripted) {
    // OctaneServer would run on that display, but nobody could sign it in.
    throw new Error(
      'vnc start failed: display :0 on this node is held by an X server that is not VNC, ' +
        'so there is no way to sign in to Octane by hand here' +
        (withheld ? ', and the scripted sign-in goes to datacenter hosts only' : '')
    )
  }

  const user = scripted ? getSecret('otoyUsername') : null
  const pass = scripted ? getSecret('otoyPassword') : null
  const launchOpts: StdinExecOptions =
    user && pass
      ? // The script reads the two lines before its 40 s wait for the lock.
        { timeoutMs: 90_000, label: 'start OctaneServer', stdin: `${user}\n${pass}\n` }
      : { timeoutMs: 60_000, label: 'start OctaneServer' }
  const launch = answered(
    await ssh.exec(
      `bash ${SCRIPT} start-server${launchOpts.stdin ? ' --credentials-stdin' : ''}`,
      launchOpts
    ),
    'start OctaneServer'
  )
  if (launch.code !== 0) {
    if (LOCK_BUSY.test(launch.stderr)) {
      throw new Error(
        'OctaneServer launch failed: another start or stop of OctaneServer is still running on the node'
      )
    }
    throw new Error(`OctaneServer launch failed: ${said(launch)}`)
  }
  const word = parseOctaneState(launch.stdout)
  if (!word) throw new Error('OctaneServer launch failed: setup_octane.sh reported no state')
  let state = judge(nodeId, word, /OctaneServer launched/.test(launch.stdout))
  writeState(nodeId, state)

  // A sign-in already missed on some node (octaneSignInHold): nobody is
  // there to sign this one in either, so only a scripted sign-in's licence
  // line is waited for.
  const loginWaitMs = signInMissed ? 0 : (opts.loginWaitMs ?? OCTANE_LOGIN_WAIT_MS)
  // However the reads go: a node whose state cannot be read is waited on
  // no longer than one that says it needs a sign-in.
  const giveUpAt = Date.now() + OCTANE_LICENSE_WAIT_MS + loginWaitMs
  let loginDeadline = Infinity
  while (state !== 'licensed') {
    if (state === 'none') {
      throw new Error('OctaneServer launch failed: the server stopped before it was licensed')
    }
    if (state === 'needsLogin') {
      announceLogin(nodeId, withheld)
      if (loginWaited.has(nodeId)) throw new OctaneLoginNeededError()
      if (loginDeadline === Infinity) loginDeadline = Date.now() + loginWaitMs
    }
    if (Date.now() >= Math.min(loginDeadline, giveUpAt)) {
      loginWaited.add(nodeId)
      // Asked for a sign-in, and none came. Not a node whose state could
      // not be read: that says nothing of the user.
      if (loginDeadline !== Infinity) signInMissed ??= { nodeId, since: Date.now() }
      throw new OctaneLoginNeededError()
    }
    if (opts.signal?.aborted) throw new Error('Octane setup stopped: the chunk was taken back')
    await sleep(STATE_POLL_MS, opts.signal)
    if (opts.signal?.aborted) throw new Error('Octane setup stopped: the chunk was taken back')
    try {
      state = await readState(ssh, nodeId)
    } catch (e) {
      // The link is gone for good (the node destroyed, the app closing): no
      // sign-in can reach this wait. Anything else is no answer yet.
      if (e instanceof ConnectionLostError || /^connection closed\b/.test((e as Error).message)) {
        throw e
      }
    }
  }
  return state
}

/**
 * Open a local TCP listener tunnelled to the node's localhost:5900 VNC over
 * the node's SSH connection, for the sign-in by hand (Fleet → the node →
 * Open VNC login). Returns the local port and the node's VNC password.
 *
 * Each new tunnel runs start-vnc first, with the password this session set
 * or, after a restart, a new one: the viewer always gets a password that
 * works, and a VNC server that died is started again. A VNC session already
 * open is kept as it is. A node whose display :0 is not VNC's has no sign-in
 * by hand, and says so.
 */
export async function openVncTunnel(ssh: SshConnection, nodeId: string): Promise<VncTunnelInfo> {
  const existing = vncSessions.get(nodeId)
  if (existing && existing.ssh === ssh) {
    return { localPort: existing.port, password: existing.password }
  }
  // A tunnel over a connection the node has since replaced leads nowhere.
  if (existing) closeVncTunnel(nodeId)

  const password = vncPassword(nodeId)
  if ((await startVnc(ssh, password)) === 'notVnc') {
    throw new Error(
      'no VNC sign-in on this node: its display :0 is held by an X server that is not VNC'
    )
  }
  // The user is at the node's desktop: a sign-in missed before is theirs to
  // make now, and this node's next Octane chunk may wait for it again.
  signInMissed = null
  loginWaited.delete(nodeId)

  const server = createServer((socket) => {
    void ssh
      .forwardOut('127.0.0.1', 5900)
      .then((stream) => {
        socket.pipe(stream).pipe(socket)
        stream.on('error', () => socket.destroy())
        socket.on('error', () => stream.end())
      })
      .catch(() => socket.destroy())
  })
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') resolve(addr.port)
      else reject(new Error('no address'))
    })
  })
  vncSessions.set(nodeId, { server, port, password, ssh })
  return { localPort: port, password }
}

export function closeVncTunnel(nodeId: string): void {
  const s = vncSessions.get(nodeId)
  if (s) {
    s.server.close()
    vncSessions.delete(nodeId)
  }
}

/** A node going away: its tunnel closed and everything kept for it here dropped. */
export function forgetOctaneNode(nodeId: string): void {
  closeVncTunnel(nodeId)
  vncPasswords.delete(nodeId)
  unlicensedSince.delete(nodeId)
  loginWaited.delete(nodeId)
  loginAlerted.delete(nodeId)
  blenderMissing.delete(nodeId)
  // Not signInMissed: the node going (let go idle) is not anyone signing in.
}

/** Where setup_octane.sh records the OctaneServer it launched ($VASTAI_HOME/state). */
export const OCTANE_PIDFILE = `${REMOTE_ROOT}/state/octane-server.pid`

/**
 * Drain hook: release the license before the instance is destroyed.
 *
 * `onlyIfStarted` runs the stop only on a node with an OctaneServer pidfile,
 * which setup_octane.sh writes at every launch: every destroy path asks
 * (nodeManager's ensureInstanceGone), and most nodes never ran Octane.
 * `timeoutMs` bounds the whole call, connecting included; the default covers
 * the script's own 30 s wait for a clean exit.
 */
export async function stopOctaneServer(
  ssh: SshConnection,
  opts: { timeoutMs?: number; onlyIfStarted?: boolean } = {}
): Promise<void> {
  const stop = `bash ${SCRIPT} stop-server`
  const command = opts.onlyIfStarted ? `if [ -f ${OCTANE_PIDFILE} ]; then ${stop}; fi` : stop
  await ssh
    .exec(command, { timeoutMs: opts.timeoutMs ?? 45_000, label: 'stop OctaneServer' })
    .catch(() => {
      // best effort — docs/OCTANE.md covers manual license release
    })
}
