import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DestroyNodeButton, ReprovisionButton } from './NodeActions'

// The Fleet's destroy and reprovision ask before they act (audit D4, plan
// 1.15): each is a ConfirmButton, whose resting label sits in an aria-live
// span that a plain <button> never had. Clicking needs a DOM, which this
// renderer's tests do not have yet; ConfirmButton's own decision logic is
// tested in confirm.test.ts.

const noop = (): Promise<void> => Promise.resolve()

describe('DestroyNodeButton', () => {
  it('asks first', () => {
    const html = renderToStaticMarkup(
      <DestroyNodeButton node={{ state: 'rendering' }} onDestroy={noop} />
    )
    expect(html).toMatch(/^<button type="button"/)
    expect(html).toContain('<span aria-live="polite">destroy</span>')
    expect(html).not.toContain('disabled=""')
  })

  it('is disabled while a destroy is under way (#113)', () => {
    const html = renderToStaticMarkup(
      <DestroyNodeButton node={{ state: 'destroying' }} onDestroy={noop} />
    )
    expect(html).toContain('disabled=""')
  })
})

describe('ReprovisionButton', () => {
  it('asks first, on a node that is up', () => {
    const html = renderToStaticMarkup(
      <ReprovisionButton node={{ state: 'idle', sshHost: '1.2.3.4' }} onReprovision={noop} />
    )
    expect(html).toContain('<span aria-live="polite">reprovision</span>')
    expect(html).not.toContain('disabled=""')
  })

  it('says what the requeue costs: a machine failure for each chunk, not a render retry', () => {
    // scheduler.forgetNode charges each requeued chunk an infrastructure
    // retry; the button used to let the user think it cost nothing, and a
    // chunk already out of those fails for good when it is pressed.
    const html = renderToStaticMarkup(
      <ReprovisionButton node={{ state: 'rendering', sshHost: '1.2.3.4' }} onReprovision={noop} />
    )
    expect(html).toMatch(/title="[^"]*allowance for machine failures, not its render retries/)
  })

  it('is disabled on a node main would refuse', () => {
    for (const node of [
      { state: 'provisioning' as const, sshHost: '1.2.3.4' },
      { state: 'ready' as const, sshHost: null }
    ]) {
      const html = renderToStaticMarkup(<ReprovisionButton node={node} onReprovision={noop} />)
      expect(html, node.state).toContain('disabled=""')
    }
  })
})
