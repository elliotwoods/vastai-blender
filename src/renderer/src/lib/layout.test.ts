import { describe, expect, it } from 'vitest'
import { fitColumns } from './layout'

const cols = [
  { key: 'name', width: 200 },
  { key: 'cost', width: 80, drop: 2 },
  { key: 'when', width: 80, drop: 1 },
  { key: 'state', width: 100 }
] as const

describe('fitColumns', () => {
  it('shows everything when it fits', () => {
    expect([...fitColumns(460, cols)]).toEqual(['name', 'cost', 'when', 'state'])
  })

  it('shows everything before the first measurement', () => {
    expect(fitColumns(0, cols).size).toBe(4)
  })

  it('drops the lowest drop first, only as far as needed', () => {
    expect([...fitColumns(400, cols)]).toEqual(['name', 'cost', 'state'])
    expect([...fitColumns(300, cols)]).toEqual(['name', 'state'])
  })

  it('never drops a column without a drop rank', () => {
    expect([...fitColumns(50, cols)]).toEqual(['name', 'state'])
  })
})
