import { describe, expect, it } from 'vitest'
import {
  draftProblem,
  fieldEvent,
  fieldKey,
  fieldText,
  leftWindowOnly,
  parseDraft,
  resolveDraft,
  stepDraft,
  type FieldEvent,
  type FieldState,
  type NumberRules
} from './numberDraft'

describe('parseDraft', () => {
  it('reads plain decimals', () => {
    expect(parseDraft(' 2.5 ')).toBe(2.5)
    expect(parseDraft('.5')).toBe(0.5)
    expect(parseDraft('3.')).toBe(3)
    expect(parseDraft('-1')).toBe(-1)
  })

  it('tells a blank from a typo — the distinction type="number" loses', () => {
    expect(parseDraft('')).toBe('')
    expect(parseDraft('   ')).toBe('')
    for (const typo of ['1e', 'abc', '-', '.', '1e3', '0x10', 'Infinity', '1,000', '2..5']) {
      expect(parseDraft(typo), typo).toBeNaN()
    }
  })
})

describe('resolveDraft (plan 1.14)', () => {
  it('puts the last value back when a field that needs a number is cleared', () => {
    // Clearing the spend cap on the way to typing a new one used to save
    // null — uncapped — because every keystroke was persisted.
    expect(resolveDraft('', 2)).toEqual({ kind: 'keep', text: '2' })
  })

  it('commits null for a blank only where blank has a meaning', () => {
    expect(resolveDraft('', 2, { allowBlank: true })).toEqual({
      kind: 'commit',
      value: null,
      text: ''
    })
    // Already blank: nothing to write.
    expect(resolveDraft('', null, { allowBlank: true })).toEqual({ kind: 'keep', text: '' })
  })

  it('never turns a typo into a blank, even where blank is allowed', () => {
    expect(resolveDraft('1e', 2, { allowBlank: true })).toEqual({ kind: 'keep', text: '2' })
    expect(resolveDraft('abc', null, { allowBlank: true })).toEqual({ kind: 'keep', text: '' })
  })

  it('commits a changed number', () => {
    expect(resolveDraft('2.5', 2)).toEqual({ kind: 'commit', value: 2.5, text: '2.5' })
    expect(resolveDraft('3', null, { allowBlank: true })).toEqual({
      kind: 'commit',
      value: 3,
      text: '3'
    })
  })

  it('writes nothing when the value did not change, however it was typed', () => {
    expect(resolveDraft('2.0', 2)).toEqual({ kind: 'keep', text: '2' })
    expect(resolveDraft(' 2 ', 2)).toEqual({ kind: 'keep', text: '2' })
  })

  it('refuses a number outside the range rather than committing the nearest end', () => {
    // "100" typed for "10" into max active nodes must not rent up to 64.
    expect(resolveDraft('100', 4, { min: 0, max: 64 })).toEqual({ kind: 'keep', text: '4' })
    expect(resolveDraft('-3', 4, { min: 0, max: 64 })).toEqual({ kind: 'keep', text: '4' })
    // "12" on the way to "1280" must not save the minimum.
    expect(resolveDraft('12', 960, { min: 256, max: 3840 })).toEqual({
      kind: 'keep',
      text: '960'
    })
    // The ends themselves are in range.
    expect(resolveDraft('64', 4, { min: 0, max: 64 })).toEqual({
      kind: 'commit',
      value: 64,
      text: '64'
    })
  })

  it('writes nothing when tabbed past a stored value the field would not accept', () => {
    // Stored before the range existed, or written elsewhere: an untouched
    // draft is not the user asking for the clamped or rounded value.
    expect(resolveDraft('100', 100, { min: 0, max: 64 })).toEqual({ kind: 'keep', text: '100' })
    expect(resolveDraft('2.5', 2.5, { integer: true })).toEqual({ kind: 'keep', text: '2.5' })
  })

  it('rounds integer fields', () => {
    expect(resolveDraft('2.6', 1, { integer: true })).toEqual({
      kind: 'commit',
      value: 3,
      text: '3'
    })
  })

  it('never commits negative zero', () => {
    const r = resolveDraft('-0', 5)
    expect(r).toEqual({ kind: 'commit', value: 0, text: '0' })
    expect(Object.is(r.kind === 'commit' ? r.value : null, -0)).toBe(false)
  })
})

describe('draftProblem', () => {
  it('flags what would not commit as typed', () => {
    expect(draftProblem('')).toBe('required')
    expect(draftProblem('', { allowBlank: true })).toBeNull()
    expect(draftProblem('x')).toBe('not a number')
    expect(draftProblem('70', { max: 64 })).toBe('at most 64')
    expect(draftProblem('-1', { min: 0 })).toBe('at least 0')
    expect(draftProblem('12', { min: 0, max: 64 })).toBeNull()
  })

  it('judges the range after rounding, as the commit does', () => {
    expect(draftProblem('64.4', { integer: true, max: 64 })).toBeNull()
    expect(draftProblem('64.6', { integer: true, max: 64 })).toBe('at most 64')
    expect(resolveDraft('64.4', 4, { integer: true, max: 64 })).toEqual({
      kind: 'commit',
      value: 64,
      text: '64'
    })
    expect(resolveDraft('64.6', 4, { integer: true, max: 64 })).toEqual({
      kind: 'keep',
      text: '4'
    })
  })
})

describe('stepDraft', () => {
  it('steps the draft without float noise', () => {
    expect(stepDraft('0.2', 1, 0.1, null)).toBe('0.3')
    expect(stepDraft('1', -1, 0.1, null)).toBe('0.9')
  })

  it('starts from the value, then min, then zero when the draft is blank or a typo', () => {
    expect(stepDraft('', 1, 1, 4)).toBe('5')
    expect(stepDraft('abc', 1, 1, null, { min: 256 })).toBe('257')
    expect(stepDraft('', -1, 1, null)).toBe('-1')
  })

  it('stays in range', () => {
    expect(stepDraft('64', 1, 1, 64, { max: 64 })).toBe('64')
    expect(stepDraft('0', -1, 1, 0, { min: 0 })).toBe('0')
  })
})

/** Run events through fieldEvent from rest, collecting what onCommit would receive. */
function play(
  value: number | null,
  events: FieldEvent[],
  rules: NumberRules = {}
): { state: FieldState; commits: Array<number | null> } {
  let state: FieldState = { draft: null, base: value }
  const commits: Array<number | null> = []
  for (const ev of events) {
    const r = fieldEvent(state, ev, rules)
    state = r.state
    if (r.commit) commits.push(r.commit.value)
  }
  return { state, commits }
}

const focus = (value: number | null): FieldEvent => ({ type: 'focus', value })
const type = (text: string): FieldEvent => ({ type: 'change', text })
const leave: FieldEvent = { type: 'blur', windowOnly: false }
const switchApp: FieldEvent = { type: 'blur', windowOnly: true }
const noCap: NumberRules = { min: 0, allowBlank: true }

describe('fieldEvent (plan 1.14)', () => {
  it('never commits "no cap" when the window loses focus mid-edit (#112a)', () => {
    // Backspace the spend cap on the way to a new one, then alt-tab to the
    // browser to check Vast prices: that blur is the window's, not the
    // user leaving the field. Committing it would uncap the scheduler until
    // they came back.
    const away = play(2, [focus(2), type(''), switchApp], noCap)
    expect(away.commits).toEqual([])
    expect(away.state.draft).toBe('')

    // Coming back re-focuses the field: the draft, and what it started from,
    // are still theirs. Typing on and leaving commits only the new cap.
    const back = play(2, [focus(2), type(''), switchApp, focus(2), type('3'), leave], noCap)
    expect(back.commits).toEqual([3])
  })

  it('does not reset a kept draft when a refetch moved the value while the user was away', () => {
    const r = play(2, [focus(2), type('2.'), switchApp, focus(5)], noCap)
    expect(r.state).toEqual({ draft: '2.', base: 2 })
  })

  it('does commit a deliberate blank when the user leaves the field in the app', () => {
    expect(play(2, [focus(2), type(''), leave], noCap).commits).toEqual([null])
  })

  it('writes nothing per keystroke — only once, when the edit is done', () => {
    const r = play(2, [focus(2), type(''), type('2'), type('2.'), type('2.5')], noCap)
    expect(r.commits).toEqual([])
    expect(play(2, [focus(2), type('2'), type('2.'), type('2.5'), leave]).commits).toEqual([2.5])
  })

  it('commits once for Enter then the blur that follows it', () => {
    const r = play(2, [focus(2), type('4'), { type: 'enter' }, leave])
    expect(r.commits).toEqual([4])
    expect(r.state).toEqual({ draft: null, base: 4 })
  })

  it('selects the text only when an edit starts', () => {
    expect(fieldEvent({ draft: null, base: 2 }, focus(2)).select).toBe(true)
    expect(fieldEvent({ draft: '', base: 2 }, focus(2)).select).toBeUndefined()
  })

  it('writes nothing when tabbed through', () => {
    expect(play(2, [focus(2), leave]).commits).toEqual([])
  })

  it('puts the value this edit started from back on Escape, and commits nothing', () => {
    const r = play(2, [focus(2), type(''), { type: 'escape' }, leave], noCap)
    expect(r.commits).toEqual([])
  })

  it('steps the draft on arrows without committing', () => {
    const r = play(2, [focus(2), { type: 'step', dir: 1, step: 0.5 }], noCap)
    expect(r).toEqual({ state: { draft: '2.5', base: 2 }, commits: [] })
  })

  it('ignores keys and blurs that arrive while not editing', () => {
    for (const ev of [leave, switchApp, { type: 'enter' }, { type: 'escape' }] as FieldEvent[]) {
      expect(fieldEvent({ draft: null, base: 2 }, ev)).toEqual({
        state: { draft: null, base: 2 }
      })
    }
  })
})

describe('fieldKey', () => {
  it('maps the field’s own keys and leaves the rest alone', () => {
    expect(fieldKey('Enter', 1)).toEqual({ type: 'enter' })
    expect(fieldKey('Escape', 1)).toEqual({ type: 'escape' })
    expect(fieldKey('ArrowUp', 0.1)).toEqual({ type: 'step', dir: 1, step: 0.1 })
    expect(fieldKey('ArrowDown', 1)).toEqual({ type: 'step', dir: -1, step: 1 })
    expect(fieldKey('Tab', 1)).toBeNull()
    expect(fieldKey('a', 1)).toBeNull()
  })
})

describe('fieldText', () => {
  it('shows the draft over a refetched value while editing, the value otherwise', () => {
    expect(fieldText({ draft: '2.', base: 2 }, 3)).toBe('2.')
    expect(fieldText({ draft: '', base: 2 }, 2)).toBe('')
    expect(fieldText({ draft: null, base: 2 }, 3)).toBe('3')
    expect(fieldText({ draft: null, base: null }, null)).toBe('')
  })
})

describe('leftWindowOnly', () => {
  const field = {}
  const doc = (
    activeElement: unknown,
    hasFocus: boolean
  ): { activeElement: unknown; hasFocus: () => boolean } => ({
    activeElement,
    hasFocus: () => hasFocus
  })

  it('reads a blur that leaves the field focused as the window going away', () => {
    expect(leftWindowOnly(field, doc(field, false))).toBe(true)
    expect(leftWindowOnly(field, doc(field, true))).toBe(true)
  })

  it('reads a blur while the page has lost focus as the window going away', () => {
    expect(leftWindowOnly(field, doc({}, false))).toBe(true)
  })

  it('reads focus moving within the page as leaving the field', () => {
    expect(leftWindowOnly(field, doc({ tagName: 'BODY' }, true))).toBe(false)
  })
})
