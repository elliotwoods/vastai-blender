/**
 * The rules behind NumberField, pure so they can be tested without a DOM.
 *
 * Settings used to persist every keystroke of a `type="number"` input
 * (audit C4, plan 1.14). Clearing the spend cap on the way to typing a new
 * one saved `null` — uncapped — and an unparseable entry reads as '' from
 * such an input, so a typo could do the same. Here the draft is raw text,
 * judged only when the user is done with it, and blank is refused unless
 * the field says what blank means.
 */

export interface NumberRules {
  min?: number
  max?: number
  /** round to a whole number on commit (node counts, pixel widths) */
  integer?: boolean
  /** blank commits null; otherwise a cleared field puts the last value back */
  allowBlank?: boolean
}

/** What finishing an edit does: commit a new value, or show `text` and keep the old. */
export type DraftOutcome =
  { kind: 'commit'; value: number | null; text: string } | { kind: 'keep'; text: string }

/** Plain decimals only: no exponent, hex, Infinity or thousands separators. */
const NUMERIC = /^[+-]?(\d+(\.\d*)?|\.\d+)$/

/** '' for blank, NaN for anything that isn't a plain number. */
export function parseDraft(text: string): number | '' {
  const t = text.trim()
  if (t === '') return ''
  return NUMERIC.test(t) ? Number(t) : NaN
}

export function formatValue(v: number | null): string {
  return v == null ? '' : String(v)
}

function clampRound(v: number, rules: NumberRules): number {
  let out = rules.integer ? Math.round(v) : v
  if (rules.min != null) out = Math.max(rules.min, out)
  if (rules.max != null) out = Math.min(rules.max, out)
  // -0 would print as "0" but compare unequal in a settings diff.
  return out === 0 ? 0 : out
}

/**
 * Judge a finished draft against the value it would replace. Out-of-range
 * numbers are clamped rather than refused: the user asked for "as much as
 * allowed", and the field shows what they got. Anything unparseable, or a
 * blank the field doesn't allow, puts `current` back. An unchanged value is
 * not a commit, so tabbing through a form writes nothing.
 */
export function resolveDraft(
  draft: string,
  current: number | null,
  rules: NumberRules = {}
): DraftOutcome {
  const parsed = parseDraft(draft)
  if (parsed === '') {
    if (!rules.allowBlank || current == null) return { kind: 'keep', text: formatValue(current) }
    return { kind: 'commit', value: null, text: '' }
  }
  if (Number.isNaN(parsed)) return { kind: 'keep', text: formatValue(current) }
  const value = clampRound(parsed, rules)
  if (value === current) return { kind: 'keep', text: formatValue(value) }
  return { kind: 'commit', value, text: formatValue(value) }
}

/**
 * Why a draft would not commit as typed, for the field's invalid state while
 * editing — or null when it would. A clamped value is flagged too, so the
 * user sees the range before the field quietly changes their number.
 */
export function draftProblem(draft: string, rules: NumberRules = {}): string | null {
  const parsed = parseDraft(draft)
  if (parsed === '') return rules.allowBlank ? null : 'required'
  if (Number.isNaN(parsed)) return 'not a number'
  if (rules.min != null && parsed < rules.min) return `at least ${rules.min}`
  if (rules.max != null && parsed > rules.max) return `at most ${rules.max}`
  return null
}

/**
 * Arrow-key nudge of the draft (not a commit — that still waits for Enter or
 * blur). Starts from the typed number, else the current value, else `min`,
 * else 0, and rounds to the step's decimals so 0.1 + 0.2 shows as 0.3.
 */
export function stepDraft(
  draft: string,
  dir: 1 | -1,
  step: number,
  current: number | null,
  rules: NumberRules = {}
): string {
  const parsed = parseDraft(draft)
  const from =
    typeof parsed === 'number' && !Number.isNaN(parsed) ? parsed : (current ?? rules.min ?? 0)
  const decimals = (String(step).split('.')[1] ?? '').length
  const next = Number((from + dir * step).toFixed(decimals))
  return formatValue(clampRound(next, rules))
}
