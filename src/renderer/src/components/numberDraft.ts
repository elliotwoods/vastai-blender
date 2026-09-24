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

/** Integer fields round; -0 would print as "0" but compare unequal in a settings diff. */
function roundTo(v: number, rules: NumberRules): number {
  const out = rules.integer ? Math.round(v) : v
  return out === 0 ? 0 : out
}

function clampRound(v: number, rules: NumberRules): number {
  let out = roundTo(v, rules)
  if (rules.min != null) out = Math.max(rules.min, out)
  if (rules.max != null) out = Math.min(rules.max, out)
  return out === 0 ? 0 : out
}

function rangeProblem(v: number, rules: NumberRules): string | null {
  if (rules.min != null && v < rules.min) return `at least ${rules.min}`
  if (rules.max != null && v > rules.max) return `at most ${rules.max}`
  return null
}

/**
 * Judge a finished draft against the value it would replace. Anything
 * unparseable, a blank the field doesn't allow, or a number outside the
 * range puts `current` back. Out of range is refused rather than clamped:
 * "100" typed for "10" into max active nodes must not commit as 64, the
 * most the field allows, and "12" on the way to "1280" must not save 256.
 *
 * A draft that still reads as `current` is not a commit, checked before any
 * rounding or range test, so tabbing through a form writes nothing, even
 * past a stored value this field would no longer accept.
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
  if (Number.isNaN(parsed) || parsed === current) {
    return { kind: 'keep', text: formatValue(current) }
  }
  const value = roundTo(parsed, rules)
  if (value === current || rangeProblem(value, rules)) {
    return { kind: 'keep', text: formatValue(current) }
  }
  return { kind: 'commit', value, text: formatValue(value) }
}

/**
 * Why a draft would not commit as typed, for the field's invalid state while
 * editing, or null when it would. The range is judged as resolveDraft judges
 * it, after an integer field's rounding.
 */
export function draftProblem(draft: string, rules: NumberRules = {}): string | null {
  const parsed = parseDraft(draft)
  if (parsed === '') return rules.allowBlank ? null : 'required'
  if (Number.isNaN(parsed)) return 'not a number'
  return rangeProblem(roundTo(parsed, rules), rules)
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

/** fieldEvent()'s rules: the number's, plus what a window-only blur may commit. */
export interface FieldRules extends NumberRules {
  /**
   * Commit a finished number when the window loses focus mid-edit, not only
   * when the user leaves the field. For limits where a smaller number is the
   * safe direction (the spend cap, max active nodes, a max $/hr filter): a
   * cap typed and left behind by an alt-tab, a locked screen or a night away
   * must be in force, and a half-typed one ("5" on the way to "50") is only
   * tighter. Not for lower bounds such as minDiskGb or minReliability, where
   * the half-typed number ("0." on the way to "0.95") is the loose one.
   * A blank ("no cap") never commits this way, whatever this says.
   */
  commitOnWindowBlur?: boolean
}

/** NumberField's editing state, between events. */
export interface FieldState {
  /** null = not editing: the field shows its `value`. A string = the user's draft. */
  draft: string | null
  /**
   * The value this edit started from, moved on by a commit, so a blur
   * straight after Enter doesn't commit the same number a second time while
   * the parent's `value` is still catching up.
   */
  base: number | null
  /**
   * A window-only blur found a change in the draft and did not commit it.
   * The field says "not saved" for as long as the draft still differs from
   * `base` (notSaved()); leaving the field, Enter or Escape clears it.
   */
  held?: true
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
  /**
   * The key did something here (Escape reverted a draft): keep it from a
   * parent's shortcut, so the same Escape doesn't also close a dialog.
   */
  stop?: boolean
}

/**
 * Everything NumberField does with an event, pure so the transitions that
 * guard the spend cap are tested without a DOM. The component only binds
 * DOM events to this and calls onCommit when a result carries `commit`.
 *
 * Leaving the field inside the app, or Enter, finishes an edit. Chromium
 * also blurs the focused element when the whole window loses focus, and
 * that blur is not the user done: one who clears the spend cap on the way
 * to a new one, then alt-tabs to check Vast prices, must not have committed
 * "no cap" — the scheduler would rent at any price until they came back
 * (review of plan 1.14, #112). So a window-only blur never commits a blank.
 * It commits a finished number only under `commitOnWindowBlur`, the fields
 * where holding it back is the harm: a cap typed and alt-tabbed away from
 * would otherwise sit out of force for as long as the user is gone. Any
 * change it holds is marked `held`, so the field shows it is not saved.
 *
 * The draft text itself survives a window-only blur untouched ("2." stays
 * "2.", not "2"), and window focus returning re-focuses the field without
 * resetting it, so the user carries on typing where they left off.
 */
export function fieldEvent(state: FieldState, ev: FieldEvent, rules: FieldRules = {}): FieldResult {
  switch (ev.type) {
    case 'focus':
      // Back from another window, mid-edit: keep going where they left off.
      if (state.draft != null) return { state }
      return { state: { draft: formatValue(ev.value), base: ev.value }, select: true }
    case 'change':
      return { state: { ...state, draft: ev.text } }
    case 'blur': {
      if (state.draft == null) return { state }
      const r = resolveDraft(state.draft, state.base, rules)
      if (ev.windowOnly) {
        // Still the page's focused element: the edit goes on when the window
        // comes back. A typo or out-of-range draft is already flagged, and
        // an unchanged one has nothing to say.
        if (r.kind === 'keep') return { state }
        if (r.value != null && rules.commitOnWindowBlur) {
          return { state: { draft: state.draft, base: r.value }, commit: { value: r.value } }
        }
        return { state: { draft: state.draft, base: state.base, held: true } }
      }
      return r.kind === 'commit'
        ? { state: { draft: null, base: r.value }, commit: { value: r.value } }
        : { state: { draft: null, base: state.base } }
    }
    case 'enter': {
      if (state.draft == null) return { state }
      const r = resolveDraft(state.draft, state.base, rules)
      return r.kind === 'commit'
        ? { state: { draft: r.text, base: r.value }, commit: { value: r.value } }
        : { state: { draft: r.text, base: state.base } }
    }
    case 'escape': {
      if (state.draft == null) return { state }
      const back = formatValue(state.base)
      return { state: { draft: back, base: state.base }, stop: state.draft !== back || undefined }
    }
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
 * Whether the field should say its draft is not saved: a window-only blur
 * held it back, and it still differs from the stored value. The user may
 * have left for the night thinking the number they typed applies; this is
 * the only sign that it doesn't until they press Enter or click away.
 */
export function notSaved(state: FieldState, rules: NumberRules = {}): boolean {
  return (
    state.held === true &&
    state.draft != null &&
    resolveDraft(state.draft, state.base, rules).kind === 'commit'
  )
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
