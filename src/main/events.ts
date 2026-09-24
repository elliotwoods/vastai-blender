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
 * one fired can still show it, and says which ones were put in front of the
 * user, for the OS notification (recentAlerts and onAlertSurfaced, at the end
 * of this file).
 */

import type { AlertEvent } from '../shared/models'
import {
  alertKey,
  isBillingRisk,
  isStickyAlert,
  isStillDismissed,
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
  if (channel === 'alert' && recordAlert(payload as AlertEvent, Date.now())) {
    // Before them too, so a window whose webContents.send throws does not
    // also cost the user the OS notification.
    for (const listener of [...surfacedListeners]) listener(payload as AlertEvent)
  }
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
// so a window can replay them when it mounts (the alerts:recent channel), and
// what the user dismissed (alerts:dismiss), so a replay skips those.

/** Distinct alerts kept. Repeats of one alert share an entry, so it is not a line count. */
export const MAX_RECENT_ALERTS = 100

/** Least recently seen first. */
const recent: AlertRecord[] = []
let nextAlertId = 1

type AlertListener = (alert: AlertEvent) => void

const surfacedListeners = new Set<AlertListener>()

/**
 * Subscribe to the alerts put in front of the user: one not in the buffer
 * yet, or a repeat that brings back one the user dismissed (isStillDismissed
 * turns false). A repeat of one still showing, or still quiet after its
 * dismissal, is not among them. ipc.ts raises the OS notification from this,
 * so scale-up failing every 15 s notifies once, while a failed destroy that
 * fails again after its dismissal notifies again. Only a banner's dismissals
 * reach main (alerts:dismiss), so a toast-level alert surfaces here only the
 * first time.
 *
 * Called from inside `emit`, once the alert is recorded and before the bus
 * listeners hear it. Returns the unsubscribe function.
 */
export function onAlertSurfaced(listener: AlertListener): () => void {
  surfacedListeners.add(listener)
  return () => {
    surfacedListeners.delete(listener)
  }
}

/**
 * Add one alert. An identical alert already in the buffer (alertKey) is not
 * added again: its count goes up, lastSeen moves to now, and it moves to the
 * newest end. So scale-up failing every 15 s is one entry that counts, and
 * cannot push everything else out.
 *
 * Returns whether the alert surfaced (onAlertSurfaced).
 */
function recordAlert(alert: AlertEvent, now: number): boolean {
  const key = alertKey(alert)
  const i = recent.findIndex((r) => r.key === key)
  if (i >= 0) {
    // A dismissal is kept: whether this repeat brings it back is
    // isStillDismissed's call, made against the new lastSeen.
    const [prev] = recent.splice(i, 1)
    const next = { ...prev, count: prev.count + 1, lastSeen: now }
    recent.push(next)
    return isStillDismissed(prev) && !isStillDismissed(next)
  }
  recent.push({
    id: nextAlertId++,
    key,
    level: alert.level,
    message: alert.message,
    ts: now,
    lastSeen: now,
    count: 1,
    dismissedAt: null
  })
  if (recent.length > MAX_RECENT_ALERTS) {
    // The least recently seen entry of the lowest tier present goes.
    let victim = 0
    for (let j = 1; j < recent.length; j++) {
      if (evictionTier(recent[j]) < evictionTier(recent[victim])) victim = j
    }
    recent.splice(victim, 1)
  }
  return true
}

/**
 * Which entries go first when the buffer is full, lowest tier first:
 *   0  nothing a reopened window would put in its banner: a toast-level
 *      alert, or one the user dismissed that has not come back since.
 *   1  an error a window would show.
 *   2  a billing risk. Errors can be distinct by the hundred (a dead node
 *      fails `dispatch <chunk> failed` for every pending chunk, and each
 *      requeue is a new chunk id), and they must not push out the one line
 *      saying an instance may still be billing.
 */
function evictionTier(r: AlertRecord): number {
  if (!isStickyAlert(r) || isStillDismissed(r)) return 0
  return isBillingRisk(r) ? 2 : 1
}

/** The buffer, least recently seen first, as copies. */
export function recentAlerts(): AlertRecord[] {
  return recent.map((r) => ({ ...r }))
}

/**
 * The user dismissed these (by alertKey) in a window. Remembered here, so a
 * window reopened or reloaded later does not replay what was already dealt
 * with: on macOS the window can close and reopen many times in one run.
 */
export function dismissAlerts(keys: string[]): void {
  const now = Date.now()
  const drop = new Set(keys)
  for (const r of recent) if (drop.has(r.key)) r.dismissedAt = now
}
