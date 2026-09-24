/**
 * The rules behind NumberField, pure so they can be tested without a DOM.
 *
 * Settings used to persist every keystroke of a `type="number"` input
 * (audit C4, plan 1.14). Clearing the spend cap on the way to typing a new
 * one saved `null` — uncapped — and an unparseable entry reads as '' from
 * such an input, so a typo could do the same. Here the draft is raw text,
 * judged only when the user is done with it, and blank is refused unless
 * the field says what blank means. fieldEvent() is the component's whole
 * behaviour as transitions; NumberField only binds DOM events to it.
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

/** NumberField's editing state, between events. */
export interface FieldState {
  /** null = not editing: the field shows its `value`. A string = the user's draft. */
  draft: string | null
  /**
   * The value this edit started from, moved on by an Enter commit, so a blur
   * straight after Enter doesn't commit the same number a second time while
   * the parent's `value` is still catching up.
   */
  base: number | null
}

export type FieldEvent =
  /** focus arrived; `value` is the field's prop at that moment */
  | { type: 'focus'; value: number | null }
  | { type: 'change'; text: string }
  /**
   * Focus left. `windowOnly`: the window lost focus (alt-tab, a click in
   * another app) while the field stayed the page's focused element — see
   * leftWindowOnly().
   */
  | { type: 'blur'; windowOnly: boolean }
  | { type: 'enter' }
  | { type: 'escape' }
  | { type: 'step'; dir: 1 | -1; step: number }

export interface FieldResult {
  state: FieldState
  /** Present when this event finished an edit with a new value: call onCommit once. */
  commit?: { value: number | null }
  /** a fresh edit: select the text so typing replaces it */
  select?: boolean
}

/**
 * Everything NumberField does with an event, pure so the transitions that
 * guard the spend cap are tested without a DOM. The component only binds
 * DOM events to this and calls onCommit when a result carries `commit`.
 *
 * Only leaving the field inside the app finishes an edit. Chromium blurs the
 * focused element when the whole window loses focus, so without that
 * distinction a user who clears the spend cap on the way to a new one, then
 * alt-tabs to check Vast prices, has committed "no cap" — and the scheduler
 * may rent at any price until they come back (review of plan 1.14, #112).
 * Window focus returning re-focuses the field; the kept draft and the value
 * it started from survive that too.
 */
export function fieldEvent(
  state: FieldState,
  ev: FieldEvent,
  rules: NumberRules = {}
): FieldResult {
  switch (ev.type) {
    case 'focus':
      // Back from another window, mid-edit: keep going where they left off.
      if (state.draft != null) return { state }
      return { state: { draft: formatValue(ev.value), base: ev.value }, select: true }
    case 'change':
      return { state: { ...state, draft: ev.text } }
    case 'blur': {
      if (ev.windowOnly || state.draft == null) return { state }
      const r = resolveDraft(state.draft, state.base, rules)
      return r.kind === 'commit'
        ? { state: { draft: null, base: r.value }, commit: { value: r.value } }
        : { state: { ...state, draft: null } }
    }
    case 'enter': {
      if (state.draft == null) return { state }
      const r = resolveDraft(state.draft, state.base, rules)
      return r.kind === 'commit'
        ? { state: { draft: r.text, base: r.value }, commit: { value: r.value } }
        : { state: { ...state, draft: r.text } }
    }
    case 'escape':
      if (state.draft == null) return { state }
      return { state: { ...state, draft: formatValue(state.base) } }
    case 'step':
      if (state.draft == null) return { state }
      return {
        state: { ...state, draft: stepDraft(state.draft, ev.dir, ev.step, state.base, rules) }
      }
  }
}

/** The keys NumberField handles while editing, as events; null = not its key. */
export function fieldKey(key: string, step: number): FieldEvent | null {
  if (key === 'Enter') return { type: 'enter' }
  if (key === 'Escape') return { type: 'escape' }
  if (key === 'ArrowUp') return { type: 'step', dir: 1, step }
  if (key === 'ArrowDown') return { type: 'step', dir: -1, step }
  return null
}

/**
 * What the field shows: the draft while editing, else the value — so a
 * background refetch of `value` never overwrites what the user is typing.
 */
export function fieldText(state: FieldState, value: number | null): string {
  return state.draft ?? formatValue(value)
}

/**
 * Whether a blur is the window losing focus rather than the user leaving
 * the field. Chromium blurs the focused element on window deactivation but
 * leaves it `document.activeElement`, and the document no longer has focus;
 * moving focus within the page clears activeElement to <body> for the blur.
 */
export function leftWindowOnly(
  target: unknown,
  doc: { activeElement: unknown; hasFocus(): boolean }
): boolean {
  return doc.activeElement === target || !doc.hasFocus()
}
