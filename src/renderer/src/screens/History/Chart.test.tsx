import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Chart, type ChartProps } from './Chart'

// Server rendering never runs the ResizeObserver; give the chart a width.
vi.mock('../../components/charts/useWidth', () => ({ useWidth: () => 640 }))

// The plot runs from PAD.left (58) to width − PAD.right (640 − 14).
const PLOT_LEFT = 58
const PLOT_RIGHT = 626

const base: Omit<ChartProps, 'points' | 'kind'> = {
  fromMs: 0,
  toMs: 1000,
  format: (v) => `$${v.toFixed(2)}`,
  formatX: (ms) => String(ms),
  height: 220,
  emptyNote: 'no balance readings in this window'
}

/** x coordinates of every polyline vertex, per polyline. */
function polylineXs(html: string): number[][] {
  return [...html.matchAll(/<polyline[^>]*points="([^"]*)"/g)].map((m) =>
    m[1].split(' ').map((pt) => Number(pt.split(',')[0]))
  )
}

describe('History chart (#117)', () => {
  it('draws a quiet balance window, whose only point is the restamped anchor, across the window', () => {
    // balancePoints() restamps the last earlier reading to fromMs "so the step
    // line starts at the right height". With nothing else in the window that
    // anchor is the whole series — it was a one-vertex polyline, invisible.
    const html = renderToStaticMarkup(
      <Chart {...base} kind="step" baseline="fit" points={[{ x: 0, y: 42 }]} />
    )
    const runs = polylineXs(html)
    expect(runs).toHaveLength(1)
    expect(runs[0][0]).toBe(PLOT_LEFT)
    expect(runs[0][runs[0].length - 1]).toBe(PLOT_RIGHT)
    expect(html).not.toContain('no balance readings')
  })

  it('holds the last balance reading to the end of the window, as a step means', () => {
    const html = renderToStaticMarkup(
      <Chart
        {...base}
        kind="step"
        baseline="fit"
        points={[
          { x: 0, y: 42 },
          { x: 400, y: 30 }
        ]}
      />
    )
    const [xs] = polylineXs(html)
    expect(xs[xs.length - 1]).toBe(PLOT_RIGHT)
  })

  it('does not hold a step through a trailing gap — not sampled is not unchanged', () => {
    const html = renderToStaticMarkup(
      <Chart
        {...base}
        kind="step"
        points={[
          { x: 0, y: 2 },
          { x: 400, y: 3 },
          { x: 500, y: null }
        ]}
      />
    )
    const [xs] = polylineXs(html)
    expect(xs[xs.length - 1]).toBeLessThan(PLOT_RIGHT)
  })

  it('shows a lone reading between gaps as a dot rather than nothing', () => {
    const html = renderToStaticMarkup(
      <Chart
        {...base}
        kind="line"
        points={[
          { x: 0, y: null },
          { x: 500, y: 120 },
          { x: 600, y: null }
        ]}
      />
    )
    expect(html).toMatch(/<circle[^>]*r="2"/)
    expect(polylineXs(html)).toEqual([])
  })

  it('leaves lines and bars ending where their data ends', () => {
    const line = renderToStaticMarkup(
      <Chart
        {...base}
        kind="line"
        points={[
          { x: 0, y: 1 },
          { x: 500, y: 2 }
        ]}
      />
    )
    const [xs] = polylineXs(line)
    expect(xs[xs.length - 1]).toBeLessThan(PLOT_RIGHT)
  })
})
