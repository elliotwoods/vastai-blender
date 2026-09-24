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

/**
 * What a key does before the browser turns it into a click. 'swallow': a
 * held Enter's auto-repeat, each repeat another click, so one long press
 * would arm the button and then, past the settle time, fire it. 'disarm':
 * Escape while armed. null: leave the key alone.
 */
export function confirmKey(
  key: string,
  repeat: boolean,
  armed: boolean
): 'swallow' | 'disarm' | null {
  if (key === 'Enter' && repeat) return 'swallow'
  if (key === 'Escape' && armed) return 'disarm'
  return null
}

/**
 * Follow what onConfirm returned. A promise means the action is still under
 * way: the caller holds the button disabled until `onSettled` runs, so the
 * destroy already sent can't be sent again (#113: a second DELETE on a node
 * that is 'destroying' fails and raises a false "check the Vast.ai console"
 * alarm). Returns null when there is nothing to wait for.
 *
 * The returned promise rejects with the action's own error, after
 * `onSettled`: a failure is passed on, never swallowed, so it surfaces just
 * as the bare `void ipc.invoke(...)` it replaces did.
 */
export function settleOf(result: unknown, onSettled: () => void): Promise<void> | null {
  if (!isThenable(result)) return null
  return Promise.resolve(result).then(
    () => onSettled(),
    (err: unknown) => {
      onSettled()
      throw err
    }
  )
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return (
    v != null &&
    (typeof v === 'object' || typeof v === 'function') &&
    typeof (v as { then?: unknown }).then === 'function'
  )
}
