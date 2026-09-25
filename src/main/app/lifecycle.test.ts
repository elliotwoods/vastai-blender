import { describe, expect, it } from 'vitest'
import type { NodeSnapshot } from '../../shared/models'
import {
  billingFleet,
  campaignDone,
  choiceOf,
  describeNode,
  failurePrompt,
  fmtDuration,
  parseQuitPolicy,
  quitPrompt,
  sleepWarning,
  VAST_CONSOLE,
  wakeNotice
} from './lifecycle'

// The pure decisions behind quit, sleep and a headless run's end (plan 1.1).
// The adapter that acts on them runs on the lifecycle harness in
// lifecycle.quit.test.ts.

function node(patch: Partial<NodeSnapshot> = {}): NodeSnapshot {
  return {
    id: 'abcdef0123456789',
    instanceId: 1001,
    state: 'rendering',
    gpuName: 'RTX 4090',
    numGpus: 1,
    dphTotal: 0.4,
    sshHost: null,
    sshPort: null,
    startedAt: null,
    accumulatedCost: 0,
    energyWh: 0,
    co2g: 0,
    geolocation: null,
    currentWork: [],
    slotsInUse: 0,
    slotTarget: 1,
    eeveeCapable: null,
    octaneReady: false,
    octaneNeedsManualLogin: false,
    blenderVersions: [],
    lastError: null,
    metrics: null,
    ...patch
  }
}

describe('billingFleet: what the quit dialog counts and Destroy all destroys', () => {
  // nodeState's holdsInstance, over the snapshots: billing is read from the
  // instance, not the state (plan 1.2).
  it.each<[string, Partial<NodeSnapshot>, boolean]>([
    ['a node at work', { state: 'rendering' }, true],
    ['a node whose destroy threw', { state: 'failed', lastError: 'destroy failed: 500' }, true],
    ['a destroy under way', { state: 'destroying' }, true],
    ['a create still out', { state: 'requested', instanceId: null }, true],
    [
      'a create whose outcome is unknown (plan 1.4)',
      { state: 'failed', instanceId: null, createUnknownSince: 1 },
      true
    ],
    ['a create Vast refused', { state: 'failed', instanceId: null }, false],
    ['destroyed and confirmed', { state: 'destroyed', destroyedAt: 5 }, false],
    ['destroyed, never confirmed', { state: 'destroyed', destroyedAt: null }, true]
  ])('%s: %s', (_what, patch, billing) => {
    expect(billingFleet([node(patch)]).nodes).toHaveLength(billing ? 1 : 0)
  })

  it('sums the rate of the nodes that may be billing, and only them', () => {
    const fleet = billingFleet([
      node({ id: 'a', dphTotal: 1.25 }),
      node({ id: 'b', state: 'failed', dphTotal: 0.5 }),
      node({ id: 'c', state: 'destroyed', destroyedAt: 5, dphTotal: 9 }),
      node({ id: 'd', state: 'requested', instanceId: null, dphTotal: null })
    ])
    expect(fleet.nodes.map((n) => n.id)).toEqual(['a', 'b', 'd'])
    expect(fleet.perHour).toBeCloseTo(1.75)
  })
})

describe('the quit dialog', () => {
  it('names the count and the rate: "2 nodes are billing $1.10/hr"', () => {
    const p = quitPrompt(billingFleet([node({ id: 'a', dphTotal: 0.7 }), node({ id: 'b' })]))
    expect(p.message).toBe('2 nodes are billing $1.10/hr')
    expect(p.buttons).toEqual(['Destroy all && quit', 'Leave running', 'Cancel'])
    expect(p.normalizeAccessKeys).toBe(true)
  })

  it('in the singular for one node', () => {
    expect(quitPrompt(billingFleet([node()])).message).toBe('1 node is billing $0.40/hr')
  })

  it('says when some of them are still being rented', () => {
    const p = quitPrompt(
      billingFleet([node(), node({ id: 'x', state: 'requested', instanceId: null })])
    )
    expect(p.detail).toContain('(1 of them is still being rented.)')
  })

  it('a create that failed with no outcome counts as billing, but not as still being rented', () => {
    const answered = node({ id: 'x', state: 'failed', instanceId: null, createUnknownSince: 1 })
    const p = quitPrompt(billingFleet([node(), answered]))
    expect(p.message).toBe('2 nodes are billing $0.80/hr')
    expect(p.detail).not.toContain('still being rented')
  })

  it('Enter destroys, Esc cancels, and an unknown response is Esc', () => {
    const p = quitPrompt(billingFleet([node()]))
    expect(choiceOf(p, p.defaultId)).toBe('destroy')
    expect(choiceOf(p, p.cancelId)).toBe('cancel')
    expect(choiceOf(p, 1)).toBe('leave')
    expect(choiceOf(p, 7)).toBe('cancel')
    expect(choiceOf(p, -1)).toBe('cancel')
  })
})

describe('the failure list', () => {
  it('names each instance, what it costs and why, with the Vast.ai console', () => {
    const p = failurePrompt([
      {
        node: node({ instanceId: 4242, gpuName: 'RTX 4090', numGpus: 8, dphTotal: 3.2 }),
        reason: 'destroy failed: 500 internal error'
      },
      {
        node: node({ id: '0123456789abcdef', instanceId: null, state: 'requested' }),
        reason:
          'Vast never answered its create; look for "vastai-blender 01234567" in the Vast.ai console'
      }
    ])
    expect(p.message).toBe('2 instances may still be billing')
    expect(p.detail).toContain(
      '• instance 4242 (RTX 4090 ×8, $3.20/hr): destroy failed: 500 internal error'
    )
    expect(p.detail).toContain(
      '• the rental "vastai-blender 01234567" (RTX 4090, $0.40/hr): Vast never answered its create'
    )
    expect(p.detail).toContain(VAST_CONSOLE)
    expect(p.choices).toEqual(['retry', 'console', 'quitAnyway'])
    // Esc must never quit: the instances are still billing.
    expect(choiceOf(p, p.cancelId)).toBe('retry')
  })

  it('prefers the label the node carries (plan 1.3) over the one it guesses', () => {
    expect(
      describeNode(node({ instanceId: null, label: 'vastai-blender 1a2b3c4d:abcdef01' }))
    ).toContain('"vastai-blender 1a2b3c4d:abcdef01"')
  })
})

describe('VR_QUIT_POLICY', () => {
  it.each<[string | undefined, string]>([
    [undefined, 'destroy'],
    ['', 'destroy'],
    ['destroy', 'destroy'],
    [' Leave ', 'leave']
  ])('%j is %s', (value, policy) => {
    expect(parseQuitPolicy(value)).toEqual({ policy, warning: null })
  })

  it('a typo destroys, and says so', () => {
    const r = parseQuitPolicy('keep')
    expect(r.policy).toBe('destroy')
    expect(r.warning).toContain('VR_QUIT_POLICY="keep"')
  })
})

describe('campaignDone', () => {
  it('only when no job is open and no chunk is in flight', () => {
    expect(campaignDone(0, [node()])).toBe(true)
    expect(campaignDone(0, [])).toBe(true)
    expect(campaignDone(1, [node()])).toBe(false)
    expect(
      campaignDone(0, [node({ currentWork: [{ chunkId: 'c', jobId: 'j', gpu: null }] })])
    ).toBe(false)
  })
})

describe('sleep', () => {
  it('warns that sleeping nodes keep billing', () => {
    expect(sleepWarning(billingFleet([node(), node({ id: 'b' })]))).toBe(
      'Going to sleep with 2 nodes billing $0.80/hr: they keep billing while this computer ' +
        'sleeps, and nothing renders or downloads until it wakes'
    )
  })

  it('on waking, says how long and about what it cost', () => {
    const at = 1_000_000
    expect(wakeNotice({ at, nodes: 2, perHour: 3 }, at + 2 * 3_600_000 + 5 * 60_000)).toBe(
      'Awake after 2 h 5 min: 2 nodes billed about $6.25 while this computer slept, ' +
        'with nothing rendering or downloading'
    )
  })

  it('says nothing when nothing was billing, or for a nap under a minute', () => {
    expect(wakeNotice(null, 5)).toBeNull()
    expect(wakeNotice({ at: 0, nodes: 0, perHour: 0 }, 3_600_000)).toBeNull()
    expect(wakeNotice({ at: 0, nodes: 1, perHour: 1 }, 59_000)).toBeNull()
  })

  it.each<[number, string]>([
    [30_000, 'under a minute'],
    [45 * 60_000, '45 min'],
    [3 * 3_600_000, '3 h'],
    [3_600_000 + 60_000, '1 h 1 min']
  ])('fmtDuration(%i) is %s', (ms, text) => {
    expect(fmtDuration(ms)).toBe(text)
  })
})
