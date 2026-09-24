import { describe, expect, it } from 'vitest'
import { CONFIRM_SETTLE_MS, CONFIRM_WINDOW_MS, confirmClick, confirmKey, settleOf } from './confirm'

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

describe('confirmKey', () => {
  it('drops a held Enter’s repeats, so one long press can never arm and then fire', () => {
    expect(confirmKey('Enter', true, false)).toBe('swallow')
    expect(confirmKey('Enter', true, true)).toBe('swallow')
    // The press itself is the button's click.
    expect(confirmKey('Enter', false, false)).toBeNull()
  })

  it('disarms on Escape only while armed, leaving Escape to the page otherwise', () => {
    expect(confirmKey('Escape', false, true)).toBe('disarm')
    expect(confirmKey('Escape', false, false)).toBeNull()
  })

  it('leaves every other key alone', () => {
    expect(confirmKey(' ', false, true)).toBeNull()
    expect(confirmKey('Tab', false, true)).toBeNull()
  })
})

describe('settleOf (#113)', () => {
  it('has nothing to wait for when the action returns nothing', () => {
    let settled = 0
    expect(settleOf(undefined, () => settled++)).toBeNull()
    expect(settled).toBe(0)
  })

  it('holds the button until the action’s promise resolves — never sooner', async () => {
    let finish!: () => void
    const action = new Promise<void>((r) => (finish = r))
    let settled = 0
    const p = settleOf(action, () => settled++)
    expect(p).not.toBeNull()
    await Promise.resolve()
    // Still destroying: a second click must find the button disabled.
    expect(settled).toBe(0)
    finish()
    await p
    expect(settled).toBe(1)
  })

  it('releases the button on failure and passes the failure on, never swallowing it', async () => {
    let settled = 0
    const boom = new Error('destroy failed')
    const p = settleOf(Promise.reject(boom), () => settled++)
    await expect(p).rejects.toBe(boom)
    expect(settled).toBe(1)
  })

  it('treats any thenable as a promise', async () => {
    let settled = 0
    const thenable = { then: (ok: (v: unknown) => void) => ok(1) }
    await settleOf(thenable, () => settled++)
    expect(settled).toBe(1)
  })
})
