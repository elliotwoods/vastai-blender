import { describe, expect, it } from 'vitest'
import { octaneCap, octaneStateOf, vncLoginKey } from './octane'

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

// Review of 1.18: the tunnel's address and password stayed in VncLogin's
// state after the node left needsLogin, and came back as if current the
// next time it needed a sign-in, over a tunnel that may have closed.
// VncLogin mounts its panel under this key, so the panel (and what it
// holds) goes when the key does and starts afresh when it changes.
describe('vncLoginKey', () => {
  const node = {
    ...flags,
    id: 'n1',
    instanceId: 777,
    sshHost: '1.2.3.4',
    sshPort: 22,
    octaneState: 'needsLogin' as const
  }

  it('offers no panel unless the node waits for a sign-in', () => {
    expect(vncLoginKey(node)).not.toBeNull()
    expect(vncLoginKey({ ...node, octaneState: 'licensed' })).toBeNull()
    expect(vncLoginKey({ ...node, octaneState: 'serverRunning' })).toBeNull()
    expect(vncLoginKey({ ...node, octaneState: 'none' })).toBeNull()
  })

  it('is the same panel while nothing the tunnel runs over changes', () => {
    expect(vncLoginKey({ ...node })).toBe(vncLoginKey(node))
  })

  it('is a new panel over a new connection or a new rental', () => {
    expect(vncLoginKey({ ...node, sshHost: '5.6.7.8' })).not.toBe(vncLoginKey(node))
    expect(vncLoginKey({ ...node, sshPort: 2222 })).not.toBe(vncLoginKey(node))
    expect(vncLoginKey({ ...node, instanceId: 778 })).not.toBe(vncLoginKey(node))
  })
})
