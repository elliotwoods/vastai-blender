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

describe('ConfirmButton with an icon', () => {
  it('rests as a square icon button named by its label', () => {
    const html = renderToStaticMarkup(
      <ConfirmButton label="cancel job" icon="trash" iconOnly onConfirm={() => {}} />
    )
    expect(html).toContain('aria-label="cancel job"')
    expect(html).toContain('title="cancel job"')
    expect(html).toContain('<svg')
    expect(html).toContain('width:26px')
    // the name is the aria-label; the live region is empty until armed
    expect(html).toContain('<span aria-live="polite"></span>')
  })

  it('keeps a given tooltip', () => {
    const html = renderToStaticMarkup(
      <ConfirmButton
        label="remove"
        icon="trash"
        iconOnly
        title="Remove from the list; the files are kept"
        onConfirm={() => {}}
      />
    )
    expect(html).toContain('title="Remove from the list; the files are kept"')
    expect(html).toContain('aria-label="remove"')
  })

  it('puts the icon before the label when not icon-only', () => {
    const html = renderToStaticMarkup(
      <ConfirmButton label="destroy" icon="trash" onConfirm={() => {}} />
    )
    expect(html).not.toContain('aria-label')
    expect(html).toMatch(/<svg[^]*<\/svg><span aria-live="polite">destroy<\/span>/)
  })
})
