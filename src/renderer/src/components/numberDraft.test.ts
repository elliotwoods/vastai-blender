import { describe, expect, it } from 'vitest'
import { draftProblem, parseDraft, resolveDraft, stepDraft } from './numberDraft'

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

  it('clamps to the range and says what it kept', () => {
    expect(resolveDraft('99', 4, { min: 0, max: 64 })).toEqual({
      kind: 'commit',
      value: 64,
      text: '64'
    })
    expect(resolveDraft('-3', 4, { min: 0, max: 64 })).toEqual({
      kind: 'commit',
      value: 0,
      text: '0'
    })
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
