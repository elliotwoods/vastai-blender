import { describe, expect, it } from 'vitest'
import type { FleetHolds } from '../../../shared/models'
import { holdRows } from './holds'

// Why the fleet is not renting (#200): each hold in force gets a row that
// names it and offers what lifts it. Field incident 1d59516c: the Vast
// balance hit $0 mid-render, scale-up made 12 refused rent attempts, and
// nothing on screen said why.

describe('holdRows', () => {
  it('says nothing when the fleet rents freely', () => {
    expect(holdRows({})).toEqual([])
    expect(holdRows(undefined)).toEqual([])
  })

  it('names a spent balance, with the balance and a way to top up (1d59516c)', () => {
    const [row] = holdRows({
      account: { reason: 'insufficient_credit (400)', balance: 0, since: 1_000 }
    })
    expect(row.kind).toBe('account')
    expect(row.tone).toBe('danger')
    expect(row.text).toContain('Renting is paused: insufficient_credit (400).')
    expect(row.text).toContain('Vast balance $0.00.')
    expect(row.topUp).toBe(true)
    expect(row.apiKey).toBe(false)
    expect(row.release?.label).toBe('Try now')
  })

  it('does not name the balance twice when the reason already does', () => {
    const [row] = holdRows({
      account: { reason: 'Vast balance $0.42, lasts about 3 min', balance: 0.42, since: 1 }
    })
    expect(row.text.match(/\$0\.42/g)).toHaveLength(1)
  })

  it('sends a refused key to Settings rather than to the billing page', () => {
    const [row] = holdRows({
      account: { reason: 'Vast.ai refused the API key (401)', balance: 12.5, since: 1 }
    })
    expect(row.apiKey).toBe(true)
    expect(row.topUp).toBe(false)
  })

  it('names a disk that will not take frames, and when scale-up tries again', () => {
    const rows = holdRows({
      localSink: { reason: 'the project folder’s disk is full', since: 1 },
      scale: { reason: '3 rentals in a row failed', since: 2, retryAt: null }
    })
    expect(rows.map((r) => r.kind)).toEqual(['localSink', 'scale'])
    expect(rows[0].text).toContain(
      'Downloads and new work are paused: the project folder’s disk is full.'
    )
    expect(rows[0].release?.label).toBe('Check again')
    expect(rows[1].text).toBe('Scale-up is backing off: 3 rentals in a row failed.')
  })

  it('asks before renting for recovered work, with Resume as its one action', () => {
    const [row] = holdRows({ recovery: 3 })
    expect(row.text).toContain('3 unfinished chunks recovered from your last session')
    expect(row.release).toMatchObject({ label: 'Resume rendering', primary: true })
    expect(holdRows({ recovery: 0 })).toEqual([])
  })

  it('puts money first', () => {
    const rows = holdRows({
      recovery: 1,
      scale: { reason: 'r', since: 1, retryAt: null },
      localSink: { reason: 'r', since: 1 },
      account: { reason: 'r', balance: null, since: 1 }
    })
    expect(rows.map((r) => r.kind)).toEqual(['account', 'localSink', 'scale', 'recovery'])
  })

  it('still says a hold this build has no name for, with its release', () => {
    const holds = {
      diskQuota: { reason: 'a hold from a newer main', since: 5 }
    } as unknown as FleetHolds
    const [row] = holdRows(holds)
    expect(row.kind).toBe('diskQuota')
    expect(row.text).toBe('Renting is paused: a hold from a newer main.')
    expect(row.since).toBe(5)
    expect(row.release?.label).toBe('Release')
  })

  it('1.18: a sign-in nobody made pauses Octane rentals only, and says how to go on', () => {
    const holds = {
      octaneSignIn: { reason: 'nobody signed in on node 1234', since: 5, nodeId: 'n' }
    } as unknown as FleetHolds
    const [row] = holdRows(holds)
    expect(row.kind).toBe('octaneSignIn')
    expect(row.text).toContain('Octane rentals are paused: nobody signed in on node 1234.')
    expect(row.text).toContain('VNC login')
  })
})
