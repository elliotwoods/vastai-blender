/**
 * What the Vast balance is paying for, and how long it lasts (plan 1.20,
 * finding #258). The toolbar's balance pill used to turn amber under a fixed
 * $5, which says nothing: $5 is days for one small node and minutes for
 * three 8×4090s. It now reads the runway the way main's credit guard does:
 * the balance over everything the account bills, this fleet and every other
 * instance on the account, since one balance pays for them all.
 */

import { capUsage } from '../../../shared/nodeState'
import type { UnclaimedInstance } from '../../../shared/models'

/** Main warns under this many minutes of runway (nodeManager RUNWAY_WARN_MIN). */
export const RUNWAY_WARN_MIN = 30
/** Main holds renting under this many (nodeManager RUNWAY_HOLD_MIN). */
export const RUNWAY_HOLD_MIN = 10

/**
 * An unclaimed instance bills its rate unless Vast has stopped it: an
 * 'exited' or 'stopped' instance bills its storage only. An unknown status
 * counts, as main's accountPerHour counts it: guessing high warns early.
 */
export function billsNow(u: Pick<UnclaimedInstance, 'status' | 'dphTotal'>): boolean {
  return u.dphTotal != null && u.dphTotal > 0 && u.status !== 'exited' && u.status !== 'stopped'
}

/** $/hr of the unclaimed instances still billing. */
export function unclaimedPerHour(
  list: ReadonlyArray<Pick<UnclaimedInstance, 'status' | 'dphTotal'>>
): number {
  let sum = 0
  for (const u of list) if (billsNow(u)) sum += u.dphTotal ?? 0
  return sum
}

/**
 * $/hr the account bills: this fleet's nodes that may be billing
 * (capUsage, the caps' own count) plus the unclaimed instances billing.
 */
export function accountPerHour(
  nodes: Parameters<typeof capUsage>[0],
  unclaimed: ReadonlyArray<Pick<UnclaimedInstance, 'status' | 'dphTotal'>>
): { fleet: number; others: number; total: number } {
  const fleet = capUsage(nodes).perHour
  const others = unclaimedPerHour(unclaimed)
  return { fleet, others, total: fleet + others }
}

/** Minutes `balance` lasts at `perHour`: 0 once spent, Infinity when nothing bills. */
export function runwayMinutes(balance: number, perHour: number): number {
  if (!(balance > 0)) return 0
  if (!(perHour > 0)) return Number.POSITIVE_INFINITY
  return (balance / perHour) * 60
}

/** 'danger' where main holds renting, 'warn' where it warns, else null. */
export function runwayTone(minutes: number): 'danger' | 'warn' | null {
  if (minutes < RUNWAY_HOLD_MIN) return 'danger'
  if (minutes < RUNWAY_WARN_MIN) return 'warn'
  return null
}

/** "about 3h 20m", "about 12 min", "under a minute"; "" when nothing bills. */
export function fmtRunway(minutes: number): string {
  if (!Number.isFinite(minutes)) return ''
  if (minutes < 1) return 'under a minute'
  if (minutes < 60) return `about ${Math.floor(minutes)} min`
  const h = Math.floor(minutes / 60)
  if (h >= 48) return `about ${Math.floor(h / 24)} days`
  return `about ${h}h ${String(Math.floor(minutes % 60)).padStart(2, '0')}m`
}
