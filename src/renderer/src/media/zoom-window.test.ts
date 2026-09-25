import { describe, expect, it } from 'vitest'
import { domainOf } from './frame-domain'
import type { ChunkSnapshot } from '../../../shared/models'
import {
  MAX_CELL,
  MIN_CELL,
  DEFAULT_SPAN,
  MIN_SPAN,
  clampView,
  chunkSpans,
  defaultView,
  dragEdge,
  fitAllView,
  layoutStrip,
  minimapColumns,
  pan,
  recenter,
  sampledIndices,
  stripSlots,
  viewSpan,
  wholeView,
  worstState,
  zoomAround
} from './zoom-window'

describe('clampView', () => {
  it('keeps a valid view as is', () => {
    expect(clampView({ from: 10, to: 50 }, 100)).toEqual({ from: 10, to: 50 })
  })
  it('widens a view narrower than MIN_SPAN', () => {
    expect(viewSpan(clampView({ from: 10, to: 11 }, 100))).toBe(MIN_SPAN)
  })
  it('allows a short job to be viewed whole', () => {
    expect(clampView({ from: 0, to: 0 }, 3)).toEqual({ from: 0, to: 2 })
  })
  it('shifts a view that runs off an end, keeping its span', () => {
    expect(clampView({ from: 90, to: 119 }, 100)).toEqual({ from: 70, to: 99 })
    expect(clampView({ from: -5, to: 14 }, 100)).toEqual({ from: 0, to: 19 })
  })
  it('caps the span at the job', () => {
    expect(clampView({ from: -10, to: 500 }, 100)).toEqual({ from: 0, to: 99 })
  })
  it('orders reversed ends, rounds and survives NaN', () => {
    expect(clampView({ from: 40.4, to: 20.6 }, 100)).toEqual({ from: 21, to: 40 })
    expect(clampView({ from: NaN, to: NaN }, 100)).toEqual({ from: 0, to: 99 })
  })
  it('an empty job has an empty view', () => {
    expect(clampView({ from: 0, to: 10 }, 0)).toEqual({ from: 0, to: -1 })
    expect(viewSpan(wholeView(0))).toBe(0)
  })
})

describe('dragEdge', () => {
  const v = { from: 20, to: 60 }
  it('moves only the dragged edge', () => {
    expect(dragEdge(v, 'from', 5, 100)).toEqual({ from: 5, to: 60 })
    expect(dragEdge(v, 'to', 80, 100)).toEqual({ from: 20, to: 80 })
  })
  it('stops MIN_SPAN short of the other edge', () => {
    expect(dragEdge(v, 'from', 70, 100)).toEqual({ from: 60 - MIN_SPAN + 1, to: 60 })
    expect(dragEdge(v, 'to', 0, 100)).toEqual({ from: 20, to: 20 + MIN_SPAN - 1 })
  })
  it('clamps to the domain', () => {
    expect(dragEdge(v, 'from', -30, 100)).toEqual({ from: 0, to: 60 })
    expect(dragEdge(v, 'to', 1000, 100)).toEqual({ from: 20, to: 99 })
  })
})

describe('pan', () => {
  it('shifts and keeps the span', () => {
    expect(pan({ from: 10, to: 29 }, 5, 100)).toEqual({ from: 15, to: 34 })
  })
  it('stops at either end', () => {
    expect(pan({ from: 10, to: 29 }, -50, 100)).toEqual({ from: 0, to: 19 })
    expect(pan({ from: 10, to: 29 }, 500, 100)).toEqual({ from: 80, to: 99 })
  })
})

describe('zoomAround', () => {
  it('zooms in about the anchor, keeping its relative position', () => {
    const z = zoomAround({ from: 0, to: 99 }, 50, 0.5, 1000)
    expect(viewSpan(z)).toBe(50)
    expect(z.from).toBeLessThanOrEqual(50)
    expect(z.to).toBeGreaterThanOrEqual(50)
    // The anchor stays about half way.
    expect(Math.abs(50 - (z.from + z.to) / 2)).toBeLessThanOrEqual(1)
  })
  it('keeps an anchor at the left edge there', () => {
    expect(zoomAround({ from: 100, to: 199 }, 100, 0.5, 1000).from).toBe(100)
  })
  it('zooms out, capped at the whole job', () => {
    expect(zoomAround({ from: 40, to: 59 }, 50, 100, 100)).toEqual({ from: 0, to: 99 })
  })
  it('never zooms in past MIN_SPAN', () => {
    expect(viewSpan(zoomAround({ from: 0, to: 9 }, 5, 0.01, 100))).toBe(MIN_SPAN)
  })
  it('always moves by at least one frame', () => {
    expect(viewSpan(zoomAround({ from: 0, to: 9 }, 5, 0.99, 100))).toBe(9)
    expect(viewSpan(zoomAround({ from: 0, to: 9 }, 5, 1.01, 100))).toBe(11)
  })
  it('ignores a bad factor', () => {
    expect(zoomAround({ from: 0, to: 9 }, 5, 0, 100)).toEqual({ from: 0, to: 9 })
  })
})

describe('recenter', () => {
  it('centres the view, keeping its span', () => {
    expect(recenter({ from: 0, to: 20 }, 50, 100)).toEqual({ from: 40, to: 60 })
  })
  it('clamps near the ends', () => {
    expect(recenter({ from: 40, to: 60 }, 2, 100)).toEqual({ from: 0, to: 20 })
    expect(recenter({ from: 40, to: 60 }, 99, 100)).toEqual({ from: 79, to: 99 })
  })
})

describe('layoutStrip', () => {
  it('shows every frame when they fit, as wide as the space allows', () => {
    const l = layoutStrip(10, 1000)
    expect(l).toMatchObject({ stride: 1, sampled: false, cells: 10 })
    expect(l.cellW).toBe(98)
  })
  it('caps cells at MAX_CELL', () => {
    expect(layoutStrip(2, 1000).cellW).toBe(MAX_CELL)
  })
  it('samples when frames would be narrower than MIN_CELL', () => {
    // 1000 px holds 17 cells of 56 + 2.
    const l = layoutStrip(240, 1000)
    expect(l.sampled).toBe(true)
    expect(l.stride).toBe(Math.ceil(240 / 17))
    expect(l.cells).toBe(Math.ceil(240 / l.stride))
    expect(l.cells * (l.cellW + 2) - 2).toBeLessThanOrEqual(1000)
    expect(l.cellW).toBeGreaterThanOrEqual(MIN_CELL)
  })
  it('switches to sampling exactly at the slot count', () => {
    expect(layoutStrip(17, 1000).sampled).toBe(false)
    expect(layoutStrip(18, 1000).sampled).toBe(true)
  })
  it('handles zero width and zero frames', () => {
    expect(layoutStrip(100, 0)).toMatchObject({ cellW: MIN_CELL, stride: 100, cells: 1 })
    expect(layoutStrip(0, 800)).toMatchObject({ stride: 1, sampled: false, cells: 0 })
  })
})

describe('sampledIndices', () => {
  it('lists every index at stride 1', () => {
    expect(sampledIndices({ from: 3, to: 7 }, 1)).toEqual([3, 4, 5, 6, 7])
  })
  it('takes multiples of the stride, so panning does not reshuffle', () => {
    expect(sampledIndices({ from: 3, to: 30 }, 10)).toEqual([10, 20, 30])
    expect(sampledIndices({ from: 4, to: 31 }, 10)).toEqual([10, 20, 30])
    expect(sampledIndices({ from: 0, to: 25 }, 10)).toEqual([0, 10, 20])
  })
  it('never exceeds the layout cell count', () => {
    for (const [from, count, width] of [
      [0, 240, 1000],
      [7, 5000, 1300],
      [13, 999, 600]
    ]) {
      const l = layoutStrip(count, width)
      expect(sampledIndices({ from, to: from + count - 1 }, l.stride).length).toBeLessThanOrEqual(
        l.cells
      )
    }
  })
  it('is empty for an empty view', () => {
    expect(sampledIndices({ from: 0, to: -1 }, 1)).toEqual([])
  })
})

describe('worstState', () => {
  it('orders failed > cancelled > working > queued > complete', () => {
    expect(worstState(['complete', 'pending', 'rendering', 'cancelled', 'failed'])).toBe('failed')
    expect(worstState(['complete', 'pending', 'cancelled', 'encoding'])).toBe('cancelled')
    expect(worstState(['complete', 'assigned', 'downloading'])).toBe('downloading')
    expect(worstState(['complete', 'pending'])).toBe('pending')
    expect(worstState(['complete', 'complete'])).toBe('complete')
  })
  it('skips undefined and returns undefined for nothing', () => {
    expect(worstState([undefined, 'complete'])).toBe('complete')
    expect(worstState([])).toBeUndefined()
  })
  it('ranks an unknown state as not done', () => {
    expect(worstState(['complete', 'paused'])).toBe('paused')
  })
})

describe('minimapColumns', () => {
  it('gives each column the worst state under it and its done fraction', () => {
    const cols = minimapColumns(
      100,
      [
        { from: 0, to: 49, state: 'complete', done: 50 },
        { from: 50, to: 99, state: 'rendering', done: 10 }
      ],
      10
    )
    expect(cols.slice(0, 5).every((c) => c.state === 'complete' && c.doneFrac === 1)).toBe(true)
    expect(cols[5]).toEqual({ state: 'rendering', doneFrac: 1 })
    expect(cols[6]).toEqual({ state: 'rendering', doneFrac: 0 })
  })
  it('mixes spans that share a column', () => {
    const cols = minimapColumns(
      100,
      [
        { from: 0, to: 4, state: 'complete', done: 5 },
        { from: 5, to: 9, state: 'failed', done: 0 }
      ],
      10
    )
    expect(cols[0]).toEqual({ state: 'failed', doneFrac: 0.5 })
    expect(cols[1].state).toBeUndefined()
  })
  it('maps a short job across a wide minimap', () => {
    const cols = minimapColumns(4, [{ from: 2, to: 3, state: 'pending', done: 0 }], 8)
    expect(cols.map((c) => c.state)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      'pending',
      'pending',
      'pending',
      'pending'
    ])
  })
  it('ignores spans outside the domain', () => {
    const cols = minimapColumns(10, [{ from: 20, to: 30, state: 'failed', done: 0 }], 5)
    expect(cols.every((c) => c.state === undefined)).toBe(true)
  })
})

describe('fitAllView', () => {
  it('narrows to what fits unsampled, about the same centre', () => {
    const slots = stripSlots(1000)
    const v = fitAllView({ from: 0, to: 4999 }, 1000, 5000)
    expect(viewSpan(v)).toBe(slots)
    expect(layoutStrip(viewSpan(v), 1000).sampled).toBe(false)
    expect(Math.abs((v.from + v.to) / 2 - 2499.5)).toBeLessThanOrEqual(1)
  })
  it('leaves a view that already fits alone', () => {
    expect(fitAllView({ from: 10, to: 19 }, 1000, 100)).toEqual({ from: 10, to: 19 })
  })
})

describe('chunkSpans', () => {
  const chunk = (p: Partial<ChunkSnapshot>): ChunkSnapshot => ({
    id: 'c',
    jobId: 'j',
    frameStart: 1,
    frameEnd: 10,
    state: 'pending',
    nodeId: null,
    framesDone: 0,
    retries: 0,
    ...p
  })
  const domain = domainOf(1, 20, 1)
  it('maps chunks to index spans with done counts', () => {
    expect(
      chunkSpans(domain, [
        chunk({ id: 'a', state: 'complete' }),
        chunk({ id: 'b', frameStart: 11, frameEnd: 20, state: 'rendering', framesDone: 2 })
      ])
    ).toEqual([
      { from: 0, to: 9, state: 'complete', done: 10 },
      { from: 10, to: 19, state: 'rendering', done: 2 }
    ])
  })
  it('takes the larger of stored and live counts, capped at the chunk', () => {
    const c = [chunk({ id: 'b', state: 'rendering', framesDone: 2 })]
    expect(chunkSpans(domain, c, { b: { framesDone: 5 } })[0].done).toBe(5)
    expect(chunkSpans(domain, c, { b: { framesDone: 50 } })[0].done).toBe(10)
  })
  it('drops chunks outside the domain', () => {
    expect(chunkSpans(domain, [chunk({ frameStart: 30, frameEnd: 40 })])).toEqual([])
  })
})

describe('defaultView', () => {
  it('shows a short job whole', () => {
    expect(defaultView(150, [{ from: 0, to: 9, state: 'complete', done: 10 }])).toEqual({
      from: 0,
      to: 149
    })
  })
  it('shows a long job whole until something is done', () => {
    expect(defaultView(5000, [{ from: 0, to: 99, state: 'rendering', done: 0 }])).toEqual({
      from: 0,
      to: 4999
    })
  })
  it('centres on the furthest frame done', () => {
    const v = defaultView(5000, [
      { from: 0, to: 999, state: 'complete', done: 1000 },
      { from: 1000, to: 1999, state: 'rendering', done: 500 }
    ])
    expect(viewSpan(v)).toBe(DEFAULT_SPAN)
    expect(v.from).toBeLessThanOrEqual(1499)
    expect(v.to).toBeGreaterThanOrEqual(1499)
  })
})
