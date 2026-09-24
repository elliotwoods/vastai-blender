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
 * field puts the last value back. A number outside min..max is flagged while
 * typing and refused, not clamped, on commit: a slip must never become the
 * field's maximum.
 *
 * While the field has focus, the draft is the user's: a background refetch
 * of `value` does not overwrite what they are typing. Switching to another
 * app mid-edit is not finishing it: a blank never commits that way, so
 * clearing the spend cap on the way to a new one and alt-tabbing does not
 * uncap the scheduler. A finished number does commit then on a cap field
 * (`commitOnWindowBlur`), so a cap typed before leaving is in force while
 * the user is gone. Any change held back shows as "not saved", with a warn
 * border, until the user presses Enter or clicks away.
 *
 * The behaviour lives in numberDraft's fieldEvent(), with tests; this file
 * only binds DOM events to it.
 */

import { useRef, useState, type CSSProperties } from 'react'
import { input, mono, type ControlSize } from '../lib/controls'
import { TOKENS } from '../lib/theme'
import {
  draftProblem,
  fieldEvent,
  fieldKey,
  fieldText,
  leftWindowOnly,
  notSaved,
  type FieldEvent,
  type FieldResult,
  type FieldRules,
  type FieldState
} from './numberDraft'

const NOT_SAVED = 'not saved: press Enter or click away'

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
  /**
   * Commit a finished number when the user switches apps mid-edit, not only
   * when they leave the field. Set it on caps, where a smaller number only
   * stops renting (spendCapPerHour, maxActiveNodes, maxDphTotal); leave it
   * off lower bounds (minDiskGb, minReliability), where "0." on the way to
   * "0.95" is the loose value. See FieldRules.commitOnWindowBlur.
   */
  commitOnWindowBlur?: boolean
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
  commitOnWindowBlur = false,
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
  const rules: FieldRules = {
    min,
    max,
    integer,
    allowBlank: allowBlank != null,
    commitOnWindowBlur
  }

  const dispatch = (ev: FieldEvent): FieldResult => {
    const r = fieldEvent(live.current, ev, rules)
    live.current = r.state
    setState(r.state)
    if (r.commit) onCommit(r.commit.value)
    return r
  }

  const problem = state.draft == null ? null : draftProblem(state.draft, rules)
  const unsaved = problem == null && notSaved(state, rules)

  return (
    <input
      type="text"
      inputMode={integer ? 'numeric' : 'decimal'}
      id={id}
      aria-label={ariaLabel}
      aria-invalid={problem != null || undefined}
      aria-description={unsaved ? NOT_SAVED : undefined}
      title={problem ?? (unsaved ? NOT_SAVED : undefined)}
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
        if (dispatch(ev).stop) e.stopPropagation()
      }}
      style={{
        ...input({ size, invalid: problem != null }),
        ...(unsaved ? { border: `1px solid ${TOKENS.warn}` } : {}),
        ...mono,
        width,
        ...style
      }}
    />
  )
}
