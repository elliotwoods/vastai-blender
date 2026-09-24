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
 * of `value` does not overwrite what they are typing.
 */

import { useRef, useState, type CSSProperties } from 'react'
import { input, mono, type ControlSize } from '../lib/controls'
import { draftProblem, formatValue, resolveDraft, stepDraft, type NumberRules } from './numberDraft'

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
  // null = not editing: the field shows `value`. A string = the user's draft.
  const [draft, setDraft] = useState<string | null>(null)
  // The value this edit started from, moved on by an Enter commit, so a blur
  // straight after Enter doesn't commit the same number a second time while
  // the parent's `value` is still catching up.
  const base = useRef<number | null>(value)
  const rules: NumberRules = { min, max, integer, allowBlank: allowBlank != null }

  const finish = (text: string): string => {
    const r = resolveDraft(text, base.current, rules)
    if (r.kind === 'commit') {
      base.current = r.value
      onCommit(r.value)
    }
    return r.text
  }

  const problem = draft == null ? null : draftProblem(draft, rules)

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
      value={draft ?? formatValue(value)}
      onFocus={(e) => {
        base.current = value
        setDraft(formatValue(value))
        e.currentTarget.select()
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft != null) finish(draft)
        setDraft(null)
      }}
      onKeyDown={(e) => {
        if (draft == null) return
        if (e.key === 'Enter') {
          e.preventDefault()
          setDraft(finish(draft))
        } else if (e.key === 'Escape') {
          e.preventDefault()
          setDraft(formatValue(base.current))
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault()
          setDraft(stepDraft(draft, e.key === 'ArrowUp' ? 1 : -1, step, base.current, rules))
        }
      }}
      style={{ ...input({ size, invalid: problem != null }), ...mono, width, ...style }}
    />
  )
}
