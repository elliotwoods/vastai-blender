import { describe, expect, it } from 'vitest'
import { octaneCap, octaneStateOf } from './octane'

// NodeDetail's Octane chip and VNC login read octaneState (plan 1.18), or
// for a snapshot from before it, the two flags it replaced.

const flags = { octaneReady: false, octaneNeedsManualLogin: false }

describe('octaneStateOf', () => {
  it('takes octaneState as main sends it', () => {
    expect(octaneStateOf({ ...flags, octaneState: 'needsLogin' })).toBe('needsLogin')
    expect(octaneStateOf({ ...flags, octaneReady: true, octaneState: 'serverRunning' })).toBe(
      'serverRunning'
    )
  })

  it('falls back to the old flags', () => {
    expect(octaneStateOf({ ...flags, octaneReady: true })).toBe('licensed')
    expect(octaneStateOf({ ...flags, octaneNeedsManualLogin: true })).toBe('needsLogin')
    expect(octaneStateOf(flags)).toBe('none')
  })
})

describe('octaneCap', () => {
  it('warns for a sign-in, and never reads a starting server as licensed', () => {
    expect(octaneCap('needsLogin')).toEqual({ state: 'warn', label: 'octane sign-in needed' })
    expect(octaneCap('serverRunning')).toEqual({ state: 'unknown', label: 'octane starting' })
    expect(octaneCap('licensed').state).toBe('ok')
    expect(octaneCap('none').state).toBe('no')
  })
})
