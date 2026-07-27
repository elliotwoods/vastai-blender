/**
 * Provisioning: ship the remote/ tree, run base setup (apt deps, static
 * ffmpeg, agent under tmux), install the required Blender version(s), and
 * probe EEVEE capability. Idempotent — re-runs are cheap (everything on the
 * node checks before doing work).
 */

import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { getDb } from '../db/db'
import { emit } from '../ipc'
import { uploadTree } from '../ssh/sftp'
import type { SshConnection } from '../ssh/sshConnection'

export const REMOTE_ROOT = '/root/vastai'

/** The repo's remote/ tree (bundled as extraResource in production builds). */
export function localRemoteDir(): string {
  const dev = join(app.getAppPath(), 'remote')
  if (existsSync(dev)) return dev
  return join(process.resourcesPath, 'remote')
}

function logLine(nodeId: string, line: string): void {
  emit('render:logLine', { nodeId, chunkId: null, line, ts: Date.now() })
}

async function runLogged(
  ssh: SshConnection,
  nodeId: string,
  command: string,
  label: string
): Promise<void> {
  logLine(nodeId, `$ ${label}`)
  const { done } = await ssh.execStream(command, (line) => logLine(nodeId, line))
  const code = await done
  if (code !== 0) throw new Error(`${label} failed (exit ${code})`)
}

/** Base provisioning — everything except Blender versions. */
export async function provisionBase(ssh: SshConnection, nodeId: string): Promise<void> {
  logLine(nodeId, 'uploading remote scripts…')
  const files = await uploadTree(ssh, localRemoteDir(), REMOTE_ROOT)
  logLine(nodeId, `uploaded ${files} files`)
  await runLogged(
    ssh,
    nodeId,
    `chmod +x ${REMOTE_ROOT}/provision.sh && bash ${REMOTE_ROOT}/provision.sh base`,
    'provision.sh base'
  )
}

/** Install a Blender release (idempotent) and record it on the node row. */
export async function installBlender(
  ssh: SshConnection,
  nodeId: string,
  version: string
): Promise<void> {
  await runLogged(
    ssh,
    nodeId,
    `bash ${REMOTE_ROOT}/provision.sh install-blender ${version}`,
    `install blender ${version}`
  )
  const db = getDb()
  const row = db.prepare('SELECT blender_versions FROM nodes WHERE id = ?').get(nodeId) as
    { blender_versions: string } | undefined
  if (row) {
    const versions = new Set(JSON.parse(row.blender_versions) as string[])
    versions.add(version)
    db.prepare('UPDATE nodes SET blender_versions = ? WHERE id = ?').run(
      JSON.stringify([...versions]),
      nodeId
    )
  }
}

/** EEVEE capability probe — records the result; failure is not fatal. */
export async function probeEevee(
  ssh: SshConnection,
  nodeId: string,
  version: string
): Promise<boolean> {
  const r = await ssh.exec(`bash ${REMOTE_ROOT}/provision.sh probe-eevee ${version}`, {
    timeoutMs: 120_000
  })
  const ok = r.stdout.includes('PROBE_OK')
  getDb()
    .prepare('UPDATE nodes SET eevee_capable = ? WHERE id = ?')
    .run(ok ? 1 : 0, nodeId)
  logLine(nodeId, `EEVEE probe: ${ok ? 'OK' : 'FAILED'}`)
  return ok
}

/**
 * Install and enable a user-provided extension zip for a given Blender
 * version (idempotent — install-file over an existing extension upgrades it).
 * For non-conformant zips (mechanism 'bootstrap'), extract the source and
 * return the python expression that registers it at render time.
 */
export async function installExtension(
  ssh: SshConnection,
  nodeId: string,
  blenderVersion: string,
  addon: { id: string; zipPath: string; mechanism: 'install' | 'bootstrap' }
): Promise<string | null> {
  const { uploadFileVerified } = await import('../ssh/sftp')
  const remoteZip = `${REMOTE_ROOT}/work/extensions/${addon.id}.zip`
  const result = await uploadFileVerified(ssh, addon.zipPath, remoteZip)
  logLine(nodeId, `extension ${addon.id}: upload ${result}`)

  const blender = `${REMOTE_ROOT}/blender/${blenderVersion}/blender`
  if (addon.mechanism === 'install') {
    await runLogged(
      ssh,
      nodeId,
      // --python-exit-code: a failed addon_enable must fail the dispatch here,
      // not surface later as a scene-guard abort on every render attempt.
      `${blender} --command extension install-file -r user_default --enable '${remoteZip}' && ` +
        `${blender} -b -noaudio --python-exit-code 1 --python-expr "import bpy; bpy.ops.preferences.addon_enable(module='bl_ext.user_default.${addon.id}'); bpy.ops.wm.save_userpref()"`,
      `install extension ${addon.id}`
    )
    return null
  }
  // bootstrap: extract source; caller adds the returned expr to the job spec.
  const srcDir = `${REMOTE_ROOT}/work/extensions/${addon.id}-src`
  await runLogged(
    ssh,
    nodeId,
    `rm -rf '${srcDir}' && mkdir -p '${srcDir}' && python3 -m zipfile -e '${remoteZip}' '${srcDir}'`,
    `extract extension ${addon.id}`
  )
  return `import sys; sys.path.insert(0, '${srcDir}'); import ${addon.id}; ${addon.id}.register()`
}

/** Check the agent is alive (heartbeat fresh within 30s). */
export async function agentAlive(ssh: SshConnection): Promise<boolean> {
  const r = await ssh.exec(
    `python3 -c "import os,time;p='${REMOTE_ROOT}/state/heartbeat';print('alive' if os.path.exists(p) and time.time()-os.path.getmtime(p)<30 else 'dead')"`
  )
  return r.stdout.includes('alive')
}
