/**
 * Provisioning: ship the remote/ tree, install the node's dependencies (apt
 * deps, static ffmpeg), start the agent under tmux, install the required
 * Blender version(s), and probe EEVEE capability. Idempotent — re-runs are
 * cheap (everything on the node checks before doing work).
 *
 * provision.sh's `deps` and `restart-agent` are separate steps (plan 1.9):
 * the installs are skipped when this build already ran them, and the agent is
 * restarted only when asked to (`--force`) or when it is dead or runs other
 * code. `agent-status` says which, and what a restart would kill, before
 * anything is done. So the app can bring back a node that lost its connection
 * without killing the renders its live agent is running (plan 1.7).
 *
 * Every step has a deadline (plan 1.8). provisionBase, installBlender and the
 * rest used to await their command with none, so one stalled download left a
 * node 'provisioning', and billing, for good (#37 #82).
 */

import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { EXTENSION_ID } from '../addons/addons'
import { getDb } from '../db/db'
import { emit } from '../events'
import { uploadTree } from '../ssh/sftp'
import { shq } from '../ssh/shq'
import type { SshConnection } from '../ssh/sshConnection'

export const REMOTE_ROOT = '/root/vastai'

const PROVISION = `${REMOTE_ROOT}/provision.sh`

/**
 * The longest `provision.sh deps` may run: provision.sh's own worst case.
 * Its static ffmpeg download may take about an hour (two attempts at the
 * 30-minute ceiling) before it falls back to apt's ffmpeg, and apt runs
 * before and after that. A node that meets the offer filters' bandwidth
 * installs everything in a minute or two; onReady's deadline in
 * nodeManager.ts, not this, is what ends a slow one there.
 */
export const DEPS_TIMEOUT_MS = 75 * 60_000

/**
 * How long the app waits for `provision.sh install-blender`: one 30-minute
 * attempt at each of its four mirrors, then the extraction. That is not the
 * script's own worst case, which no billing node is left to: it goes round
 * the mirrors twice, and curl may start a second 30-minute attempt at a URL
 * just before its first 30 minutes are up, so about an hour a URL and some
 * eight hours in all. Past this the command's channel is closed, but the
 * script can go on running on the node until it next writes its output, and
 * an install of the same version started meanwhile deletes the download it
 * is still writing: only a lock in provision.sh keeps the two apart.
 *
 * At dispatch this is the step's own ceiling in the scheduler's per-node
 * prep (withNodePrep); a caller can pass a shorter `timeoutMs`. Inside
 * onReady, nodeManager's 25-minute provisioning deadline ends it first.
 */
export const INSTALL_BLENDER_TIMEOUT_MS = 4 * 30 * 60_000 + 10 * 60_000

/**
 * The longest `provision.sh restart-agent` may run: up to 90 s waiting for
 * another restart-agent on the node (AGENT_LOCK_WAIT_S), 10 s for the old
 * agent to exit before it is killed (AGENT_STOP_WAIT_S), and 30 s for the new
 * one's first heartbeat (AGENT_START_WAIT_S).
 */
export const RESTART_AGENT_TIMEOUT_MS = 3 * 60_000

/** `agent-status` hashes a few small files and answers with one line. */
const AGENT_STATUS_TIMEOUT_MS = 60_000

/** An extension install starts Blender twice; its extraction is a zip. */
const EXTENSION_TIMEOUT_MS = 10 * 60_000

/** The repo's remote/ tree (bundled as extraResource in production builds). */
export function localRemoteDir(): string {
  const dev = join(app.getAppPath(), 'remote')
  if (existsSync(dev)) return dev
  return join(process.resourcesPath, 'remote')
}

function logLine(nodeId: string, line: string): void {
  emit('render:logLine', { nodeId, chunkId: null, line, ts: Date.now() })
}

/**
 * A command's exit code, or null when it ended without one. ssh2 1.17 closes
 * the channel of a connection that went with no exit status at all
 * (undefined), and that of a command a signal killed with null; SshConnection
 * passes either on as it is. Neither is an answer from the command. Only
 * null was checked, what the test harness hands back for a dropped link, so
 * on real ssh2 a dropped link read as a command that failed with a verdict
 * ("exit undefined"), and a node brought back from a blip was destroyed for
 * it.
 * Messages keep reading "(exit null)" for such a command, as errors.ts's
 * node-setup rule and admission.ts's breaker key expect.
 */
export function exitStatus(code: number | null | undefined): number | null {
  return code ?? null
}

/**
 * Run a provisioning command, streaming its output to the node's log, and
 * return its lines and exit code. Past `timeoutMs` the command's channel is
 * closed and this rejects with the timeout, naming `label`, never the command
 * text. A command that ended with no exit status has code null (see
 * exitStatus).
 */
async function runCaptured(
  ssh: SshConnection,
  nodeId: string,
  command: string,
  label: string,
  timeoutMs: number
): Promise<{ code: number | null; lines: string[] }> {
  logLine(nodeId, `$ ${label}`)
  const lines: string[] = []
  const { done } = await ssh.execStream(
    command,
    (line) => {
      lines.push(line)
      logLine(nodeId, line)
    },
    { timeoutMs, label }
  )
  const code = exitStatus(await done)
  return { code, lines }
}

async function runLogged(
  ssh: SshConnection,
  nodeId: string,
  command: string,
  label: string,
  timeoutMs: number
): Promise<void> {
  const { code } = await runCaptured(ssh, nodeId, command, label, timeoutMs)
  if (code !== 0) throw new Error(`${label} failed (exit ${code})`)
}

/** What `provision.sh restart-agent` did: whether the agent, and every render on the node, was restarted. */
export interface AgentRestart {
  restarted: boolean
  /** Why it restarted (provision.sh's reason: "forced", "heartbeat stale (75s)"…), when it did. */
  reason: string | null
}

/**
 * A command whose connection went before it answered: ssh2 ends its channel
 * with no exit status (exitStatus: null). What the command did on the node is
 * not known, and nothing it would have answered was heard, so it is no
 * verdict on the node, only on the link. A command a signal killed ends the
 * same way, and is read the same way: it answered nothing either. Worded as sshConnection words a closed connection, so
 * classify() reads it as the SSH connection lost (ssh-lost). It read as an
 * unrecognised error, and a node brought back from a blip was destroyed for
 * one more.
 */
export class ConnectionLostError extends Error {
  override readonly name = 'ConnectionLostError'

  constructor(label: string) {
    super(`connection closed under ${label}`)
  }
}

/**
 * restart-agent found another restart-agent running on the node, and gave up
 * waiting for it: the node is busy, not broken.
 */
export class AgentBusyError extends Error {
  override readonly name = 'AgentBusyError'

  constructor() {
    super('another restart-agent is still running on the node')
  }
}

/**
 * restart-agent's verdict, from its output: the last line is AGENT_KEPT or
 * AGENT_RESTARTED <reason>. Null when it is neither.
 */
export function parseAgentRestart(lines: readonly string[]): AgentRestart | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    if (line === 'AGENT_KEPT') return { restarted: false, reason: null }
    const m = /^AGENT_RESTARTED(?: (.*))?$/.exec(line)
    if (m) return { restarted: true, reason: m[1]?.trim() || null }
    return null
  }
  return null
}

/**
 * `provision.sh restart-agent`: restart the agent when it is dead or runs
 * other code than the app shipped, or always with `force`. A restart kills
 * every Blender on the node and empties its inbox, so a caller with runs on
 * the node must forget them exactly when this says it restarted: a check made
 * beforehand can go stale in between.
 *
 * A restart-agent already under way on the node is waited for by the script,
 * up to 90 s, and then once more here: it may be ours, left running on the
 * node when a deadline gave up on it. An exit that gives no verdict counts as
 * a restart. Forgetting runs a live agent kept costs a re-render; keeping
 * runs a restart killed leaves them polling a render that is gone. For the
 * same reason a caller must take a ConnectionLostError, a timeout or an
 * AgentBusyError as a restart that may have happened.
 */
export async function restartAgent(
  ssh: SshConnection,
  nodeId: string,
  opts: { force?: boolean; timeoutMs?: number } = {}
): Promise<AgentRestart> {
  const command = `bash ${PROVISION} restart-agent${opts.force ? ' --force' : ''}`
  const label = `provision.sh restart-agent${opts.force ? ' --force' : ''}`
  for (let attempt = 1; ; attempt++) {
    const { code, lines } = await runCaptured(
      ssh,
      nodeId,
      command,
      label,
      opts.timeoutMs ?? RESTART_AGENT_TIMEOUT_MS
    )
    if (code === 0) return parseAgentRestart(lines) ?? { restarted: true, reason: null }
    if (code === null) throw new ConnectionLostError(label)
    const busy = code === 1 && lines.some((l) => l.includes('another restart-agent still running'))
    if (busy && attempt < 2) continue
    if (busy) throw new AgentBusyError()
    const last = [...lines].reverse().find((l) => l.trim())
    throw new Error(`${label} failed (exit ${code})${last ? `: ${last.trim()}` : ''}`)
  }
}

/** `provision.sh deps`: directories, apt packages and static ffmpeg, skipped when this build installed them. */
export async function provisionDeps(ssh: SshConnection, nodeId: string): Promise<void> {
  await runLogged(
    ssh,
    nodeId,
    `chmod +x ${PROVISION} && bash ${PROVISION} deps`,
    'provision.sh deps',
    DEPS_TIMEOUT_MS
  )
}

/**
 * Base provisioning — everything except Blender versions: the remote/ tree,
 * the deps, and the agent, always restarted. That is `provision.sh base`, run
 * as its two steps so that each has its own deadline and the restart's
 * verdict is read.
 *
 * Always a restart. A node provisioned here is new, or is being resumed at
 * start-up, when the scheduler has put every chunk it had in flight back in
 * the queue and re-attaches to none of them (scheduler.start). A render the
 * old agent went on with would be work nobody collects, on lanes the app
 * counts as free. A node that loses its connection mid-session is brought
 * back without one (nodeManager's reviveAgent).
 */
export async function provisionBase(ssh: SshConnection, nodeId: string): Promise<AgentRestart> {
  logLine(nodeId, 'uploading remote scripts…')
  const files = await uploadTree(ssh, localRemoteDir(), REMOTE_ROOT)
  logLine(nodeId, `uploaded ${files} files`)
  await provisionDeps(ssh, nodeId)
  return restartAgent(ssh, nodeId, { force: true })
}

/** What `provision.sh agent-status` reports: one JSON line. */
export interface AgentStatus {
  /** The code the running agent was started from; '' when unknown. */
  agentHash: string
  /** The agent code on disk, which the app uploaded. */
  shippedAgentHash: string
  agentCurrent: boolean
  /** The vr-agent tmux session exists. */
  agentSession: boolean
  /** Seconds since the agent's last heartbeat; null when it never beat. */
  heartbeatAgeS: number | null
  heartbeatStale: boolean
  /** Blender processes the agent started: the renders a restart would kill. */
  blenderProcs: number
  /** Specs waiting in the inbox, which a restart would delete. */
  inboxSpecs: number
  /** deps are installed for the tree on disk. */
  depsCurrent: boolean
  /** restart-agent without --force would restart the agent, and why. */
  restartNeeded: boolean
  restartReason: string
}

/** agent-status's line, or null when the output has none (an older or a missing provision.sh). */
export function parseAgentStatus(stdout: string): AgentStatus | null {
  const line = stdout
    .split('\n')
    .map((l) => l.trim())
    .reverse()
    .find((l) => l.startsWith('{'))
  if (!line) return null
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(line) as Record<string, unknown>
  } catch {
    return null
  }
  const bool = (k: string): boolean | null => {
    const v = raw[k]
    return typeof v === 'boolean' ? v : null
  }
  const count = (k: string): number | null => {
    const v = raw[k]
    return typeof v === 'number' && Number.isFinite(v) ? v : null
  }
  const str = (k: string): string => {
    const v = raw[k]
    return typeof v === 'string' ? v : ''
  }
  const restartNeeded = bool('restartNeeded')
  const blenderProcs = count('blenderProcs')
  const inboxSpecs = count('inboxSpecs')
  // What the app decides on must be there; a line without it is no status.
  if (restartNeeded == null || blenderProcs == null || inboxSpecs == null) return null
  const age = count('heartbeatAgeS')
  return {
    agentHash: str('agentHash'),
    shippedAgentHash: str('shippedAgentHash'),
    agentCurrent: bool('agentCurrent') ?? false,
    agentSession: bool('agentSession') ?? false,
    heartbeatAgeS: age,
    heartbeatStale: bool('heartbeatStale') ?? age == null,
    blenderProcs,
    inboxSpecs,
    depsCurrent: bool('depsCurrent') ?? false,
    restartNeeded,
    restartReason: str('restartReason')
  }
}

/**
 * Ask the node's provision.sh about its agent, changing nothing. Null when
 * the node's tree has no agent-status (a build before the split provisioned
 * it, or the tree is gone): only a full provision puts that right. Rejects
 * when the command itself fails: the connection (ConnectionLostError), or the
 * deadline.
 */
export async function agentStatus(ssh: SshConnection): Promise<AgentStatus | null> {
  const label = 'provision.sh agent-status'
  const r = await ssh.exec(`bash ${PROVISION} agent-status`, {
    timeoutMs: AGENT_STATUS_TIMEOUT_MS,
    label
  })
  const code = exitStatus(r.code)
  if (code === null) throw new ConnectionLostError(label)
  return code === 0 ? parseAgentStatus(r.stdout) : null
}

/** Install a Blender release (idempotent) and record it on the node row. */
export async function installBlender(
  ssh: SshConnection,
  nodeId: string,
  version: string,
  opts: { timeoutMs?: number } = {}
): Promise<void> {
  // Quoted: the version comes from settings (blenderVersionOverride) or the
  // job row, and reached the node's shell as it was typed (#99 #159). The
  // sanitizer refuses anything but a version now; a row saved before it
  // did must still not run as a command.
  await runLogged(
    ssh,
    nodeId,
    `bash ${PROVISION} install-blender ${shq(version)}`,
    `install blender ${version}`,
    opts.timeoutMs ?? INSTALL_BLENDER_TIMEOUT_MS
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
  const r = await ssh.exec(`bash ${PROVISION} probe-eevee ${shq(version)}`, {
    timeoutMs: 120_000,
    label: `EEVEE probe ${version}`
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
  // The id is the add-on's own (its manifest's, or its zip's name), and it
  // goes into a path, a Python module name and the expression that enables
  // it. A Python identifier is all Blender accepts for either, and nothing
  // else may reach the node's shell as code.
  if (!EXTENSION_ID.test(addon.id)) {
    throw new Error(
      `the add-on id ${JSON.stringify(addon.id)} is not a Python identifier, which Blender needs; register the add-on again`
    )
  }
  const { uploadFileVerified } = await import('../ssh/sftp')
  const remoteZip = `${REMOTE_ROOT}/work/extensions/${addon.id}.zip`
  const result = await uploadFileVerified(ssh, addon.zipPath, remoteZip)
  logLine(nodeId, `extension ${addon.id}: upload ${result}`)

  const blender = shq(`${REMOTE_ROOT}/blender/${blenderVersion}/blender`)
  if (addon.mechanism === 'install') {
    const enable =
      `import bpy; bpy.ops.preferences.addon_enable(module='bl_ext.user_default.${addon.id}'); ` +
      'bpy.ops.wm.save_userpref()'
    await runLogged(
      ssh,
      nodeId,
      // --python-exit-code: a failed addon_enable must fail the dispatch here,
      // not surface later as a scene-guard abort on every render attempt.
      `${blender} --command extension install-file -r user_default --enable ${shq(remoteZip)} && ` +
        `${blender} -b -noaudio --python-exit-code 1 --python-expr ${shq(enable)}`,
      `install extension ${addon.id}`,
      EXTENSION_TIMEOUT_MS
    )
    return null
  }
  // bootstrap: extract source; caller adds the returned expr to the job spec.
  const srcDir = `${REMOTE_ROOT}/work/extensions/${addon.id}-src`
  await runLogged(
    ssh,
    nodeId,
    `rm -rf ${shq(srcDir)} && mkdir -p ${shq(srcDir)} && python3 -m zipfile -e ${shq(remoteZip)} ${shq(srcDir)}`,
    `extract extension ${addon.id}`,
    EXTENSION_TIMEOUT_MS
  )
  return `import sys; sys.path.insert(0, '${srcDir}'); import ${addon.id}; ${addon.id}.register()`
}

/**
 * How old the agent's heartbeat may be before the agent counts as dead:
 * provision.sh's AGENT_STALE_S, six missed beats, and the node supervisor's
 * threshold. It was 30 s here, so a check made from a run could call an
 * agent dead that restart-agent and the supervisor would keep, and a false
 * "dead" costs a chunk and a node.
 */
export const AGENT_STALE_S = 60

/**
 * Is the agent alive: its heartbeat written within AGENT_STALE_S? Rejects
 * when that could not be told (the exec failed, lost its connection, or
 * answered neither way), rather than answer "dead" for a check that never
 * ran.
 */
export async function agentAlive(ssh: SshConnection): Promise<boolean> {
  const r = await ssh.exec(
    `python3 -c "import os,time;p='${REMOTE_ROOT}/state/heartbeat';print('alive' if os.path.exists(p) and time.time()-os.path.getmtime(p)<${AGENT_STALE_S} else 'dead')"`,
    { timeoutMs: 30_000, label: 'agent heartbeat' }
  )
  if (/\balive\b/.test(r.stdout)) return true
  if (/\bdead\b/.test(r.stdout)) return false
  throw new Error(`agent heartbeat check did not answer (exit ${exitStatus(r.code)})`)
}
