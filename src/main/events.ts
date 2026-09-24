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
 */

import type { EventChannel, IpcEventMap } from '../shared/ipc'

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
  const event = { channel, payload } as BusEvent
  // A copy, so a listener that unsubscribes (or subscribes) mid-emit cannot
  // change who hears this event. A throwing listener propagates to the
  // emitter, exactly as a throwing webContents.send did when this loop lived
  // in ipc.ts.
  for (const listener of [...listeners]) listener(event)
}
