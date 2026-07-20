/**
 * SSH keypair management: generate an ed25519 keypair on first use (via the
 * Windows-bundled ssh-keygen) and register the public key account-wide with
 * Vast.ai — vast then injects it into every new instance.
 */

import { execFile } from 'child_process'
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import { updateSettings } from '../settings'
import { listSshKeys, registerSshKey } from '../vast/vastClient'

const execFileAsync = promisify(execFile)

export function keyDir(): string {
  return join(app.getPath('userData'), 'ssh')
}

export function privateKeyPath(): string {
  return join(keyDir(), 'id_ed25519')
}

export function publicKeyPath(): string {
  return `${privateKeyPath()}.pub`
}

/** Generate the keypair if missing. Returns the private key path. */
export async function ensureKeypair(): Promise<string> {
  const priv = privateKeyPath()
  if (!existsSync(priv)) {
    mkdirSync(keyDir(), { recursive: true })
    await execFileAsync('ssh-keygen', [
      '-t',
      'ed25519',
      '-f',
      priv,
      '-N',
      '',
      '-C',
      'vastai-blender'
    ])
    updateSettings({ sshKeyPath: priv })
  }
  return priv
}

export function readPrivateKey(): Buffer {
  return readFileSync(privateKeyPath())
}

export function readPublicKey(): string {
  return readFileSync(publicKeyPath(), 'utf-8').trim()
}

/** Idempotently register our public key with the vast account. */
export async function ensureKeyRegistered(): Promise<void> {
  await ensureKeypair()
  const pub = readPublicKey()
  // Compare on the key material (type + base64), ignoring comments.
  const material = pub.split(' ').slice(0, 2).join(' ')
  const existing = await listSshKeys()
  if (existing.some((k) => k.public_key.split(' ').slice(0, 2).join(' ') === material)) return
  await registerSshKey(pub)
}
