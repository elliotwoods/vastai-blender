import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MetricsSample } from '../../shared/models'
import { HANG, setup, type FakeMachine, type World } from '../test/harness'

// Feature G on the lifecycle harness: every poll pollMetrics makes lands in
// the GPU usage history (metricsHistory.ts), with the runs the scheduler
// has on each GPU, and a poll that got no reading lands as a gap, never as
// an idle GPU. What the Fleet graphs draw from; job 81fe2875's 7 idle GPUs
// out of 24, held by runs that did nothing, showed nowhere.

let w: World
beforeEach(async () => {
  w = await setup({ settings: { maxActiveNodes: 1 } })
})
afterEach(() => w.dispose())

const SEC = 1_000
const MIN = 60 * SEC

type Mh = typeof import('./metricsHistory')

/** nvidia-smi as pollMetrics reads it: each card at the utilisation given. */
function reportUtil(machine: FakeMachine, util: number[]): void {
  machine.onExec(/^nvidia-smi --query-gpu/, () => {
    const gpus = util.map((u, i) => `${u}, 8000, 24576, 65, 300.5, 450, ${i}`).join('\n')
    return (
      `${gpus}\n----\n4.00 3.50 3.00 2/300 12345\n32\n----\n` +
      `MemTotal:       131072000 kB\nMemAvailable:    65536000 kB\n` +
      `cpu  1000 0 500 8000 100 0 0 0 0 0\n`
    )
  })
}

interface MetricsRow {
  ts: number
  gpu_index: number
  util: number | null
  runs: number
}

function rowsOf(nodeId: string): MetricsRow[] {
  return w.all<MetricsRow>(
    'SELECT ts, gpu_index, util, runs FROM node_metrics WHERE node_id = ? ORDER BY ts, gpu_index',
    nodeId
  )
}

describe('Feature G: pollMetrics feeds the GPU usage history', () => {
  it('Feature G (81fe2875): a GPU holding a run that renders nothing shows as paid and idle', async () => {
    const app = await w.boot()
    const mh: Mh = await import('./metricsHistory')
    const heard: MetricsSample[] = []
    mh.onSample((s) => heard.push(s))
    const nodeId = await w.readyNode(app, { num_gpus: 2, dph_total: 1.2 })
    const machine = w.machineFor(nodeId)
    // Two lanes, each pinned to its GPU, as the agent reports them; GPU 1's
    // render never gets going.
    let next = 0
    machine.onSpec = (spec) => {
      machine.agent.writeState(spec.chunkId, { status: 'rendering', gpu: next++ })
    }
    reportUtil(machine, [95, 0])
    await w.submitJob(app, { frameStart: 1, frameEnd: 2, chunkSize: 1 })
    app.scheduler.kick()
    await w.until(() => next === 2, 'both lanes sent')
    await w.until(
      () => heard.some((s) => s.nodeId === nodeId && s.runs.join() === '1,1' && s.gpus != null),
      'a sample with a run on each GPU'
    )
    const from = Date.now()
    await w.advance(2 * MIN)

    // Pushed as a MetricsSample: per-GPU readings, and the runs by GPU.
    const last = heard.filter((s) => s.nodeId === nodeId).at(-1)!
    expect(last.gpus?.map((g) => g.util)).toEqual([95, 0])
    expect(last.runs).toEqual([1, 1])
    expect(last.unpinnedRuns).toBe(0)

    const hist = mh.nodeHistory({ nodeId, fromMs: from, toMs: Date.now(), maxPoints: 20 })
    const [g0, g1] = hist.gpus
    const read = hist.gpus[1].util.filter((p) => p.mean != null)
    expect(read.length).toBeGreaterThan(0)
    // GPU 1: a run on it the whole time, at 0%. The paid-and-idle case.
    expect(read.every((p) => p.mean === 0)).toBe(true)
    expect(g1.runs.filter((p) => p.mean != null).every((p) => p.mean === 1)).toBe(true)
    expect(g0.util.filter((p) => p.mean != null).every((p) => p.mean === 95)).toBe(true)

    // Every poll is in the table too, one row per GPU.
    const rows = rowsOf(nodeId).filter((r) => r.ts >= from)
    expect(rows.length).toBeGreaterThanOrEqual(2 * 7)
    expect(rows.filter((r) => r.gpu_index === 1).every((r) => r.util === 0 && r.runs === 1)).toBe(
      true
    )
  })

  it('Feature G: a node that stops answering is a gap in its history, never an idle GPU', async () => {
    const app = await w.boot()
    const mh: Mh = await import('./metricsHistory')
    const nodeId = await w.readyNode(app, { num_gpus: 2 })
    const machine = w.machineFor(nodeId)
    reportUtil(machine, [80, 80])
    await w.advance(MIN)
    // The poll of this instant has had its answer.
    const silentFrom = Date.now()
    // The link wedges: no command gets an answer.
    machine.onExec(/.*/, HANG)
    await w.until(() => app.nodeManager.get(nodeId)?.state === 'unreachable', 'unreachable', {
      timeoutMs: 3 * MIN
    })
    // Out of the fleet, not probed, holding its instance: still polled as a gap.
    const unreachableAt = Date.now()
    await w.advance(MIN)
    const silent = rowsOf(nodeId).filter((r) => r.ts > silentFrom)
    expect(silent.length).toBeGreaterThan(0)
    expect(silent.every((r) => r.util === null)).toBe(true)
    const polls = new Set(silent.filter((r) => r.ts > unreachableAt).map((r) => r.ts))
    expect(polls.size).toBeGreaterThanOrEqual(3)
    // Each poll covers both GPUs.
    for (const ts of polls) expect(silent.filter((r) => r.ts === ts)).toHaveLength(2)

    const hist = mh.nodeHistory({
      nodeId,
      fromMs: silentFrom - MIN,
      toMs: Date.now(),
      maxPoints: 200
    })
    const util = hist.gpus[0].util
    expect(util.some((p) => p.mean === 80)).toBe(true)
    expect(util.filter((p) => p.ts >= silentFrom + 30 * SEC).every((p) => p.mean === null)).toBe(
      true
    )
    // The fleet graph still counts the silent node's GPUs as rented.
    const fleet = mh.fleetGpuHistory({ fromMs: unreachableAt, toMs: Date.now(), maxPoints: 2 })
    expect(fleet.points.filter((p) => p.gpusRented != null).every((p) => p.gpusRented === 2)).toBe(
      true
    )
  })

  it('Feature G: the cost timer keeps the history table to 7 days', async () => {
    await w.boot()
    const insert = w.db.prepare(
      `INSERT INTO node_metrics (ts, node_id, gpu_index, util, runs) VALUES (?, 'old', 0, 50, 0)`
    )
    const day = 24 * 60 * MIN
    insert.run(Date.now() - 8 * day)
    insert.run(Date.now() - 6 * day)
    await w.advance(61 * SEC)
    expect(w.all(`SELECT ts FROM node_metrics WHERE node_id = 'old'`)).toEqual([
      { ts: Date.now() - 61 * SEC - 6 * day }
    ])
  })
})

// Plan 1.19: the agent destroys its own instance once control/app_alive has
// gone unrenewed for 30 min with nothing to render. Every probe the app makes
// renews it, so no node the app can still reach ever goes by itself.
describe('plan 1.19: every usage probe renews the node lease', () => {
  it('the probe touches control/app_alive, and its output still parses', async () => {
    const app = await w.boot()
    const nodeId = await w.readyNode(app)
    const machine = w.machineFor(nodeId)
    reportUtil(machine, [55])
    await w.advance(20 * SEC)
    const probes = machine.execs.filter((c) => /^nvidia-smi --query-gpu/.test(c))
    expect(probes.length).toBeGreaterThan(0)
    expect(probes.every((c) => /touch \/root\/vastai\/control\/app_alive/.test(c))).toBe(true)
    expect(app.nodeManager.get(nodeId)?.snapshot.metrics?.gpuUtil).toBe(55)
  })
})
