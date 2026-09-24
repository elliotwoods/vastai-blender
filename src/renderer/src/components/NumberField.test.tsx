import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { NumberField } from './NumberField'

describe('NumberField', () => {
  it('is a text field, so a typo and a blank stay distinguishable', () => {
    const html = renderToStaticMarkup(<NumberField value={2.5} onCommit={() => {}} />)
    expect(html).toContain('type="text"')
    expect(html).toContain('inputMode="decimal"')
    expect(html).toContain('value="2.5"')
  })

  it('shows what blank means where blank is allowed', () => {
    const html = renderToStaticMarkup(
      <NumberField value={null} allowBlank="no cap" onCommit={() => {}} />
    )
    expect(html).toContain('placeholder="no cap"')
    expect(html).toContain('value=""')
  })

  it('offers a numeric keypad for whole numbers', () => {
    const html = renderToStaticMarkup(<NumberField value={4} integer onCommit={() => {}} />)
    expect(html).toContain('inputMode="numeric"')
  })
})
