import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { TimeChart, type TimeChartProps, type TimeSeries } from './TimeChart'
import { gpuColor } from './palette'

// Server rendering never runs the ResizeObserver; give the chart a width.
vi.mock('./useWidth', () => ({ useWidth: () => 640 }))

const base: Omit<TimeChartProps, 'series' | 'kind'> = {
  fromMs: 0,
  toMs: 1000,
  format: (v) => `${v.toFixed(0)}%`,
  formatX: (ms) => `t${ms}`,
  emptyNote: 'no samples'
}

const gpu = (i: number, ys: Array<number | null>): TimeSeries => ({
  id: `gpu${i}`,
  label: `GPU ${i}`,
  color: gpuColor(i),
  points: ys.map((y, k) => ({ x: k * 100, y }))
})

const render = (p: Partial<TimeChartProps> & Pick<TimeChartProps, 'series' | 'kind'>): string =>
  renderToStaticMarkup(<TimeChart {...base} {...p} />)

const count = (html: string, re: RegExp): number => html.match(re)?.length ?? 0

describe('TimeChart', () => {
  it('draws each GPU in its own colour, broken at its own gaps', () => {
    const html = render({
      kind: 'line',
      series: [gpu(0, [90, 95, null, 97]), gpu(1, [10, 12, 14, 16])]
    })
    // GPU 0 has two runs either side of its gap, GPU 1 one unbroken run.
    expect(count(html, /<polyline[^>]*stroke:light-dark\(#2a78d6, #3987e5\)/g)).toBe(2)
    expect(count(html, /<polyline[^>]*stroke:light-dark\(#eb6834, #d95926\)/g)).toBe(1)
  })

  it('always keys two or more series with a legend, never colour alone', () => {
    const html = render({ kind: 'line', series: [gpu(0, [1]), gpu(1, [2])] })
    expect(count(html, /<button[^>]*aria-pressed="false"/g)).toBe(2)
    expect(html).toContain('GPU 0')
    expect(html).toContain('GPU 1')
  })

  it('draws no legend box for a single series — the title names it', () => {
    const html = render({ kind: 'line', series: [gpu(0, [1, 2])] })
    expect(html).not.toContain('<button')
  })

  it('pins a percentage axis at 100 so an idle GPU does not read as busy', () => {
    const html = render({ kind: 'line', yMax: 100, series: [gpu(0, [2, 3])] })
    expect(html).toContain('>100%<')
    expect(html).not.toContain('>5%<')
  })

  it('shades overlapping idle spans as one wash, with a legend entry', () => {
    const html = render({
      kind: 'line',
      series: [gpu(0, [0, 0, 80])],
      bands: [
        { fromMs: 0, toMs: 150, label: 'GPU 0 idle, run assigned' },
        { fromMs: 100, toMs: 200, label: 'GPU 1 idle, run assigned' }
      ],
      bandLabel: 'paid, idle'
    })
    expect(count(html, /<rect[^>]*fill:var\(--warn-soft-bg\)/g)).toBe(1)
    expect(html).toContain('paid, idle')
  })

  it('sets grouped bars side by side inside the bucket', () => {
    const html = render({
      kind: 'bars',
      spanMs: 100,
      series: [gpu(0, [5, 6]), gpu(1, [7, 8])]
    })
    const rects = [...html.matchAll(/<rect x="([\d.]+)"[^>]*width="([\d.]+)"/g)].map((m) => ({
      x: Number(m[1]),
      w: Number(m[2])
    }))
    expect(rects).toHaveLength(4)
    // First bucket: GPU 0's bar, a 2px gap, then GPU 1's.
    expect(rects[2].x - (rects[0].x + rects[0].w)).toBeCloseTo(2)
  })

  it('washes the area under a series marked as a part of the whole', () => {
    const html = render({
      kind: 'step',
      series: [
        { ...gpu(0, [4, 4, 4]), id: 'rented', label: 'rented' },
        { ...gpu(1, [2, 3, 1]), id: 'busy', label: 'busy', area: true }
      ]
    })
    expect(count(html, /<polygon/g)).toBe(1)
  })

  it('ticks markers inside the window only', () => {
    const html = render({
      kind: 'line',
      series: [gpu(0, [1, 2])],
      markers: [
        { atMs: 50, label: 'chunk 3 dispatched' },
        { atMs: 5000, label: 'outside' }
      ]
    })
    expect(count(html, /<line[^>]*stroke="var\(--text-muted\)"/g)).toBe(1)
  })

  it('is reachable by keyboard when there is something to read', () => {
    expect(render({ kind: 'line', series: [gpu(0, [1])] })).toContain('tabindex="0"')
    const empty = render({ kind: 'line', series: [] })
    expect(empty).not.toContain('tabindex')
    expect(empty).toContain('no samples')
  })
})
