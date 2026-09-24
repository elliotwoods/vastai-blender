/**
 * Alerts from main — renderer-local, fed by the `alert` push event and seeded
 * from `alerts:recent` when the window mounts (both in useIpcEvents).
 *
 * Nothing subscribed to `alert` before this, so every "Destroy failed ...
 * check the Vast.ai console!" main has ever raised went nowhere. The seed
 * matters as much as the push: the boot-time orphan sweep runs before the
 * window exists, and main keeps what it raised (events.ts) for this replay.
 *
 * Identical alerts collapse into one entry that counts (alertKey, the rule
 * main's buffer uses too), so scale-up failing every 15 s is one line going
 * ×2, ×3... rather than a toast every 15 s.
 *
 * Two surfaces read this. AlertBanner shows the sticky ones (errors, and
 * anything that means an instance may be billing unmanaged) until the user
 * dismisses them. AlertToasts shows the rest briefly.
 */

import { create } from 'zustand'
import { alertKey, isBillingRisk, isStickyAlert, type AlertRecord } from '../../../shared/ipc'
import type { AlertEvent } from '../../../shared/models'

/** Entries kept. Repeats share one, so this is distinct alerts, not events. */
export const MAX_ALERTS = 200
/**
 * How long a toast stays up. A warning gets longer: it usually wants reading.
 * (Errors never toast; they are sticky.)
 */
export function toastMs(level: AlertEvent['level']): number {
  return level === 'warn' ? 9_000 : 5_000
}
/**
 * A dismissed alert that fires again comes back, but not within this long of
 * its dismissal. A toast that times out counts as dismissed, so a failure
 * repeating every 15 s toasts once per quiet period, not every 15 s.
 */
export const RESURFACE_MS = 5 * 60_000
/**
 * A replayed toast-level alert is shown only if it last fired this recently:
 * the boot-time ones, raised seconds before the window opened. Older ones are
 * history, and a window reopened on macOS should not toast an hour of it.
 * Sticky alerts are always shown until dismissed, however old.
 */
export const REPLAY_TOAST_MS = 60_000

export interface AlertItem {
  key: string
  level: AlertEvent['level']
  message: string
  firstSeen: number
  lastSeen: number
  count: number
  /** Banner until dismissed; see isStickyAlert. */
  sticky: boolean
  /** Gets the "Open Vast console" action. */
  billingRisk: boolean
  /** When it was last put in front of the user. A toast's timer runs from here. */
  surfacedAt: number
  /** When it was dismissed (closed, or its toast ran out); null while on screen. */
  dismissedAt: number | null
}

interface AlertState {
  /** Least recently seen first. */
  items: AlertItem[]
  /**
   * One pushed alert. Returns true when it was put in front of the user: new,
   * or back after a quiet period. False when it only counted up on an entry
   * that is already showing, or is still quiet after a dismissal.
   */
  receive: (e: AlertEvent, now?: number) => boolean
  /** Main's buffer (alerts:recent). Idempotent, and safe after pushes that raced it. */
  seed: (records: AlertRecord[], now?: number) => void
  dismiss: (keys: string[], now?: number) => void
  /** Dismiss every toast whose time is up. */
  expireToasts: (now?: number) => void
}

/**
 * Hold the list to MAX_ALERTS by dropping the least recently seen entry that
 * is not a sticky alert still on screen. Evicting one of those would take a
 * billing warning off the banner before anyone had dismissed it.
 */
function capped(items: AlertItem[]): AlertItem[] {
  if (items.length <= MAX_ALERTS) return items
  const next = items.slice()
  while (next.length > MAX_ALERTS) {
    const i = next.findIndex((a) => !(a.sticky && a.dismissedAt === null))
    next.splice(i >= 0 ? i : 0, 1)
  }
  return next
}

function byLastSeen(a: AlertItem, b: AlertItem): number {
  return a.lastSeen - b.lastSeen
}

export const useAlertStore = create<AlertState>((set, get) => ({
  items: [],

  receive: (e, now = Date.now()) => {
    const key = alertKey(e)
    const items = get().items
    const i = items.findIndex((a) => a.key === key)
    if (i < 0) {
      const item: AlertItem = {
        key,
        level: e.level,
        message: e.message,
        firstSeen: now,
        lastSeen: now,
        count: 1,
        sticky: isStickyAlert(e),
        billingRisk: isBillingRisk(e),
        surfacedAt: now,
        dismissedAt: null
      }
      set({ items: capped([...items, item]) })
      return true
    }
    const prev = items[i]
    const back = prev.dismissedAt !== null && now - prev.dismissedAt >= RESURFACE_MS
    const next: AlertItem = {
      ...prev,
      count: prev.count + 1,
      lastSeen: now,
      ...(back ? { surfacedAt: now, dismissedAt: null } : {})
    }
    // Moved to the newest end: the list is ordered by lastSeen.
    set({ items: [...items.slice(0, i), ...items.slice(i + 1), next] })
    return back
  },

  seed: (records, now = Date.now()) =>
    set((s) => {
      const byKey = new Map(s.items.map((a) => [a.key, a]))
      for (const r of records) {
        const have = byKey.get(r.key)
        if (have) {
          // Already here: a push that arrived before this reply, which main's
          // buffer counted too, or a second seed (StrictMode mounts twice).
          // Taking the larger count, rather than adding, counts it once
          // either way. What the user has seen and dismissed is kept.
          byKey.set(r.key, {
            ...have,
            count: Math.max(have.count, r.count),
            firstSeen: Math.min(have.firstSeen, r.ts),
            lastSeen: Math.max(have.lastSeen, r.lastSeen)
          })
          continue
        }
        const sticky = isStickyAlert(r)
        const show = sticky || now - r.lastSeen < REPLAY_TOAST_MS
        byKey.set(r.key, {
          key: r.key,
          level: r.level,
          message: r.message,
          firstSeen: r.ts,
          lastSeen: r.lastSeen,
          count: r.count,
          sticky,
          billingRisk: isBillingRisk(r),
          surfacedAt: now,
          // Not shown, and never seen: dismissed at 0 means that if it fires
          // again it comes straight back rather than waiting out a quiet period.
          dismissedAt: show ? null : 0
        })
      }
      return { items: capped([...byKey.values()].sort(byLastSeen)) }
    }),

  dismiss: (keys, now = Date.now()) =>
    set((s) => {
      const drop = new Set(keys)
      let changed = false
      const items = s.items.map((a) => {
        if (!drop.has(a.key) || a.dismissedAt !== null) return a
        changed = true
        return { ...a, dismissedAt: now }
      })
      return changed ? { items } : s
    }),

  expireToasts: (now = Date.now()) =>
    set((s) => {
      let changed = false
      const items = s.items.map((a) => {
        if (a.sticky || a.dismissedAt !== null || now - a.surfacedAt < toastMs(a.level)) return a
        changed = true
        return { ...a, dismissedAt: now }
      })
      return changed ? { items } : s
    })
}))

/**
 * An OS notification for an error while the window is not in front: behind
 * another app, or minimised. The banner is where it is dealt with; this says
 * to go and look. Only for alerts `receive` put in front of the user, so a
 * repeating error notifies once per quiet period, and not for the replay at
 * mount, when the window has just opened.
 */
export function notifyIfUnfocused(e: AlertEvent): void {
  if (document.hasFocus()) return
  if (typeof Notification === 'undefined' || Notification.permission === 'denied') return
  const n = new Notification('Vast Render', { body: e.message })
  n.onclick = () => window.focus()
}
