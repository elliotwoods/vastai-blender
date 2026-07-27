/**
 * "Open a shell on this node" — spawns the platform terminal running the same
 * ssh identity the app itself uses (userData/ssh/id_ed25519), so a human can
 * poke at a node without hunting for the key path or the mapped port.
 *
 * The renderer always has a fallback: `sshCommandFor()` returns the exact
 * command line, which the Fleet screen copies to the clipboard when spawning a
 * terminal isn't possible (unknown desktop environment, node not up yet).
 */

import { spawn, spawnSync } from 'child_process'
import { existsSync } from 'fs'
import type { SshCommandInfo } from '../../shared/models'
import { getSettings } from '../settings'
import { privateKeyPath } from './keys'

/** Quote for a POSIX-ish shell (used by the macOS/Linux terminal launchers). */
function shq(s: string): string {
  return /[^\w@%+=:,./-]/.test(s) ? `'${s.replace(/'/g, `'\\''`)}'` : s
}

export function sshTargetFor(node: {
  sshHost: string | null
  sshPort: number | null
}): SshCommandInfo | null {
  if (!node.sshHost || !node.sshPort) return null
  const keyPath = getSettings().sshKeyPath || privateKeyPath()
  const user = 'root'
  // accept-new: the app pins the host key itself, and an interactive
  // yes/no prompt in a freshly spawned window is pure friction.
  const args = [
    '-i',
    keyPath,
    '-p',
    String(node.sshPort),
    '-o',
    'StrictHostKeyChecking=accept-new',
    `${user}@${node.sshHost}`
  ]
  return {
    host: node.sshHost,
    port: node.sshPort,
    user,
    keyPath,
    command: `ssh ${args.map(shq).join(' ')}`
  }
}

function detached(cmd: string, args: string[]): void {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
  // A missing binary surfaces as an async 'error' event — unhandled, that
  // throws in the main process, so swallow it here (the caller's ok/false
  // path is the user-visible fallback).
  child.on('error', () => {})
  child.unref()
}

/** Is this terminal emulator on PATH? (Linux only — spawn errors are async.) */
function onPath(bin: string): boolean {
  return spawnSync('which', [bin], { stdio: 'ignore' }).status === 0
}

/**
 * Open an interactive ssh session in a terminal window. Returns a message for
 * the UI; `ok: false` means the caller should fall back to copying `command`.
 */
export function openSshTerminal(target: SshCommandInfo): { ok: boolean; message: string } {
  if (!existsSync(target.keyPath)) {
    return { ok: false, message: `ssh key not found at ${target.keyPath}` }
  }
  const sshArgs = [
    'ssh',
    '-i',
    target.keyPath,
    '-p',
    String(target.port),
    '-o',
    'StrictHostKeyChecking=accept-new',
    `${target.user}@${target.host}`
  ]

  try {
    if (process.platform === 'win32') {
      // `start ""` gives the new console its own window; the empty string is the
      // window title, without which `start` would eat the first quoted argument.
      detached('cmd.exe', ['/c', 'start', '', 'cmd.exe', '/k', ...sshArgs])
      return { ok: true, message: `ssh ${target.user}@${target.host}:${target.port}` }
    }
    if (process.platform === 'darwin') {
      const script = `tell application "Terminal" to do script ${JSON.stringify(target.command)}\ntell application "Terminal" to activate`
      detached('osascript', ['-e', script.split('\n')[0], '-e', script.split('\n')[1]])
      return { ok: true, message: `ssh ${target.user}@${target.host}:${target.port}` }
    }
    // Linux: first emulator actually installed wins.
    for (const term of ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm']) {
      if (!onPath(term)) continue
      detached(term, ['-e', ...sshArgs])
      return { ok: true, message: `ssh ${target.user}@${target.host}:${target.port}` }
    }
    return { ok: false, message: 'no terminal emulator found — command copied instead' }
  } catch (err) {
    return { ok: false, message: `could not open a terminal: ${(err as Error).message}` }
  }
}
