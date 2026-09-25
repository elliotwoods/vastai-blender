/**
 * A button that asks before it acts: the first click arms it and swaps the
 * label for "confirm destroy?", a second click within a few seconds fires.
 * Inline rather than a modal, so confirming costs one more click in the same
 * place instead of a dialog to read and dismiss. For destroy and cancel, where
 * one stray click ends a paid-for node or a half-rendered job.
 *
 * It disarms by itself after CONFIRM_WINDOW_MS, and at once on Escape or
 * when focus leaves it, so an armed button is never left waiting for an
 * unrelated click. A double-click's second click is ignored (see
 * CONFIRM_SETTLE_MS), as is a held Enter's auto-repeat. It is a real
 * <button>, so Enter and Space work too.
 *
 * When onConfirm returns a promise, the button stays disabled until it
 * settles, so a destroy already on its way can't be sent twice (#113).
 * Callers still pass `disabled` for states the button can't see, such as a
 * node another path is already destroying.
 *
 * `icon` puts an icon before the label. With `iconOnly` too, it rests as a
 * square icon button (iconBtn) named by `label` for screen readers and the
 * tooltip, and grows to show the question in words once armed: a row's trash
 * button, say, that asks "cancel job?" in place.
 */

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { btn, iconBtn, type BtnVariant, type ControlSize } from '../lib/controls'
import { TOKENS } from '../lib/theme'
import { CONFIRM_WINDOW_MS, confirmClick, confirmKey, settleOf } from './confirm'
import { Icon, type IconName } from './Icon'

export interface ConfirmButtonProps {
  /** the resting label: "destroy", "cancel" */
  label: string
  /** the armed label; defaults to "confirm <label>?" */
  confirmLabel?: ReactNode
  /** Return the action's promise to hold the button disabled until it settles. */
  onConfirm: () => void | Promise<unknown>
  variant?: BtnVariant
  size?: ControlSize
  disabled?: boolean
  title?: string
  style?: CSSProperties
  /** how long the armed state lasts */
  windowMs?: number
  /** an icon before the label (and in place of it, with iconOnly) */
  icon?: IconName
  /** rest as a square icon button, `label` its accessible name; armed shows the question */
  iconOnly?: boolean
}

export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  variant = 'danger',
  size = 'sm',
  disabled = false,
  title,
  style,
  windowMs = CONFIRM_WINDOW_MS,
  icon,
  iconOnly = false
}: ConfirmButtonProps): React.JSX.Element {
  const [armedAt, setArmedAt] = useState<number | null>(null)
  // The confirmed action is still in flight.
  const [pending, setPending] = useState(false)
  const off = disabled || pending

  // A button disabled while armed (its destroy already under way) comes back
  // disarmed: re-enabled on a failure, it must not fire on the next click.
  const [wasDisabled, setWasDisabled] = useState(disabled)
  if (disabled !== wasDisabled) {
    setWasDisabled(disabled)
    if (disabled) setArmedAt(null)
  }

  useEffect(() => {
    if (armedAt == null) return
    const t = window.setTimeout(() => setArmedAt(null), windowMs)
    return () => window.clearTimeout(t)
  }, [armedAt, windowMs])

  const armed = armedAt != null && !off
  // An icon-only button at rest: square, and named by its label.
  const bare = iconOnly && icon != null && !armed
  const iconSize = size === 'sm' ? 13 : 15

  return (
    <button
      type="button"
      disabled={off}
      aria-busy={pending || undefined}
      aria-label={bare ? label : undefined}
      title={armed ? 'click again to confirm' : (title ?? (bare ? label : undefined))}
      onClick={(e) => {
        // These sit inside click-to-expand rows — never toggle the row.
        e.stopPropagation()
        if (off) return
        const next = confirmClick(armedAt, performance.now(), windowMs)
        setArmedAt(next.armedAt)
        if (!next.fire) return
        const settled = settleOf(onConfirm(), () => setPending(false))
        if (settled) {
          setPending(true)
          // Rejects only with the action's own error, which stays unhandled
          // here exactly as the caller's bare promise would have been.
          void settled
        }
      }}
      onKeyDown={(e) => {
        const act = confirmKey(e.key, e.repeat, armed)
        if (act === 'swallow') e.preventDefault()
        if (act === 'disarm') {
          e.stopPropagation()
          setArmedAt(null)
        }
      }}
      onBlur={() => setArmedAt(null)}
      style={{
        ...btn({ variant, size, disabled: off }),
        ...(bare ? { ...iconBtn({ size, disabled: off }), ...colorsOf(variant, off) } : null),
        ...(armed
          ? { background: TOKENS.dangerBg, borderColor: TOKENS.danger, color: TOKENS.text }
          : null),
        ...style
      }}
    >
      {/* Announced when it changes, so a screen reader hears the question. */}
      {icon && !armed ? <Icon name={icon} size={iconSize} /> : null}
      <span aria-live="polite">
        {armed ? (confirmLabel ?? `confirm ${label}?`) : bare ? null : label}
      </span>
    </button>
  )
}

/** The variant's colours on an icon button's square (iconBtn is always "default"). */
function colorsOf(variant: BtnVariant, disabled: boolean): CSSProperties {
  if (disabled) return {}
  const { background, borderColor, color } = btn({ variant, size: 'sm' })
  return { background, borderColor, color }
}
