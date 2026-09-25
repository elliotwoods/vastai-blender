import { describe, expect, it } from 'vitest'
import { fmtEta, fmtSpan, fmtStride, ordinal } from './format'

describe('fmtSpan', () => {
  it('says seconds, then minutes and seconds, hours and minutes, days and hours', () => {
    expect(fmtSpan(0)).toBe('0s')
    expect(fmtSpan(999)).toBe('0s')
    expect(fmtSpan(45_000)).toBe('45s')
    expect(fmtSpan(60_000)).toBe('1m 00s')
    expect(fmtSpan(200_000)).toBe('3m 20s')
    expect(fmtSpan((2 * 3600 + 5 * 60 + 59) * 1000)).toBe('2h 05m')
    expect(fmtSpan(24 * 3_600_000 - 1)).toBe('23h 59m')
    expect(fmtSpan(27 * 3_600_000)).toBe('1d 3h')
  })

  it('reads a negative or broken span as nothing', () => {
    expect(fmtSpan(-5000)).toBe('0s')
    expect(fmtSpan(Number.NaN)).toBe('0s')
    expect(fmtSpan(Number.POSITIVE_INFINITY)).toBe('0s')
  })
})

describe('fmtEta', () => {
  // Local-time constructors, so these hold in any time zone the suite runs in.
  // 2026-09-22 is a Tuesday.
  const now = new Date(2026, 8, 22, 9, 15).getTime()
  const at = (month: number, day: number, h: number, m: number, year = 2026): number =>
    new Date(year, month, day, h, m).getTime()

  it('is a clock time on the same day', () => {
    expect(fmtEta(at(8, 22, 14, 32), now)).toBe('14:32')
    expect(fmtEta(at(8, 22, 0, 5), now)).toBe('00:05')
    expect(fmtEta(at(8, 22, 23, 59), now)).toBe('23:59')
  })

  it('names the weekday within a week, either side', () => {
    expect(fmtEta(at(8, 23, 1, 0), now)).toBe('Wed 01:00')
    expect(fmtEta(at(8, 28, 18, 4), now)).toBe('Mon 18:04')
    expect(fmtEta(at(8, 21, 14, 32), now)).toBe('Mon 14:32')
  })

  it('is a short date further out, with the year when it is not this one', () => {
    expect(fmtEta(at(8, 29, 12, 0), now)).toBe('29 Sep')
    expect(fmtEta(at(9, 3, 12, 0), now)).toBe('3 Oct')
    expect(fmtEta(at(0, 4, 12, 0, 2027), now)).toBe('4 Jan 2027')
  })
})

describe('fmtStride', () => {
  it('says how often a sample is taken', () => {
    expect(fmtStride(1)).toBe('every frame')
    expect(fmtStride(2)).toBe('every 2nd frame')
    expect(fmtStride(12)).toBe('every 12th frame')
    expect(fmtStride(21)).toBe('every 21st frame')
  })

  it('ordinal handles the teens', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 22, 103, 111].map(ordinal)).toEqual([
      '1st',
      '2nd',
      '3rd',
      '4th',
      '11th',
      '12th',
      '13th',
      '22nd',
      '103rd',
      '111th'
    ])
  })
})
