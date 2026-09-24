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
 */

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { btn, type BtnVariant, type ControlSize } from '../lib/controls'
import { TOKENS } from '../lib/theme'
import { CONFIRM_WINDOW_MS, confirmClick } from './confirm'

export interface ConfirmButtonProps {
  /** the resting label: "destroy", "cancel" */
  label: string
  /** the armed label; defaults to "confirm <label>?" */
  confirmLabel?: ReactNode
  onConfirm: () => void
  variant?: BtnVariant
  size?: ControlSize
  disabled?: boolean
  title?: string
  style?: CSSProperties
  /** how long the armed state lasts */
  windowMs?: number
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
  windowMs = CONFIRM_WINDOW_MS
}: ConfirmButtonProps): React.JSX.Element {
  const [armedAt, setArmedAt] = useState<number | null>(null)

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

  const armed = armedAt != null && !disabled

  return (
    <button
      type="button"
      disabled={disabled}
      title={armed ? 'click again to confirm' : title}
      onClick={(e) => {
        // These sit inside click-to-expand rows — never toggle the row.
        e.stopPropagation()
        const next = confirmClick(armedAt, performance.now(), windowMs)
        setArmedAt(next.armedAt)
        if (next.fire) onConfirm()
      }}
      onKeyDown={(e) => {
        // A held Enter repeats its click past the settle time — one press
        // must never both arm and fire.
        if (e.key === 'Enter' && e.repeat) {
          e.preventDefault()
          return
        }
        if (e.key === 'Escape' && armed) {
          e.stopPropagation()
          setArmedAt(null)
        }
      }}
      onBlur={() => setArmedAt(null)}
      style={{
        ...btn({ variant, size, disabled }),
        ...(armed
          ? { background: TOKENS.dangerBg, borderColor: TOKENS.danger, color: TOKENS.text }
          : null),
        ...style
      }}
    >
      {/* Announced when it changes, so a screen reader hears the question. */}
      <span aria-live="polite">{armed ? (confirmLabel ?? `confirm ${label}?`) : label}</span>
    </button>
  )
}
