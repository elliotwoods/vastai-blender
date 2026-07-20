/**
 * Octane on a node: X11/VNC desktop + OctaneServer with best-effort scripted
 * license sign-in. Credentials are injected via the exec environment only —
 * never written to node disk. Falls back to a one-click VNC tunnel for
 * manual sign-in when scripted flags aren't supported by the installed
 * OctaneServer build. Teardown SIGTERMs the server and waits for a clean
 * exit (which releases the floating license) BEFORE the instance is
 * destroyed — see docs/OCTANE.md for the manual recovery path.
 */

import { randomBytes } from 'crypto'
import { createServer, type Server } from 'net'
import { getDb } from '../db/db'
import { emit } from '../ipc'
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
    timeoutMs: 10 * 60_000
  })
  if (install.code !== 0) throw new Error(`octane install failed: ${install.stderr.slice(0, 300)}`)

  // Per-node generated VNC password (stored app-side only, in the node row).
  const password = randomBytes(9).toString('base64url')
  getDb().prepare('UPDATE nodes SET octane_ready = 0 WHERE id = ?').run(nodeId)
  const vnc = await ssh.exec(`bash ${script} start-vnc ${sq(password)}`, { timeoutMs: 60_000 })
  if (vnc.code !== 0) throw new Error(`vnc start failed: ${vnc.stderr.slice(0, 300)}`)
  vncPasswords.set(nodeId, password)

  // Launch OctaneServer, injecting credentials via env on the exec channel.
  const user = getSecret('otoyUsername')
  const pass = getSecret('otoyPassword')
  const env = user && pass ? `OCTANE_USER=${sq(user)} OCTANE_PASS=${sq(pass)} ` : ''
  const launch = await ssh.exec(`${env}bash ${script} start-server`, { timeoutMs: 60_000 })
  if (launch.code !== 0)
    throw new Error(`OctaneServer launch failed: ${launch.stderr.slice(0, 300)}`)

  // Poll the server log for license acquisition (60s budget).
  const deadline = Date.now() + 60_000
  let licensed = false
  while (Date.now() < deadline) {
    const r = await ssh.exec(
      `grep -iE 'license|logged in|activated' ${REMOTE_ROOT}/logs/octane-server.log 2>/dev/null | tail -3`
    )
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
    emit('alert', {
      level: 'warn',
      message:
        'Octane license not confirmed — open the VNC tunnel from the fleet view and sign in manually.'
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

/** Drain hook: release the license before the instance is destroyed. */
export async function stopOctaneServer(ssh: SshConnection): Promise<void> {
  await ssh
    .exec(`bash ${REMOTE_ROOT}/octane/setup_octane.sh stop-server`, { timeoutMs: 45_000 })
    .catch(() => {
      // best effort — docs/OCTANE.md covers manual license release
    })
}
