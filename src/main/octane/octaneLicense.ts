/**
 * Octane on a node: X11/VNC desktop + OctaneServer with best-effort scripted
 * license sign-in. Credentials travel as env assignments in the exec command
 * text and, when the build takes them, as OctaneServer's argv. No file on the
 * node holds them, but root on the host can read both, so they are disclosed
 * to the host (plan 1.18 moves them to stdin and makes manual sign-in the
 * default). The manual path is meant to be openVncTunnel below, but nothing
 * in the renderer calls node:openVncTunnel yet (plan 1.18 adds the button).
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
import { REMOTE_ROOT } from '../nodes/provisioner'
import { getSecret } from '../settings'
import type { SshConnection } from '../ssh/sshConnection'

const vncSessions = new Map<string, { server: Server; port: number; password: string }>()

/** Shell-safe single-quoted string. */
function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

export async function setupOctane(ssh: SshConnection, nodeId: string): Promise<void> {
  const script = `${REMOTE_ROOT}/octane/setup_octane.sh`
  const install = await ssh.exec(`chmod +x ${script} && bash ${script} install`, {
    timeoutMs: 10 * 60_000,
    label: 'install Octane'
  })
  if (install.code !== 0) throw new Error(`octane install failed: ${install.stderr.slice(0, 300)}`)

  // Per-node generated VNC password, held app-side only: in vncPasswords
  // below (memory, not the node row), so an app restart loses it.
  const password = randomBytes(9).toString('base64url')
  getDb().prepare('UPDATE nodes SET octane_ready = 0 WHERE id = ?').run(nodeId)
  const vnc = await ssh.exec(`bash ${script} start-vnc ${sq(password)}`, {
    timeoutMs: 60_000,
    label: 'start VNC'
  })
  if (vnc.code !== 0) throw new Error(`vnc start failed: ${vnc.stderr.slice(0, 300)}`)
  vncPasswords.set(nodeId, password)

  // Launch OctaneServer, with credentials as env assignments at the front of
  // the command text (plan 1.18 moves them to stdin). An exec error names
  // the label, never that text (plan 1.8), so a timeout here no longer puts
  // them in the dispatch-failed alert.
  const user = getSecret('otoyUsername')
  const pass = getSecret('otoyPassword')
  const env = user && pass ? `OCTANE_USER=${sq(user)} OCTANE_PASS=${sq(pass)} ` : ''
  const launch = await ssh.exec(`${env}bash ${script} start-server`, {
    timeoutMs: 60_000,
    label: 'start OctaneServer'
  })
  if (launch.code !== 0)
    throw new Error(`OctaneServer launch failed: ${launch.stderr.slice(0, 300)}`)

  // Poll the server log for license acquisition (60s budget).
  const deadline = Date.now() + 60_000
  let licensed = false
  while (Date.now() < deadline) {
    // Bounded: this runs inside the scheduler's per-node prep lock, and an
    // exec on a wedged connection never returned. A read that fails is no
    // answer yet; the loop's own deadline ends it.
    const r = await ssh
      .exec(
        `grep -iE 'license|logged in|activated' ${REMOTE_ROOT}/logs/octane-server.log 2>/dev/null | tail -3`,
        { timeoutMs: 30_000, label: 'read OctaneServer log' }
      )
      .catch(() => ({ code: null, stdout: '', stderr: '' }))
    if (/acquir|success|logged in|activated/i.test(r.stdout)) {
      licensed = true
      break
    }
    if (/fail|invalid|denied/i.test(r.stdout)) break
    await new Promise((res) => setTimeout(res, 5_000))
  }
  getDb()
    .prepare('UPDATE nodes SET octane_ready = ? WHERE id = ?')
    .run(licensed ? 1 : 0, nodeId)
  if (!licensed) {
    // The fleet view has no VNC sign-in yet (nothing calls
    // node:openVncTunnel; plan 1.18 adds it), so the alert must not send the
    // user looking for one. octane_ready = 0 also re-runs this setup on the
    // next Octane dispatch to the node.
    emit('alert', {
      level: 'warn',
      message:
        'Octane license not confirmed on this node, and the app cannot open a VNC sign-in yet ' +
        '(see docs/OCTANE.md). Destroy the node if it cannot be licensed — it bills meanwhile.'
    })
  }
}

const vncPasswords = new Map<string, string>()

/**
 * Open a local TCP listener tunnelled to the node's localhost:5900 VNC via
 * the pooled SSH connection. Returns the local port + generated password.
 */
export async function openVncTunnel(
  ssh: SshConnection,
  nodeId: string
): Promise<{ localPort: number; password: string }> {
  const existing = vncSessions.get(nodeId)
  if (existing) return { localPort: existing.port, password: existing.password }

  const password = vncPasswords.get(nodeId) ?? ''
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
  vncSessions.set(nodeId, { server, port, password })
  return { localPort: port, password }
}

export function closeVncTunnel(nodeId: string): void {
  const s = vncSessions.get(nodeId)
  if (s) {
    s.server.close()
    vncSessions.delete(nodeId)
  }
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
  const stop = `bash ${REMOTE_ROOT}/octane/setup_octane.sh stop-server`
  const command = opts.onlyIfStarted ? `if [ -f ${OCTANE_PIDFILE} ]; then ${stop}; fi` : stop
  await ssh
    .exec(command, { timeoutMs: opts.timeoutMs ?? 45_000, label: 'stop OctaneServer' })
    .catch(() => {
      // best effort — docs/OCTANE.md covers manual license release
    })
}
