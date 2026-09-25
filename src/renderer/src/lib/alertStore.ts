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
 * dismisses them. AlertToasts shows the rest briefly. The OS notification for
 * a sticky alert nobody is looking at is main's (ipc.ts), not this window's:
 * main can raise one with no window open, and bring the window forward.
 */

import { create } from 'zustand'
import {
  alertKey,
  isBillingRisk,
  isStickyAlert,
  isStillDismissed,
  RESURFACE_MS,
  type AlertRecord
} from '../../../shared/ipc'
import type { AlertEvent } from '../../../shared/models'

// Shared with main, which applies the same quiet period when a window replays
// its buffer (isStillDismissed). A toast that times out counts as dismissed
// here, so a failure repeating every 15 s toasts once per quiet period. A
// billing risk has no quiet period: any repeat after a dismissal is back.
export { RESURFACE_MS }

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
 * A replayed toast-level alert is shown only if it last fired this recently:
 * the boot-time ones, raised seconds before the window opened. Older ones are
 * history, and a window reopened on macOS should not toast an hour of it.
 * Sticky alerts are shown however old, unless the user dismissed them in an
 * earlier window (main keeps that; see alerts:dismiss).
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
   * or back after a dismissal (after the quiet period, or at once for a
   * billing risk). False when it only counted up on an entry that is already
   * showing, or is still quiet after a dismissal.
   */
  receive: (e: AlertEvent, now?: number) => boolean
  /** Main's buffer (alerts:recent). Idempotent, and safe after pushes that raced it. */
  seed: (records: AlertRecord[], now?: number) => void
  dismiss: (keys: string[], now?: number) => void
  /** Dismiss every toast whose time is up. */
  expireToasts: (now?: number) => void
}

/**
 * Which entries go first when the list is full, lowest tier first (the same
 * tiers as main's buffer):
 *   0  a toast, or anything dismissed: not on the banner.
 *   1  an error on the banner.
 *   2  a billing risk on the banner. A dead node can fail dispatch for every
 *      pending chunk, each a distinct error, and that burst must not take the
 *      line saying an instance may still be billing off the banner before
 *      anyone has seen it.
 */
function evictionTier(a: AlertItem): number {
  if (!a.sticky || a.dismissedAt !== null) return 0
  return a.billingRisk ? 2 : 1
}

/** Hold the list to MAX_ALERTS, dropping the least recently seen entry of the lowest tier. */
function capped(items: AlertItem[]): AlertItem[] {
  if (items.length <= MAX_ALERTS) return items
  const next = items.slice()
  while (next.length > MAX_ALERTS) {
    let victim = 0
    for (let i = 1; i < next.length; i++) {
      if (evictionTier(next[i]) < evictionTier(next[victim])) victim = i
    }
    next.splice(victim, 1)
  }
  return next
}

/**
 * The banner's rows: sticky alerts still on screen, billing risks first, then
 * newest first within each group. The banner shows only the first few, so a
 * burst of ordinary errors must not bury an instance that may still be
 * billing under "N more".
 */
export function bannerOrder(items: AlertItem[]): AlertItem[] {
  const open = items.filter((a) => a.sticky && a.dismissedAt === null).reverse()
  return [...open.filter((a) => a.billingRisk), ...open.filter((a) => !a.billingRisk)]
}

/**
 * How long a banner row must have been on screen before a click dismisses it.
 * A billing risk that arrives goes to the top and pushes the other rows down,
 * but the buttons under the pointer stay where they are. Without this, a
 * click meant for a row the user had read could dismiss the new row unread.
 * The same goes for the rows that move up after "Dismiss these 3", which a
 * second click would otherwise take.
 */
export const SETTLE_MS = 1_500

/**
 * When each banner row came on screen. AlertBanner reports the rows it has
 * drawn after every render, and dismisses only the rows `settled` returns.
 */
export class OnScreen {
  private readonly since = new Map<string, number>()

  /**
   * The rows on screen now. A new one is stamped `now`. One no longer drawn
   * is forgotten, so if it comes back it has to settle again.
   */
  drawn(keys: string[], now = Date.now()): void {
    const drawn = new Set(keys)
    for (const key of this.since.keys()) if (!drawn.has(key)) this.since.delete(key)
    for (const key of keys) if (!this.since.has(key)) this.since.set(key, now)
  }

  /** Of these rows, the ones on screen for at least SETTLE_MS. */
  settled(keys: string[], now = Date.now()): string[] {
    return keys.filter((key) => {
      const since = this.since.get(key)
      return since !== undefined && now - since >= SETTLE_MS
    })
  }
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
    // isStillDismissed's rule, for a window that was open all along.
    const back =
      prev.dismissedAt !== null && (prev.billingRisk || now - prev.dismissedAt >= RESURFACE_MS)
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
          // either way. What the user has seen and dismissed is kept, and so
          // is a dismissal from an earlier window: the push showed it only
          // because this window had not heard of that dismissal yet.
          const dismissedEarlier = have.dismissedAt === null && isStillDismissed(r)
          byKey.set(r.key, {
            ...have,
            count: Math.max(have.count, r.count),
            firstSeen: Math.min(have.firstSeen, r.ts),
            lastSeen: Math.max(have.lastSeen, r.lastSeen),
            ...(dismissedEarlier ? { dismissedAt: r.dismissedAt } : {})
          })
          continue
        }
        const sticky = isStickyAlert(r)
        // Dismissed in an earlier window (a macOS window closed and reopened,
        // or a reload): stays dismissed, with its own time, so a repeat comes
        // back when it would have in that window (at once, for a billing risk).
        const dismissed = isStillDismissed(r)
        const show = !dismissed && (sticky || now - r.lastSeen < REPLAY_TOAST_MS)
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
          dismissedAt: dismissed ? r.dismissedAt : show ? null : 0
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
