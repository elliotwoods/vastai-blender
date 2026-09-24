import { describe, expect, it } from 'vitest'
import type { HistorySummary } from '../../../../shared/models'
import { recordingBegan } from './recordingBegan'

const HOUR = 3_600_000
const fromMs = 1_000 * HOUR
/** Usage recording began long before balance recording, and long before the window. */
const usageBegan = fromMs - 90 * 24 * HOUR

type Data = Parameters<typeof recordingBegan>[1]
const summary = (p: Partial<Data> = {}): Data => ({
  fromMs,
  earliestMs: usageBegan,
  balancePoints: [],
  totals: { wh: 1 } as HistorySummary['totals'],
  ...p
})

describe('recordingBegan (#117)', () => {
  it('adds no note to a quiet balance window, which the chart now draws across', () => {
    // The restamped anchor is the whole series: the balance was known before
    // the window, so the usage log's start date explains nothing.
    const data = summary({ balancePoints: [{ ts: fromMs, balance: 42 }] })
    expect(recordingBegan('balance', data, 1)).toBeNull()
  })

  it('dates a balance line that starts late by its own first reading', () => {
    const first = fromMs + 5 * HOUR
    const data = summary({
      balancePoints: [
        { ts: first, balance: 42 },
        { ts: first + HOUR, balance: 40 }
      ]
    })
    expect(recordingBegan('balance', data, 2)).toBe(first)
  })

  it('leaves an empty balance window to the chart’s own note', () => {
    expect(recordingBegan('balance', summary(), 0)).toBeNull()
  })

  it('dates the usage views by the usage log, as before', () => {
    expect(recordingBegan('spend', summary(), 0)).toBe(usageBegan)
    expect(recordingBegan('spend', summary(), 24)).toBeNull()
    expect(recordingBegan('fleet', summary(), 0)).toBe(usageBegan)
    expect(
      recordingBegan('power', summary({ totals: { wh: 0 } as HistorySummary['totals'] }), 24)
    ).toBe(usageBegan)
    expect(recordingBegan('power', summary(), 24)).toBeNull()
  })

  it('has no date to give when nothing was ever recorded', () => {
    expect(recordingBegan('spend', summary({ earliestMs: null }), 0)).toBeNull()
  })
})
