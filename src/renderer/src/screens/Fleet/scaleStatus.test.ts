import { describe, expect, it } from 'vitest'
import { scaleLine } from './scaleStatus'

// Why scale-up is or is not renting (#200): the scheduler's words, and a
// way to the limit that stops it when it is the user's own.

describe('scaleLine', () => {
  it('names the limit the user set, and offers the spend cap', () => {
    expect(
      scaleLine({ status: 'spend-cap', reason: 'the fleet bills $10.00/hr of $10.00/hr' })
    ).toEqual({
      tone: 'warn',
      text: 'Not renting: the fleet bills $10.00/hr of $10.00/hr.',
      spendCap: true
    })
    expect(scaleLine({ status: 'max-nodes', reason: 'at max nodes (4 of 4)' })?.text).toBe(
      'Not renting: at max nodes (4 of 4). Raise max nodes to rent more.'
    )
  })

  it('says quietly when the nodes up cover the work, or when it is renting', () => {
    expect(scaleLine({ status: 'covered', reason: 'the nodes up cover the work' })).toMatchObject({
      tone: 'muted',
      spendCap: false
    })
    expect(scaleLine({ status: 'rent', reason: 'short 2 lanes' })?.text).toBe(
      'Renting: short 2 lanes.'
    )
  })

  it('leaves a hold to HoldsBanner, and says nothing before the first tick', () => {
    expect(scaleLine({ status: 'held', reason: 'scale-up paused: x' })).toBeNull()
    expect(scaleLine(null)).toBeNull()
  })
})
