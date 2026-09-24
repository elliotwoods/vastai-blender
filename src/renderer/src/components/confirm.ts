/**
 * The decision behind ConfirmButton, pure so it can be tested without a DOM.
 * Destroy and cancel were single clicks (audit D4): one stray click on a row
 * of eight destroy buttons ends a paid-for, half-provisioned node.
 */

/** How long an armed button waits for its second click. */
export const CONFIRM_WINDOW_MS = 3_000

/**
 * A second click sooner than this after arming is the tail of a double-click,
 * not a decision. Most systems default the double-click interval to 500 ms;
 * without this, double-clicking "destroy" destroys.
 */
export const CONFIRM_SETTLE_MS = 500

/**
 * What a click does, given when the button was armed (null = not armed).
 * `now` must come from a monotonic clock (performance.now): a wall clock
 * stepping back must never turn a first click into a second one.
 */
export function confirmClick(
  armedAt: number | null,
  now: number,
  windowMs = CONFIRM_WINDOW_MS,
  settleMs = CONFIRM_SETTLE_MS
): { armedAt: number | null; fire: boolean } {
  const elapsed = armedAt == null ? -1 : now - armedAt
  // Not armed, expired, or a clock that ran backwards: this is a first click.
  if (elapsed < 0 || elapsed > windowMs) return { armedAt: now, fire: false }
  if (elapsed < settleMs) return { armedAt, fire: false }
  return { armedAt: null, fire: true }
}
