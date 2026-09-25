import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SettingsPublic } from '../../../../shared/models'

// The preload bridge does not exist outside Electron.
vi.mock('../../lib/ipc', () => ({ ipc: { invoke: vi.fn(), on: vi.fn(() => () => {}) } }))

const { SpendCapRow } = await import('./SettingsScreen')

// Plan 1.14 (#99 #112): the spend cap was a `type="number"` field whose
// blank meant "no cap", saved on every keystroke. Backspacing it to retype
// the figure turned the cap off.

function row(cap: Pick<SettingsPublic, 'spendCapPerHour' | 'noSpendCap'>): string {
  return renderToStaticMarkup(
    <SpendCapRow settings={{ ...cap } as SettingsPublic} save={() => {}} />
  )
}

/** The spend cap's input element, as markup. */
function capInput(html: string): string {
  return /<input[^>]*aria-label="Spend cap in dollars per hour"[^>]*>/.exec(html)?.[0] ?? ''
}

function noCapBox(html: string): string {
  return /<input type="checkbox"[^>]*>/.exec(html)?.[0] ?? ''
}

describe('the spend cap row', () => {
  it('with a cap: the figure has no blank to clear it to, and "no spend cap" is unticked', () => {
    const html = row({ spendCapPerHour: 2, noSpendCap: false })
    expect(capInput(html)).toContain('value="2"')
    // No placeholder: NumberField without allowBlank puts the cap back when
    // cleared, rather than committing null.
    expect(capInput(html)).not.toContain('placeholder')
    expect(capInput(html)).not.toContain('disabled')
    expect(noCapBox(html)).not.toContain('checked')
  })

  it('with no cap: "no spend cap" is ticked, and the figure reads "no cap"', () => {
    const html = row({ spendCapPerHour: null, noSpendCap: true })
    expect(capInput(html)).toContain('placeholder="no cap"')
    expect(capInput(html)).toContain('disabled')
    expect(noCapBox(html)).toContain('checked')
  })

  it('a blank cap with no flag (a file from before it) says scale-up rents nothing', () => {
    const html = row({ spendCapPerHour: null })
    expect(html).toContain('No spend cap is set, so scale-up rents nothing')
    expect(noCapBox(html)).not.toContain('checked')
  })
})
