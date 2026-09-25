/**
 * remote/provision.sh, run under bash on a stubbed node (remoteNode.ts). Plan
 * 1.9: `base` was one step that always killed the agent, every Blender and
 * the inbox, so any second provision of a live node (an app resume, or the
 * double launch behind job 81fe2875) threw away paid renders. It is now
 * `deps` (skipped when this build already ran it) and `restart-agent` (only
 * when the agent is dead or runs other code), with `agent-status` to ask first.
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { remoteNode, type RemoteNode } from './remoteNode'

interface AgentStatus {
  agentHash: string
  shippedAgentHash: string
  agentCurrent: boolean
  agentSession: boolean
  heartbeatAgeS: number | null
  heartbeatStale: boolean
  blenderProcs: number
  inboxSpecs: number
  depsCurrent: boolean
  restartNeeded: boolean
  restartReason: string
}

// Each test runs the script under bash, several times: seconds of real time,
// more when the whole suite runs in parallel (as provisioner.test.ts).
describe.skipIf(process.platform === 'win32')('provision.sh', { timeout: 60_000 }, () => {
  let n: RemoteNode
  beforeEach(() => {
    n = remoteNode()
  })
  afterEach(() => n.dispose())

  const aptUpdates = (): number => n.calls().filter((c) => c === 'apt-get update -qq').length
  const since = (mark: number): string[] => n.calls().slice(mark)
  const kills = (calls: string[]): string[] =>
    calls.filter((c) => c.startsWith('pkill') || c.startsWith('tmux kill-session'))
  const inbox = (name: string): string => join(n.vastai, 'jobs', 'inbox', name)
  const agentProc = (): string => `python3 ${n.vastai}/agent/noderunner.py`
  /** What a restart kills, in order: the agent (in tmux and out), then every Blender. */
  const restartKills = (): string[] => [
    'tmux kill-session -t vr-agent',
    `pkill -f ${agentProc()}`,
    `pkill -f ${n.vastai}/blender/`
  ]
  const status = (): AgentStatus => {
    const r = n.provision(['agent-status'])
    expect(r.code).toBe(0)
    // Exactly one line on stdout: the app parses it whole.
    expect(r.stdout.split('\n').filter(Boolean)).toHaveLength(1)
    return JSON.parse(r.stdout) as AgentStatus
  }
  /** A node mid-render: the agent up, two specs queued, two Blenders running. */
  const busyNode = (): void => {
    const r = n.provision(['restart-agent'])
    expect(r.code, r.stdout + r.stderr).toBe(0)
    writeFileSync(inbox('job1-1-10.json'), '{}')
    writeFileSync(inbox('job1-11-20.json'), '{}')
    n.setProcs([
      { pid: 4101, name: 'blender', args: `${n.vastai}/blender/5.1.0/blender -b x.blend` },
      { pid: 4102, name: 'blender', args: `${n.vastai}/blender/5.1.0/blender -b y.blend` }
    ])
  }

  it('1.9: deps installs once per build; the next provision of that build skips apt', () => {
    const first = n.provision(['deps'])
    expect(first.code, first.stdout + first.stderr).toBe(0)
    expect(aptUpdates()).toBe(1)

    const second = n.provision(['deps'])
    expect(second.code).toBe(0)
    expect(second.stdout).toMatch(/deps already installed for this build/)
    expect(aptUpdates()).toBe(1)
    // The directories are still ensured: they are cheap, and a deleted one
    // would break the agent.
    expect(existsSync(join(n.vastai, 'jobs', 'inbox'))).toBe(true)
  })

  it('1.9: the deps stamp follows the shipped tree, not what the node itself writes', () => {
    expect(n.provision(['deps']).code).toBe(0)
    // Written on the node: a Blender build under blender/, Python caches, specs.
    mkdirSync(join(n.vastai, 'blender', '5.1.0'), { recursive: true })
    writeFileSync(join(n.vastai, 'blender', '5.1.0', 'blender'), 'ELF')
    mkdirSync(join(n.vastai, 'agent', '__pycache__'), { recursive: true })
    writeFileSync(join(n.vastai, 'agent', '__pycache__', 'noderunner.cpython-310.pyc'), 'x')
    writeFileSync(inbox('a.json'), '{}')
    expect(n.provision(['deps']).code).toBe(0)
    expect(aptUpdates()).toBe(1)

    // An app update ships a changed script: the installs run again.
    appendFileSync(join(n.vastai, 'encode', 'encode_preview.py'), '\n# changed\n')
    expect(n.provision(['deps']).code).toBe(0)
    expect(aptUpdates()).toBe(2)
    // --force always runs them.
    expect(n.provision(['deps', '--force']).code).toBe(0)
    expect(aptUpdates()).toBe(3)
  })

  it('1.9: a deps run skipped as current still retries OptiX while it is missing', () => {
    // ensure-optix is started in the background, so its stub may record the
    // start a moment after deps returns.
    const optixTries = (atLeast: number): number => {
      const count = (): number =>
        n.calls().filter((c) => c === `setsid nohup bash ${n.vastai}/provision.sh ensure-optix`)
          .length
      for (let i = 0; i < 40 && count() < atLeast; i++) spawnSync('sleep', ['0.05'])
      return count()
    }
    expect(n.provision(['deps']).code).toBe(0)
    expect(optixTries(1)).toBe(1)
    const log = join(n.vastai, 'logs', 'ensure_optix.log')
    writeFileSync(log, 'optix: driver 550.54 download failed — staying on CUDA\n')

    // The first try failed on a download blip. Skipping it with the rest of
    // deps would leave the node on CUDA (~1.5x slower) for its paid life.
    const again = n.provision(['deps'])
    expect(again.stdout).toMatch(/deps already installed for this build/)
    expect(again.stdout).toMatch(/ensure-optix started in background/)
    expect(optixTries(2)).toBe(2)
    // The earlier try's log is kept, not cut.
    expect(readFileSync(log, 'utf8')).toMatch(/download failed/)

    // Once the libraries are in, nothing is started.
    writeFileSync(join(n.optixLib, 'libnvoptix.so.1'), '')
    const done = n.provision(['deps'])
    expect(done.stdout).toMatch(/optix: already present/)
    expect(done.stdout).not.toMatch(/ensure-optix started/)
  })

  it('1.9: an ensure-optix started while another still fetches leaves it to that one', () => {
    expect(n.provision(['deps']).code).toBe(0)
    const release = n.holdLock(join(n.vastai, 'state', 'ensure-optix.lock'))
    const r = n.provision(['ensure-optix'])
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/another ensure-optix is already fetching/)
    // It did not go on to fetch (and rm -rf the other's download).
    expect(r.stdout).not.toMatch(/optix: (driver|fetching)/)
    release()
    expect(n.provision(['ensure-optix']).stdout).not.toMatch(/already fetching/)
  })

  it('1.9 81fe2875: a second provision leaves a live, current agent its Blender renders and inbox', () => {
    busyNode()
    const mark = n.calls().length

    const r = n.provision(['restart-agent'])
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/^AGENT_KEPT$/m)
    expect(r.stdout).toMatch(/2 Blender process\(es\) and 2 inbox spec\(s\)/)
    expect(kills(since(mark))).toEqual([])
    expect(since(mark).filter((c) => c.startsWith('tmux new-session'))).toEqual([])
    expect(existsSync(inbox('job1-1-10.json'))).toBe(true)
    expect(existsSync(inbox('job1-11-20.json'))).toBe(true)
  })

  it('1.9: restart-agent restarts an agent that runs other code than the app shipped', () => {
    busyNode()
    appendFileSync(join(n.vastai, 'agent', 'noderunner.py'), '\n# new build\n')
    const mark = n.calls().length

    const r = n.provision(['restart-agent'])
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/^AGENT_RESTARTED agent code changed$/m)
    expect(kills(since(mark))).toEqual(restartKills())
    expect(existsSync(inbox('job1-1-10.json'))).toBe(false)
    // The new agent is now the current one.
    expect(n.provision(['restart-agent']).stdout).toMatch(/^AGENT_KEPT$/m)
  })

  it('1.9: a change outside agent/ (encode, blender scripts, provision.sh) does not restart the agent', () => {
    busyNode()
    appendFileSync(join(n.vastai, 'encode', 'encode_preview.py'), '\n# changed\n')
    appendFileSync(join(n.vastai, 'blender', 'enable_gpu.py'), '\n# changed\n')
    const mark = n.calls().length
    expect(n.provision(['restart-agent']).stdout).toMatch(/^AGENT_KEPT$/m)
    expect(kills(since(mark))).toEqual([])
  })

  it('1.9: restart-agent restarts a dead agent: stale heartbeat, no session, or unknown code', () => {
    busyNode()
    // A wedged agent: its session is there, its heartbeat is not.
    n.age(join(n.vastai, 'state', 'heartbeat'), 300)
    expect(n.provision(['restart-agent']).stdout).toMatch(
      /^AGENT_RESTARTED heartbeat stale \(\d+s\)$/m
    )

    // The agent process exited, taking its tmux session with it. Its last
    // beat is still fresh, but orphaned Blenders must not keep rendering.
    n.endAgentSession()
    const mark = n.calls().length
    expect(n.provision(['restart-agent']).stdout).toMatch(/^AGENT_RESTARTED no agent session$/m)
    expect(kills(since(mark))).toContain(`pkill -f ${n.vastai}/blender/`)

    // An agent started by an older provision.sh left no record of its code.
    writeFileSync(join(n.vastai, 'state', 'agent.sha256'), '')
    expect(n.provision(['restart-agent']).stdout).toMatch(/^AGENT_RESTARTED agent code unknown/m)
  })

  it('1.9: restart-agent --force restarts even a live, current agent (node:reprovision)', () => {
    busyNode()
    const mark = n.calls().length
    const r = n.provision(['restart-agent', '--force'])
    expect(r.stdout).toMatch(/^AGENT_RESTARTED forced$/m)
    expect(kills(since(mark))).toEqual(restartKills())
    expect(existsSync(inbox('job1-1-10.json'))).toBe(false)
  })

  it('1.9: base keeps its old meaning for app builds before the split: it always restarts', () => {
    // Those builds reset every in-flight chunk and dispatch it anew, so a
    // render left running under them would be invisible duplicate work.
    expect(n.provision(['base']).code).toBe(0)
    writeFileSync(inbox('job1-1-10.json'), '{}')
    const mark = n.calls().length

    const r = n.provision(['base'])
    expect(r.code).toBe(0)
    // Its installs are stamped like deps: one apt run for two bases...
    expect(aptUpdates()).toBe(1)
    // ...but the agent, its renders and the inbox always go.
    expect(kills(since(mark))).toEqual(restartKills())
    expect(existsSync(inbox('job1-1-10.json'))).toBe(false)
    expect(r.stdout).toMatch(/^AGENT_RESTARTED forced$/m)
    expect(r.stdout).toMatch(/base provisioning complete/)
  })

  it('1.9: an agent that dies at startup fails the provision instead of leaving a dead node ready', () => {
    const r = n.provision(['restart-agent'], { env: { FAKE_AGENT: 'crash' } })
    expect(r.code).toBe(1)
    expect(r.stdout).toMatch(/agent exited at startup/)
    expect(r.stdout).toMatch(/fake crash/)
    expect(r.stdout).not.toMatch(/AGENT_RESTARTED/)
  })

  it('1.9: two restart-agents that overlap start one agent; the second keeps it', async () => {
    // Both are under way before either looks at the agent: the app's prep
    // deadline gave up on the first exec while it still ran here.
    const release = n.holdLock(join(n.vastai, 'state', 'restart-agent.lock'))
    const first = n.provisionAsync(['restart-agent'])
    const second = n.provisionAsync(['restart-agent'])
    await new Promise((r) => setTimeout(r, 300))
    release()
    const results = await Promise.all([first, second])

    for (const r of results) expect(r.code, r.stdout + r.stderr).toBe(0)
    expect(n.calls().filter((c) => c.startsWith('tmux new-session'))).toHaveLength(1)
    expect(results.map((r) => r.stdout.trim().split('\n').pop()).sort()).toEqual([
      'AGENT_KEPT',
      'AGENT_RESTARTED no agent session'
    ])
  })

  it('1.9: restart-agent waits for one already running; the agent it starts holds no lock', () => {
    const quick = { env: { AGENT_LOCK_WAIT_S: '1' } }
    const release = n.holdLock(join(n.vastai, 'state', 'restart-agent.lock'))
    const r = n.provision(['restart-agent'], quick)
    expect(r.code).toBe(1)
    expect(r.stdout).toMatch(/waiting up to 1s for another restart-agent/)
    expect(r.stdout).toMatch(/another restart-agent still running after 1s/)
    expect(n.calls().filter((c) => c.startsWith('tmux'))).toEqual([])
    release()

    expect(n.provision(['restart-agent'], quick).stdout).toMatch(/^AGENT_RESTARTED/m)
    // The tmux server outlives the script. Had it inherited the lock, no
    // restart-agent (nor base) could run on this node again.
    const again = n.provision(['restart-agent'], quick)
    expect(again.code, again.stdout).toBe(0)
    expect(again.stdout).toMatch(/^AGENT_KEPT$/m)
  })

  it('1.9: restart-agent stops an agent running outside its tmux session', () => {
    busyNode()
    // The tmux socket was lost: no session, but noderunner still runs and
    // would claim inbox specs beside the new agent.
    n.endAgentSession()
    n.setProcs([
      { pid: 4001, name: 'python3', args: agentProc() },
      { pid: 4101, name: 'blender', args: `${n.vastai}/blender/5.1.0/blender -b x.blend` }
    ])
    const mark = n.calls().length
    const r = n.provision(['restart-agent'])
    expect(r.stdout).toMatch(/^AGENT_RESTARTED no agent session$/m)
    expect(kills(since(mark))).toEqual(restartKills())
    expect(n.procs()).toEqual([])
    // Stopped before the new one started.
    const calls = since(mark)
    expect(calls.indexOf(`pkill -f ${agentProc()}`)).toBeLessThan(
      calls.findIndex((c) => c.startsWith('tmux new-session'))
    )
  })

  it('1.9: an agent that ignores SIGTERM is killed before the new one starts', () => {
    busyNode()
    n.setProcs([{ pid: 4001, name: 'python3', args: agentProc(), ignoresTerm: true }])
    const mark = n.calls().length
    const r = n.provision(['restart-agent', '--force'], { env: { AGENT_STOP_WAIT_S: '1' } })
    expect(r.code, r.stdout + r.stderr).toBe(0)
    expect(r.stdout).toMatch(/agent did not exit 1s after SIGTERM/)
    const calls = since(mark)
    const killed = calls.indexOf(`pkill -KILL -f ${agentProc()}`)
    expect(killed).toBeGreaterThan(calls.indexOf(`pkill -f ${agentProc()}`))
    expect(killed).toBeLessThan(calls.findIndex((c) => c.startsWith('tmux new-session')))
    expect(n.procs()).toEqual([])
  })

  it('1.9: a beat from before the restart does not vouch for a new agent that never beat', () => {
    // The old agent's last beat lands after the heartbeat was cleared, and the
    // new agent hangs at import. Taken for the new agent's, the node would go
    // 'ready' and bill while every chunk sent to it waited forever.
    const r = n.provision(['restart-agent'], {
      env: { FAKE_AGENT: 'stale-beat', AGENT_START_WAIT_S: '1' }
    })
    expect(r.code).toBe(1)
    expect(r.stdout).toMatch(/no heartbeat within 1s/)
    expect(r.stdout).not.toMatch(/AGENT_RESTARTED/)
  })

  it('1.9: an agent that never beats fails the provision within AGENT_START_WAIT_S', () => {
    const r = n.provision(['restart-agent'], {
      env: { FAKE_AGENT: 'silent', AGENT_START_WAIT_S: '1' }
    })
    expect(r.code).toBe(1)
    expect(r.stdout).toMatch(/no heartbeat within 1s/)
  })

  it('1.9: agent-status reports what a restart would find and do, as one JSON line', () => {
    // A fresh node: nothing installed, no agent.
    let s = status()
    expect(s).toMatchObject({
      agentHash: '',
      agentCurrent: false,
      agentSession: false,
      heartbeatAgeS: null,
      heartbeatStale: true,
      blenderProcs: 0,
      inboxSpecs: 0,
      depsCurrent: false,
      restartNeeded: true,
      restartReason: 'no agent session'
    })
    expect(s.shippedAgentHash).toMatch(/^[0-9a-f]{64}$/)

    expect(n.provision(['deps']).code).toBe(0)
    busyNode()
    const mark = n.calls().length
    writeFileSync(inbox('job1-21-30.tmp.json'), '{') // mid-write: not a spec yet
    s = status()
    expect(s).toMatchObject({
      agentCurrent: true,
      agentSession: true,
      heartbeatStale: false,
      blenderProcs: 2,
      inboxSpecs: 2,
      depsCurrent: true,
      restartNeeded: false,
      restartReason: ''
    })
    expect(s.agentHash).toBe(s.shippedAgentHash)
    expect(s.heartbeatAgeS).toBeGreaterThanOrEqual(0)
    expect(s.heartbeatAgeS).toBeLessThan(60)

    n.age(join(n.vastai, 'state', 'heartbeat'), 120)
    s = status()
    expect(s.heartbeatStale).toBe(true)
    expect(s.heartbeatAgeS).toBeGreaterThanOrEqual(120)
    expect(s).toMatchObject({ restartNeeded: true })
    expect(s.restartReason).toMatch(/^heartbeat stale/)

    // Asking changes nothing on the node.
    expect(kills(since(mark))).toEqual([])
    expect(since(mark).filter((c) => c.startsWith('tmux new-session'))).toEqual([])
    expect(readFileSync(inbox('job1-1-10.json'), 'utf8')).toBe('{}')
  })

  it('rejects an unknown flag rather than guessing', () => {
    expect(n.provision(['restart-agent', '--forse']).code).toBe(1)
    expect(n.provision(['deps', 'now']).code).toBe(1)
  })
})
