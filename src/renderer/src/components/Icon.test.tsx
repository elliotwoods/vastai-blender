import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Icon, ICON_NAMES } from './Icon'

// Every name in the set draws something: an <svg> with at least one shape in
// it, so a typo'd or emptied entry shows up here rather than as a blank button.
describe('Icon', () => {
  it.each(ICON_NAMES)('%s renders an svg with children', (name) => {
    const html = renderToStaticMarkup(<Icon name={name} />)
    expect(html).toMatch(/^<svg[^>]*viewBox="0 0 24 24"/)
    expect(html).toMatch(/<(path|circle|rect|ellipse)\b/)
  })

  it('includes the transport and action icons', () => {
    for (const n of [
      'trash',
      'grip',
      'link',
      'unlink',
      'play',
      'pause',
      'skipStart',
      'skipEnd',
      'rewind',
      'fastForward',
      'autoscroll',
      'expand',
      'gauge',
      'eye'
    ])
      expect(ICON_NAMES).toContain(n)
  })
})
