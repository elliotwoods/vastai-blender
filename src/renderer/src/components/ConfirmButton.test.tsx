import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ConfirmButton } from './ConfirmButton'

describe('ConfirmButton', () => {
  it('rests as a plain button with its own label, not a submit', () => {
    const html = renderToStaticMarkup(<ConfirmButton label="destroy" onConfirm={() => {}} />)
    expect(html).toMatch(/^<button type="button"/)
    expect(html).toContain('<span aria-live="polite">destroy</span>')
    expect(html).not.toContain('confirm')
  })

  it('stays disabled when told to', () => {
    const html = renderToStaticMarkup(
      <ConfirmButton label="cancel" disabled onConfirm={() => {}} />
    )
    expect(html).toContain('disabled=""')
  })
})
