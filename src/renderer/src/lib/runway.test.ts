import { describe, expect, it } from 'vitest'
import type { NodeSnapshot } from '../../../shared/models'
import { accountPerHour, billsNow, fmtRunway, runwayMinutes, runwayTone } from './runway'

// The toolbar's balance reads as a runway, the way main's credit guard
// reckons it (plan 1.20, #258): the balance over everything the account
// bills, not a fixed $5.

type Facts = Pick<NodeSnapshot, 'state' | 'instanceId' | 'destroyedAt' | 'dphTotal'>

const node = (patch: Partial<Facts>): Facts => ({
  state: 'rendering',
  instanceId: 1,
  destroyedAt: null,
  dphTotal: 2,
  ...patch
})

describe('accountPerHour', () => {
  it('counts every node that may bill, and the unclaimed instances still running', () => {
    const rate = accountPerHour(
      [
        node({}),
        // Failed with its destroy unconfirmed: still billing.
        node({ state: 'failed', dphTotal: 1 }),
        // Confirmed gone.
        node({ state: 'destroyed', destroyedAt: 5, dphTotal: 8 })
      ],
      [
        { status: 'running', dphTotal: 4 },
        { status: null, dphTotal: 0.5 },
        { status: 'exited', dphTotal: 9 }
      ]
    )
    expect(rate).toEqual({ fleet: 3, others: 4.5, total: 7.5 })
  })

  it('counts an instance Vast stopped as storage only', () => {
    expect(billsNow({ status: 'stopped', dphTotal: 3 })).toBe(false)
    expect(billsNow({ status: 'loading', dphTotal: 3 })).toBe(true)
    expect(billsNow({ status: 'running', dphTotal: null })).toBe(false)
  })
})

describe('the runway', () => {
  it('lasts balance over rate', () => {
    expect(runwayMinutes(4, 8)).toBe(30)
    expect(runwayMinutes(0, 8)).toBe(0)
    expect(runwayMinutes(5, 0)).toBe(Infinity)
  })

  it('warns where main warns and holds where main holds', () => {
    expect(runwayTone(9.9)).toBe('danger')
    expect(runwayTone(29)).toBe('warn')
    expect(runwayTone(30)).toBeNull()
    expect(runwayTone(Infinity)).toBeNull()
  })

  it('reads as a duration', () => {
    expect(fmtRunway(0.5)).toBe('under a minute')
    expect(fmtRunway(12.7)).toBe('about 12 min')
    expect(fmtRunway(200)).toBe('about 3h 20m')
    expect(fmtRunway(60 * 72)).toBe('about 3 days')
    expect(fmtRunway(Infinity)).toBe('')
  })
})
