import { describe, expect, it } from 'vitest'
import { CONFIRM_SETTLE_MS, CONFIRM_WINDOW_MS, confirmClick } from './confirm'

describe('confirmClick', () => {
  it('only arms on the first click — one click never destroys', () => {
    expect(confirmClick(null, 10_000)).toEqual({ armedAt: 10_000, fire: false })
  })

  it('fires on a second click inside the window, and disarms', () => {
    expect(confirmClick(10_000, 11_000)).toEqual({ armedAt: null, fire: true })
    expect(confirmClick(10_000, 10_000 + CONFIRM_WINDOW_MS)).toEqual({
      armedAt: null,
      fire: true
    })
  })

  it('ignores the second half of a double-click', () => {
    const armed = confirmClick(null, 10_000)
    const again = confirmClick(armed.armedAt, 10_000 + CONFIRM_SETTLE_MS - 1)
    expect(again).toEqual({ armedAt: 10_000, fire: false })
    // …and still fires on a real second click afterwards.
    expect(confirmClick(again.armedAt, 10_000 + CONFIRM_SETTLE_MS).fire).toBe(true)
  })

  it('treats a click after the window as a fresh first click', () => {
    expect(confirmClick(10_000, 10_000 + CONFIRM_WINDOW_MS + 1)).toEqual({
      armedAt: 10_000 + CONFIRM_WINDOW_MS + 1,
      fire: false
    })
  })

  it('never fires when the clock reads earlier than the arming', () => {
    expect(confirmClick(10_000, 9_000)).toEqual({ armedAt: 9_000, fire: false })
  })

  it('honours a caller-chosen window', () => {
    expect(confirmClick(0, 5_000, 10_000).fire).toBe(true)
    expect(confirmClick(0, 5_000, 4_000).fire).toBe(false)
  })
})
