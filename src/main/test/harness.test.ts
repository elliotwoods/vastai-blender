import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AlertEvent } from '../../shared/models'
import { setup, type World } from './harness'

// Checks on the harness itself: that what it fakes agrees with the app it
// stands in for, and that events reach windows through the real ipc.ts.

let w: World
beforeEach(async () => {
  w = await setup()
})
afterEach(() => w.dispose())

describe('harness', () => {
  it('fakeSsh and provisioner agree on the remote root', async () => {
    const { REMOTE_ROOT } = await import('../nodes/provisioner')
    const fake = await import('./fakeSsh')
    expect(fake.REMOTE_ROOT).toBe(REMOTE_ROOT)
  })

  it('ipc.ts forwards every bus event, unchanged, to every open window', async () => {
    const app = await w.boot()
    const { emit } = await import('../events')
    const a = w.openWindow()
    const b = w.openWindow()

    const alert: AlertEvent = { level: 'error', message: 'destroy failed' }
    emit('alert', alert)
    w.vast.addOffer()
    const [id] = await app.nodeManager.requestNodes(1)
    await w.until(() => app.nodeManager.get(id)?.state === 'ready', 'node ready')

    // Everything the bus carried since the windows opened, in order, and the
    // same payload objects: what the renderer receives is what was emitted.
    const opened = w.events.findIndex((e) => e.channel === 'alert' && e.payload === alert)
    const expected = w.events.slice(opened).map((e) => ({ channel: e.channel, payload: e.payload }))
    expect(expected.length).toBeGreaterThan(3)
    expect(a.sent).toEqual(expected)
    expect(b.sent).toEqual(expected)
    expect(a.sent[0].payload).toBe(alert)
  })

  it('invoke reaches the real ipcMain handlers', async () => {
    await w.boot()
    const settings = await w.invoke('settings:get')
    expect(settings.projectRoot).toBe(w.settings.projectRoot)
    await w.invoke('settings:set', { idleTimeoutMinutes: 9 })
    expect(w.settings.idleTimeoutMinutes).toBe(9)
  })

  it('refuses a second boot: the engine is module singletons', async () => {
    await w.boot()
    await expect(w.boot()).rejects.toThrow('once per world')
  })
})
