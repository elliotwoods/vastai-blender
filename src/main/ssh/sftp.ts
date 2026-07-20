/**
 * Promise helpers over ssh2's SFTPWrapper: recursive upload of the remote/
 * tree, hash-skipped big-file uploads, and verified downloads (.part →
 * verify → rename) driven by manifest entries.
 */

import { createHash } from 'crypto'
import { createReadStream, promises as fsp } from 'fs'
import { basename, dirname, join, posix } from 'path'
import type { SFTPWrapper } from 'ssh2'
import type { SshConnection } from './sshConnection'

export async function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(path)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject)
  })
}

function fastPut(sftp: SFTPWrapper, local: string, remote: string): Promise<void> {
  return new Promise((resolve, reject) =>
    sftp.fastPut(local, remote, (err) => (err ? reject(err) : resolve()))
  )
}

function fastGet(sftp: SFTPWrapper, remote: string, local: string): Promise<void> {
  return new Promise((resolve, reject) =>
    sftp.fastGet(remote, local, (err) => (err ? reject(err) : resolve()))
  )
}

export function sftpWriteFile(sftp: SFTPWrapper, remote: string, data: string): Promise<void> {
  return new Promise((resolve, reject) =>
    sftp.writeFile(remote, Buffer.from(data, 'utf-8'), (err) => (err ? reject(err) : resolve()))
  )
}

export function sftpReadFile(sftp: SFTPWrapper, remote: string): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    sftp.readFile(remote, (err, data) => (err ? reject(err) : resolve(data)))
  )
}

export function sftpRename(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) =>
    sftp.rename(from, to, (err) => (err ? reject(err) : resolve()))
  )
}

/** mkdir -p via exec (simpler and more reliable than SFTP mkdir recursion). */
export async function remoteMkdirp(ssh: SshConnection, dir: string): Promise<void> {
  const r = await ssh.exec(`mkdir -p '${dir}'`)
  if (r.code !== 0) throw new Error(`mkdir failed: ${r.stderr}`)
}

/**
 * Upload a whole local directory tree (the repo's remote/ scripts) to
 * remoteDir. Small files — no skip logic needed.
 */
export async function uploadTree(
  ssh: SshConnection,
  localDir: string,
  remoteDir: string
): Promise<number> {
  const sftp = await ssh.sftp()
  let count = 0
  const walk = async (dir: string, rel: string): Promise<void> => {
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    await remoteMkdirp(ssh, posix.join(remoteDir, rel))
    for (const e of entries) {
      const localPath = join(dir, e.name)
      const relPath = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        await walk(localPath, relPath)
      } else {
        await fastPut(sftp, localPath, posix.join(remoteDir, relPath))
        count++
      }
    }
  }
  await walk(localDir, '')
  return count
}

/**
 * Upload one large file (blend/extension zip), skipping when the remote copy
 * already matches by sha256 (checked via sha256sum on the node).
 */
export async function uploadFileVerified(
  ssh: SshConnection,
  localPath: string,
  remotePath: string
): Promise<'uploaded' | 'skipped'> {
  const hash = await sha256File(localPath)
  const check = await ssh.exec(`sha256sum '${remotePath}' 2>/dev/null | cut -d' ' -f1`)
  if (check.stdout.trim() === hash) return 'skipped'
  const sftp = await ssh.sftp()
  await remoteMkdirp(ssh, posix.dirname(remotePath))
  const part = `${remotePath}.part`
  await fastPut(sftp, localPath, part)
  const after = await ssh.exec(`sha256sum '${part}' | cut -d' ' -f1`)
  if (after.stdout.trim() !== hash) {
    await ssh.exec(`rm -f '${part}'`)
    throw new Error(`upload verify failed for ${basename(localPath)}`)
  }
  await sftpRename(sftp, part, remotePath)
  return 'uploaded'
}

/**
 * Download one manifest-listed file: fastGet → .part, verify size + sha256
 * (size-only for legacy manifest entries without a hash), rename into place.
 * Skips if the local file already exists and verifies (resume after restart).
 */
export async function downloadFileVerified(
  ssh: SshConnection,
  remotePath: string,
  localPath: string,
  expected: { size: number; sha256?: string }
): Promise<'downloaded' | 'skipped'> {
  try {
    const st = await fsp.stat(localPath)
    if (
      st.size === expected.size &&
      (!expected.sha256 || (await sha256File(localPath)) === expected.sha256)
    ) {
      return 'skipped'
    }
  } catch {
    // not present — download
  }
  await fsp.mkdir(dirname(localPath), { recursive: true })
  const sftp = await ssh.sftp()
  const part = `${localPath}.part`
  await fastGet(sftp, remotePath, part)
  const st = await fsp.stat(part)
  if (st.size !== expected.size) {
    await fsp.rm(part, { force: true })
    throw new Error(`size mismatch downloading ${remotePath}: ${st.size} != ${expected.size}`)
  }
  if (expected.sha256) {
    const hash = await sha256File(part)
    if (hash !== expected.sha256) {
      await fsp.rm(part, { force: true })
      throw new Error(`hash mismatch downloading ${remotePath}`)
    }
  }
  await fsp.rename(part, localPath)
  return 'downloaded'
}
