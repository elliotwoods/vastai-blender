import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ProgressSegment } from './progressSegments'

// Server rendering never measures; give the bar a width for its ticks.
vi.mock('./charts/useWidth', () => ({ useWidth: () => 300 }))
const { ProgressBar } = await import('./ProgressBar')

const count = (html: string, needle: string): number => html.split(needle).length - 1

describe('ProgressBar', () => {
  it('is a progressbar with its numbers for assistive tech', () => {
    const html = renderToStaticMarkup(
      <ProgressBar total={240} done={60} cancelled={20} state="cancelled" label="frames of shot" />
    )
    expect(html).toContain('role="progressbar"')
    expect(html).toContain('aria-label="frames of shot"')
    expect(html).toContain('aria-valuemin="0"')
    expect(html).toContain('aria-valuemax="240"')
    expect(html).toContain('aria-valuenow="60"')
    expect(html).toContain('aria-valuetext="60 of 240 done, 20 cancelled"')
  })

  it('queued: the track alone', () => {
    const html = renderToStaticMarkup(<ProgressBar total={100} done={0} state="queued" />)
    expect(html).toContain('data-state="queued"')
    expect(html).not.toContain('data-part')
  })

  it('active: accent fill with the moving stripe', () => {
    const html = renderToStaticMarkup(<ProgressBar total={100} done={25} state="active" />)
    expect(html).toContain('class="vr-progress-live"')
    expect(html).toContain('background-color:var(--accent)')
    expect(html).toContain('width:25%')
  })

  it('complete: solid done colour, still', () => {
    const html = renderToStaticMarkup(<ProgressBar total={100} done={100} state="complete" />)
    expect(html).toContain('background-color:var(--status-done-fill)')
    expect(html).not.toContain('vr-progress-live')
    expect(html).toContain('width:100%')
  })

  it('failed: the failed frames in the error colour after the done ones', () => {
    const html = renderToStaticMarkup(
      <ProgressBar total={100} done={40} failed={10} state="failed" />
    )
    expect(html).toContain('data-part="failed"')
    expect(html).toContain('background-color:var(--status-error-fill)')
    expect(html).toMatch(/data-part="failed"[^>]*left:40%;width:10%/)
  })

  it('cancelled: what the cancel stopped is hatched grey', () => {
    const html = renderToStaticMarkup(
      <ProgressBar total={100} done={30} cancelled={70} state="cancelled" />
    )
    expect(html).toMatch(/class="vr-progress-hatch" data-part="cancelled"[^>]*left:30%;width:70%/)
    expect(html).not.toContain('vr-progress-live')
  })

  it('held: amber, no stripe', () => {
    const html = renderToStaticMarkup(<ProgressBar total={100} done={30} state="held" />)
    expect(html).toContain('background-color:var(--warn)')
    expect(html).not.toContain('vr-progress-live')
  })

  it('draws chunks where they sit, the live one striped', () => {
    const segments: ProgressSegment[] = [
      { id: 'a', start: 0, frames: 50, done: 50, tone: 'done' },
      { id: 'b', start: 50, frames: 25, done: 10, tone: 'working' },
      { id: 'c', start: 75, frames: 25, done: 0, tone: 'failed' }
    ]
    const html = renderToStaticMarkup(
      <ProgressBar total={100} done={60} state="active" segments={segments} />
    )
    expect(count(html, 'data-part="done"')).toBe(2)
    expect(count(html, 'vr-progress-live')).toBe(1)
    expect(html).toMatch(/class="vr-progress-live"[^>]*left:50%;width:10%/)
    expect(html).toMatch(/data-part="working"[^>]*left:60%;width:15%/)
    expect(html).toMatch(/data-part="failed"[^>]*left:75%;width:25%/)
  })

  it('ticks each frame with 3 px to spare, each chunk otherwise, none when not asked', () => {
    const frames = renderToStaticMarkup(<ProgressBar total={100} done={0} state="queued" ticks />)
    expect(frames).toContain('data-ticks="frames"')
    expect(frames).toContain('background-size:1% 100%')

    const segments: ProgressSegment[] = [0, 1, 2, 3].map((i) => ({
      id: `c${i}`,
      start: i * 250,
      frames: 250,
      done: 0,
      tone: 'queued'
    }))
    const chunks = renderToStaticMarkup(
      <ProgressBar total={1000} done={0} state="queued" segments={segments} ticks />
    )
    expect(count(chunks, 'data-ticks="chunks"')).toBe(3)

    expect(renderToStaticMarkup(<ProgressBar total={100} done={0} state="queued" />)).not.toContain(
      'data-ticks'
    )
  })

  it('has no pulse on its first render', () => {
    const html = renderToStaticMarkup(<ProgressBar total={100} done={50} state="active" />)
    expect(html).not.toContain('vr-progress-pulse')
  })
})
