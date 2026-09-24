import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Sparkline, type SparklineProps } from './Sparkline'

const base: Omit<SparklineProps, 'points'> = {
  fromMs: 0,
  toMs: 400,
  yMax: 100,
  width: 80,
  height: 20,
  label: 'GPU util',
  format: (v) => `${v.toFixed(0)}%`
}

const render = (points: SparklineProps['points'], p: Partial<SparklineProps> = {}): string =>
  renderToStaticMarkup(<Sparkline {...base} {...p} points={points} />)

const ys = (html: string, tag: 'polyline' | 'polygon'): number[][] =>
  [...html.matchAll(new RegExp(`<${tag}[^>]*points="([^"]*)"`, 'g'))].map((m) =>
    m[1].split(' ').map((pt) => Number(pt.split(',')[1]))
  )

describe('Sparkline', () => {
  it('draws the mean over a faint min–max band, with no axes or labels', () => {
    const html = render([
      { x: 0, mean: 50, min: 10, max: 90 },
      { x: 100, mean: 60, min: 20, max: 100 }
    ])
    expect(ys(html, 'polyline')).toHaveLength(1)
    expect(ys(html, 'polygon')).toHaveLength(1)
    expect(html).toMatch(/<polygon[^>]*fill-opacity:0\.18/)
    expect(html).not.toContain('<text')
  })

  it('keeps a fixed range, so a half-busy node sits at half height in every row', () => {
    // 1.5px inset each side of a 20px box: 50% lands at the middle, 10.
    const html = render([
      { x: 0, mean: 50 },
      { x: 100, mean: 50 }
    ])
    expect(ys(html, 'polyline')).toEqual([[10, 10]])
  })

  it('pins a reading outside the range to the edge instead of drawing outside the box', () => {
    const html = render([
      { x: 0, mean: 140 },
      { x: 100, mean: -5 }
    ])
    expect(ys(html, 'polyline')).toEqual([[1.5, 18.5]])
  })

  it('breaks at a gap rather than reading an unreachable node as idle', () => {
    const html = render([
      { x: 0, mean: 80 },
      { x: 100, mean: 90 },
      { x: 200, mean: null },
      { x: 300, mean: 85 },
      { x: 400, mean: 70 }
    ])
    expect(ys(html, 'polyline')).toHaveLength(2)
  })

  it('shows a lone reading as a dot', () => {
    const html = render([{ x: 100, mean: 30 }])
    expect(html).toMatch(/<circle[^>]*r="1.5"/)
    expect(html).not.toContain('<polyline')
  })

  it('names itself for a screen reader with the window’s mean, low and high', () => {
    const html = render([
      { x: 0, mean: 40, min: 0, max: 100 },
      { x: 100, mean: 60, min: 30, max: 90 }
    ])
    expect(html).toContain('aria-label="GPU util: mean 50%, low 0%, high 100%"')
  })

  it('says so when there is nothing to show', () => {
    const html = render([{ x: 0, mean: null }])
    expect(html).toContain('aria-label="GPU util: no readings"')
    expect(html).not.toContain('<polyline')
  })
})
