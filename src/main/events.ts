/**
 * The main-process event bus: every push event the renderer can receive
 * (`IpcEventMap`) is emitted here first.
 *
 * Deliberately free of Electron. Domain modules (nodeManager, scheduler, jobs,
 * the downloaders...) import `emit` from this module rather than from ipc.ts.
 * When `emit` lived in ipc.ts, which imports electron and every one of those
 * modules back, each of them sat in an import cycle, and none of them could
 * be loaded in a test without pulling in the whole IPC layer. ipc.ts is now
 * one subscriber: it forwards every event to every window (registerIpc). A
 * test harness is another.
 *
 * It also keeps the recent alerts, so a window that was not listening when
 * one fired can still show it (recentAlerts, at the end of this file).
 */

import type { AlertEvent } from '../shared/models'
import {
  alertKey,
  isStickyAlert,
  type AlertRecord,
  type EventChannel,
  type IpcEventMap
} from '../shared/ipc'

/** One emitted event, discriminated on `channel` so `payload` narrows. */
export type BusEvent = {
  [C in EventChannel]: { channel: C; payload: IpcEventMap[C] }
}[EventChannel]

type Listener = (event: BusEvent) => void

const listeners = new Set<Listener>()

/**
 * Subscribe to every event, in emit order. Returns the unsubscribe function.
 * A listener is called synchronously from inside `emit`.
 */
export function onEvent(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Subscribe to one channel. Returns the unsubscribe function. */
export function on<C extends EventChannel>(
  channel: C,
  listener: (payload: IpcEventMap[C]) => void
): () => void {
  return onEvent((e) => {
    if (e.channel === channel) listener(e.payload as IpcEventMap[C])
  })
}

/** Publish an event to every subscriber (and so to every window). */
export function emit<C extends EventChannel>(channel: C, payload: IpcEventMap[C]): void {
  // E2E observability: mirror events to stdout when driving headless tests. Both headless
  // drivers need this — without it a scripted run has no way to see why a chunk failed,
  // because the node's render log otherwise only ever reaches the renderer window.
  const headless = process.env.VR_E2E_BLEND || process.env.VR_JOB_SPEC
  if (headless && channel !== 'render:logLine') {
    console.log(`[event] ${channel} ${JSON.stringify(payload).slice(0, 240)}`)
  }
  if (headless && channel === 'render:logLine') {
    const l = payload as IpcEventMap['render:logLine']
    console.log(`[log:${l.nodeId.slice(0, 8)}] ${l.line}`)
  }
  // Before the listeners, so an alert is kept even when one of them throws.
  if (channel === 'alert') recordAlert(payload as AlertEvent, Date.now())
  const event = { channel, payload } as BusEvent
  // A copy, so a listener that unsubscribes (or subscribes) mid-emit cannot
  // change who hears this event. A throwing listener propagates to the
  // emitter, exactly as a throwing webContents.send did when this loop lived
  // in ipc.ts.
  for (const listener of [...listeners]) listener(event)
}

// -- recent alerts -------------------------------------------------------------
// A push reaches only the windows open when it is sent. nodeManager.init()
// sweeps orphans before createWindow(), and on macOS the window can be closed
// while the fleet keeps billing, so "orphan destroy failed ... check the
// Vast.ai console!" could reach no one. This buffer keeps the recent alerts
// so a window can replay them when it mounts (the alerts:recent channel).

/** Distinct alerts kept. Repeats of one alert share an entry, so it is not a line count. */
export const MAX_RECENT_ALERTS = 100

/** Least recently seen first. */
const recent: AlertRecord[] = []
let nextAlertId = 1

/**
 * Add one alert. An identical alert already in the buffer (alertKey) is not
 * added again: its count goes up, lastSeen moves to now, and it moves to the
 * newest end. So scale-up failing every 15 s is one entry that counts, and
 * cannot push everything else out.
 */
function recordAlert(alert: AlertEvent, now: number): void {
  const key = alertKey(alert)
  const i = recent.findIndex((r) => r.key === key)
  if (i >= 0) {
    const [prev] = recent.splice(i, 1)
    recent.push({ ...prev, count: prev.count + 1, lastSeen: now })
    return
  }
  recent.push({
    id: nextAlertId++,
    key,
    level: alert.level,
    message: alert.message,
    ts: now,
    lastSeen: now,
    count: 1
  })
  if (recent.length > MAX_RECENT_ALERTS) {
    // Evict the least recently seen alert that is not sticky. A burst of
    // per-file download warnings must not push out the one message saying an
    // instance is still billing. Only when every entry is sticky does the
    // oldest of them go.
    const j = recent.findIndex((r) => !isStickyAlert(r))
    recent.splice(j >= 0 ? j : 0, 1)
  }
}

/** The buffer, least recently seen first, as copies. */
export function recentAlerts(): AlertRecord[] {
  return recent.map((r) => ({ ...r }))
}
