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
    expect(row.text).toContain('Renting resumes by itself within a minute of a top-up')
  })

  // Review of 1.20: a one-click "Try now" on a money hold was main's
  // override, not a retry. Released by hand, a runway hold is not set again
  // until the runway has recovered, so one click before a payment landed
  // rented into an account about to hit $0, the credit guard silenced. Main
  // lifts a money hold by itself at the first balance read after a top-up.
  it('offers no release for a spent balance or a short runway: only Top up (1d59516c)', () => {
    for (const reason of [
      'insufficient_credit (400)',
      'Vast balance too low',
      'Vast wants payment',
      "Vast balance $2.40, about 9 min at the fleet's $16.00/hr"
    ]) {
      const [row] = holdRows({ account: { reason, balance: 2.4, since: 1 } })
      expect(row.release, reason).toBeNull()
      expect(row.topUp, reason).toBe(true)
    }
  })

  it('reads a balance whose digits look like a 401 as money, not a key', () => {
    const [row] = holdRows({
      account: {
        reason: "Vast balance $401.00, about 9 min at the account's $2,700.00/hr",
        balance: 401,
        since: 1
      }
    })
    expect(row.release).toBeNull()
    expect(row.apiKey).toBe(false)
  })

  it('goes by the hold’s own cause when main sends one', () => {
    const withCause = (reason: string, cause: string): FleetHolds =>
      ({ account: { reason, balance: 5, since: 1, cause } }) as unknown as FleetHolds
    expect(holdRows(withCause('no Vast.ai API key', 'runway'))[0].release).toBeNull()
    expect(holdRows(withCause('something new', 'auth'))[0].release?.label).toBe('Try now')
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
    // Main holds again at the next refusal, so asking again costs nothing.
    expect(row.release?.label).toBe('Try now')
    expect(row.text).not.toContain('top-up')
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
