/**
 * provision.sh's agent subcommands on a FakeMachine, for scenarios where the
 * app brings a node back (plan 1.7): `agent-status`, `restart-agent [--force]`
 * and `deps`, answered the way the real script answers them, from the fake
 * agent's `alive` flag and the machine's files. The probe's heartbeat line
 * is answered from the same flag. provisioner.test.ts runs the app's calls
 * against the real script; this is the same contract, on the harness's clock.
 *
 *   const node = emulateProvision(w.machineFor(id))
 *   w.machineFor(id).agent.alive = false   // the agent dies: its heartbeat goes stale
 *   ...
 *   expect(node.restarts).toEqual([{ force: false, restarted: true, reason: 'heartbeat stale (300s)' }])
 *   expect(node.killed).toEqual([chunkId]) // the renders the restart killed
 *
 * A new file rather than a change to fakeSsh.ts, whose built-ins answer every
 * provision.sh command with an empty success.
 */

import type { FakeMachine } from './fakeSsh'
import { REMOTE_ROOT } from './fakeSsh'

/** What a dead agent's heartbeat reads, in seconds: past provision.sh's 60 s. */
export const DEAD_HEARTBEAT_S = 300

export interface ProvisionLog {
  /** Each restart-agent run, in order, with the verdict it printed. */
  readonly restarts: Array<{ force: boolean; restarted: boolean; reason: string | null }>
  /** Chunk ids whose render a restart killed, in order. */
  readonly killed: string[]
  /** agent-status runs. */
  statusCalls: number
  /** deps runs. */
  depsRuns: number
  /** agent-status reports deps as current (default true). */
  depsCurrent: boolean
}

/**
 * Chunks the agent is rendering: a state file that says so, written since
 * the last restart killed that chunk's render (`killedAt`, epoch ms). A
 * killed render's file stays as it was, as on a real node.
 */
function rendering(machine: FakeMachine, killedAt: ReadonlyMap<string, number>): string[] {
  const prefix = `${REMOTE_ROOT}/state/`
  const out: string[] = []
  for (const [path, data] of machine.files) {
    if (!path.startsWith(prefix) || !path.endsWith('.json')) continue
    const chunkId = path.slice(prefix.length, -'.json'.length)
    try {
      const s = JSON.parse(data.toString('utf-8')) as { status?: string; updatedAt?: number }
      if (s.status !== 'rendering' && s.status !== 'encoding') continue
      const killed = killedAt.get(chunkId)
      if (killed != null && (s.updatedAt ?? 0) * 1000 <= killed) continue
      out.push(chunkId)
    } catch {
      // not a chunk state
    }
  }
  return out
}

export function emulateProvision(machine: FakeMachine): ProvisionLog {
  const log: ProvisionLog = {
    restarts: [],
    killed: [],
    statusCalls: 0,
    depsRuns: 0,
    depsCurrent: true
  }
  const age = (): number => (machine.agent.alive ? 4 : DEAD_HEARTBEAT_S)
  const killedAt = new Map<string, number>()
  const renders = (): string[] => rendering(machine, killedAt)

  // The probe: the usual sample, then the heartbeat line nodeManager reads.
  machine.onExec(/^nvidia-smi --query-gpu/, (_c, _m, mc) => ({
    stdout: `${mc.metricsText()}----\nheartbeat ${age()}\n`
  }))

  machine.onExec(/provision\.sh agent-status$/, () => {
    log.statusCalls++
    const alive = machine.agent.alive
    const reason = alive ? '' : `heartbeat stale (${age()}s)`
    const hash = 'a'.repeat(64)
    return JSON.stringify({
      agentHash: hash,
      shippedAgentHash: hash,
      agentCurrent: true,
      agentSession: true,
      heartbeatAgeS: age(),
      heartbeatStale: !alive,
      blenderProcs: alive ? renders().length : 0,
      inboxSpecs: machine.agent.inbox().length,
      depsCurrent: log.depsCurrent,
      restartNeeded: !alive,
      restartReason: reason
    })
  })

  machine.onExec(/provision\.sh restart-agent( --force)?$/, (_c, m) => {
    const force = m[1] != null
    const alive = machine.agent.alive
    if (!force && alive) {
      log.restarts.push({ force, restarted: false, reason: null })
      return (
        `[provision] agent alive and current — left running with its ` +
        `${renders().length} Blender process(es) and ` +
        `${machine.agent.inbox().length} inbox spec(s)\nAGENT_KEPT\n`
      )
    }
    const reason = force ? 'forced' : `heartbeat stale (${age()}s)`
    // What the real restart does to the node: every Blender killed (their
    // state files stay as they were), the inbox emptied, a new agent.
    for (const chunkId of renders()) {
      log.killed.push(chunkId)
      killedAt.set(chunkId, Date.now())
    }
    for (const chunkId of machine.agent.inbox()) {
      machine.files.delete(`${REMOTE_ROOT}/jobs/inbox/${chunkId}.json`)
    }
    machine.agent.alive = true
    log.restarts.push({ force, restarted: true, reason })
    return `[provision] starting agent (${reason})…\nAGENT_RESTARTED ${reason}\n`
  })

  // nodeManager withdrawing chunks it gave back while the node was silent
  // (withdrawCommand): `rm -f '<inbox>/<id>.json'` per chunk, then a loop of
  // `pkill -f '/[r]enders/<id>/'` per chunk. The render stops (its state file
  // stays as it was) and the spec goes.
  machine.onExec(/pkill -f '\/\[r\]enders\//, (command) => {
    for (const m of command.matchAll(/pkill -f '\/\[r\]enders\/([^/']+)\/'/g)) {
      if (renders().includes(m[1])) log.killed.push(m[1])
      killedAt.set(m[1], Date.now())
    }
    for (const m of command.matchAll(/rm -f '([^']+)'/g)) machine.files.delete(m[1])
    return ''
  })

  machine.onExec(/provision\.sh deps$/, () => {
    log.depsRuns++
    log.depsCurrent = true
    return '[provision] directories…\n[provision] deps installed\n'
  })

  return log
}
