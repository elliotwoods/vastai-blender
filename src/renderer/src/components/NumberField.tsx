/**
 * A number input that commits when the user is done: on blur or Enter, never
 * per keystroke. Typing "2.5" into a spend cap used to save 2, then "2.",
 * then 2.5, each one live; clearing it first saved "uncapped".
 *
 * A text input, not `type="number"`: that one reports '' for anything it
 * can't parse, so a typo and a deliberate blank look the same, and its
 * scroll-wheel stepping changes a focused value as the page scrolls. Arrow
 * keys still step the draft. Escape puts the value back.
 *
 * Blank is explicit. Pass `allowBlank="no cap"` and clearing the field
 * commits null, with the empty field reading "no cap". Without it, a cleared
 * field puts the last value back. Out-of-range numbers are clamped on commit
 * and flagged while typing, so the range is visible before it applies.
 *
 * While the field has focus, the draft is the user's: a background refetch
 * of `value` does not overwrite what they are typing. Switching to another
 * app mid-edit is not finishing it: the draft waits, uncommitted, for the
 * user to come back.
 *
 * The behaviour lives in numberDraft's fieldEvent(), with tests; this file
 * only binds DOM events to it.
 */

import { useRef, useState, type CSSProperties } from 'react'
import { input, mono, type ControlSize } from '../lib/controls'
import {
  draftProblem,
  fieldEvent,
  fieldKey,
  fieldText,
  leftWindowOnly,
  type FieldEvent,
  type FieldResult,
  type FieldState,
  type NumberRules
} from './numberDraft'

export interface NumberFieldProps {
  value: number | null
  /** Called once per finished edit, and only when the value changed. */
  onCommit: (value: number | null) => void
  min?: number
  max?: number
  /** arrow-key increment (default 1) */
  step?: number
  integer?: boolean
  /**
   * What an empty field means ("no cap", "auto"). Setting it is what allows
   * blank: clearing the field commits null and shows this as the placeholder.
   */
  allowBlank?: string
  size?: ControlSize
  width?: number
  disabled?: boolean
  id?: string
  'aria-label'?: string
  style?: CSSProperties
}

export function NumberField({
  value,
  onCommit,
  min,
  max,
  step = 1,
  integer = false,
  allowBlank,
  size = 'sm',
  width = 80,
  disabled = false,
  id,
  'aria-label': ariaLabel,
  style
}: NumberFieldProps): React.JSX.Element {
  const [state, setState] = useState<FieldState>({ draft: null, base: value })
  // Read by the handlers, so an Enter and the blur straight after it each see
  // the state the other left, whether or not React has rendered in between.
  const live = useRef(state)
  const rules: NumberRules = { min, max, integer, allowBlank: allowBlank != null }

  const dispatch = (ev: FieldEvent): FieldResult => {
    const r = fieldEvent(live.current, ev, rules)
    live.current = r.state
    setState(r.state)
    if (r.commit) onCommit(r.commit.value)
    return r
  }

  const problem = state.draft == null ? null : draftProblem(state.draft, rules)

  return (
    <input
      type="text"
      inputMode={integer ? 'numeric' : 'decimal'}
      id={id}
      aria-label={ariaLabel}
      aria-invalid={problem != null || undefined}
      title={problem ?? undefined}
      disabled={disabled}
      placeholder={allowBlank}
      value={fieldText(state, value)}
      onFocus={(e) => {
        if (dispatch({ type: 'focus', value }).select) e.currentTarget.select()
      }}
      onChange={(e) => dispatch({ type: 'change', text: e.target.value })}
      onBlur={(e) =>
        dispatch({ type: 'blur', windowOnly: leftWindowOnly(e.currentTarget, document) })
      }
      onKeyDown={(e) => {
        const ev = fieldKey(e.key, step)
        if (ev == null || live.current.draft == null) return
        e.preventDefault()
        dispatch(ev)
      }}
      style={{ ...input({ size, invalid: problem != null }), ...mono, width, ...style }}
    />
  )
}
