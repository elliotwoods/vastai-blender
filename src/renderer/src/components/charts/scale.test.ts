import { describe, expect, it } from 'vitest'
import {
  barSlot,
  holdStep,
  hoverNotes,
  mergeIntervals,
  nearestIndex,
  niceCeil,
  polylinePoints,
  segments,
  stepHover,
  summarize,
  ticks,
  tooltipLeft,
  tooltipRows,
  unionXs,
  valueAt,
  yDomain
} from './scale'

describe('niceCeil', () => {
  it('rounds up to 1/2/5 × 10ⁿ', () => {
    expect(niceCeil(0.0731)).toBeCloseTo(0.1)
    expect(niceCeil(3)).toBe(5)
    expect(niceCeil(12)).toBe(20)
    expect(niceCeil(100)).toBe(100)
    expect(niceCeil(101)).toBe(200)
  })

  it('gives an empty or all-zero series a unit axis rather than a zero one', () => {
    expect(niceCeil(0)).toBe(1)
    expect(niceCeil(-5)).toBe(1)
  })
})

describe('yDomain', () => {
  it('starts quantities at zero and rounds the top', () => {
    expect(yDomain([3, 7], 'zero')).toEqual({ min: 0, max: 10 })
    expect(yDomain([], 'zero')).toEqual({ min: 0, max: 1 })
  })

  it('fits levels to the data exactly', () => {
    expect(yDomain([10, 12.5, 11], 'fit')).toEqual({ min: 10, max: 12.5 })
  })

  it('never collapses a flat level to a zero-height band', () => {
    expect(yDomain([7, 7], 'fit')).toEqual({ min: 6, max: 8 })
  })

  it('pins a bounded measure so an idle GPU does not fill the plot', () => {
    expect(yDomain([0, 3], 'zero', 100)).toEqual({ min: 0, max: 100 })
    expect(yDomain([], 'zero', 100)).toEqual({ min: 0, max: 100 })
  })

  it('never clips data above the pin', () => {
    expect(yDomain([40, 130], 'zero', 100)).toEqual({ min: 0, max: 200 })
  })

  it('takes six hours of eight GPUs at 15 s without a spread-argument overflow', () => {
    const many = Array.from({ length: 400_000 }, (_, i) => i % 101)
    expect(yDomain(many, 'zero', 100)).toEqual({ min: 0, max: 100 })
  })
})

describe('ticks', () => {
  it('spaces n + 1 values evenly, ends included', () => {
    expect(ticks(0, 100, 4)).toEqual([0, 25, 50, 75, 100])
  })
})

describe('segments', () => {
  it('breaks the line at every gap instead of drawing it through zero', () => {
    expect(
      segments([
        { x: 0, y: null },
        { x: 1, y: 5 },
        { x: 2, y: 6 },
        { x: 3, y: null },
        { x: 4, y: 0 },
        { x: 5, y: null }
      ])
    ).toEqual([
      [
        { x: 1, y: 5 },
        { x: 2, y: 6 }
      ],
      [{ x: 4, y: 0 }]
    ])
  })

  it('returns nothing for an all-gap series', () => {
    expect(segments([{ x: 0, y: null }])).toEqual([])
  })
})

describe('holdStep (#117)', () => {
  it('holds the last reading to the end of the window', () => {
    const pts = [
      { x: 0, y: 5 },
      { x: 40, y: 7 }
    ]
    expect(holdStep(segments(pts), pts, 100)).toEqual([
      [
        { x: 0, y: 5 },
        { x: 40, y: 7 },
        { x: 100, y: 7 }
      ]
    ])
  })

  it('turns a lone restamped anchor into a level across the window', () => {
    const pts = [{ x: 0, y: 42 }]
    expect(holdStep(segments(pts), pts, 100)).toEqual([
      [
        { x: 0, y: 42 },
        { x: 100, y: 42 }
      ]
    ])
  })

  it('does not hold through a trailing gap, nor past the window', () => {
    const gap = [
      { x: 0, y: 5 },
      { x: 40, y: null }
    ]
    expect(holdStep(segments(gap), gap, 100)).toEqual([[{ x: 0, y: 5 }]])
    const atEnd = [{ x: 100, y: 5 }]
    expect(holdStep(segments(atEnd), atEnd, 100)).toEqual([[{ x: 100, y: 5 }]])
    expect(holdStep([], [], 100)).toEqual([])
  })

  it('leaves earlier runs alone', () => {
    const pts = [
      { x: 0, y: 1 },
      { x: 10, y: null },
      { x: 20, y: 2 }
    ]
    expect(holdStep(segments(pts), pts, 50)).toEqual([
      [{ x: 0, y: 1 }],
      [
        { x: 20, y: 2 },
        { x: 50, y: 2 }
      ]
    ])
  })
})

describe('polylinePoints', () => {
  const id = (v: number): number => v
  const seg = [
    { x: 0, y: 1 },
    { x: 10, y: 3 }
  ]

  it('joins readings directly for a line', () => {
    expect(polylinePoints(seg, 'line', id, id)).toBe('0,1 10,3')
  })

  it('holds a step level until the next reading, then jumps', () => {
    expect(polylinePoints(seg, 'step', id, id)).toBe('0,1 10,1 10,3')
  })
})

describe('nearestIndex', () => {
  it('snaps to the nearest reading, however sparse', () => {
    expect(nearestIndex([0, 1000, 5000], 2900)).toBe(1)
    expect(nearestIndex([0, 1000, 5000], 3100)).toBe(2)
  })

  it('breaks a tie toward the earlier reading', () => {
    expect(nearestIndex([0, 10], 5)).toBe(0)
  })

  it('has nothing to snap to in an empty chart', () => {
    expect(nearestIndex([], 5)).toBe(-1)
  })
})

describe('unionXs', () => {
  it('merges every series’ positions, gaps included, ascending and distinct', () => {
    expect(
      unionXs([
        {
          points: [
            { x: 30, y: 1 },
            { x: 10, y: null }
          ]
        },
        {
          points: [
            { x: 20, y: 2 },
            { x: 10, y: 3 }
          ]
        }
      ])
    ).toEqual([10, 20, 30])
  })
})

describe('valueAt', () => {
  const pts = [
    { x: 0, y: 1 },
    { x: 10, y: null },
    { x: 20, y: 3 }
  ]

  it('reads an exact reading, and a gap as a gap', () => {
    expect(valueAt(pts, 20, 'line')).toBe(3)
    expect(valueAt(pts, 10, 'line')).toBeNull()
  })

  it('holds a step series at its last reading between readings', () => {
    expect(valueAt(pts, 25, 'step')).toBe(3)
    expect(valueAt(pts, 5, 'step')).toBe(1)
    expect(valueAt(pts, -5, 'step')).toBeNull()
  })

  it('invents nothing between readings of a line', () => {
    expect(valueAt(pts, 25, 'line')).toBeNull()
  })
})

describe('barSlot', () => {
  it('gives a single series the whole bucket', () => {
    expect(barSlot(30, 1, 0)).toEqual({ dx: 0, width: 30 })
  })

  it('splits a bucket between series with 2px gaps that add back to the bucket', () => {
    const slots = [0, 1, 2].map((i) => barSlot(32, 3, i))
    expect(slots.map((s) => s.width)).toEqual([28 / 3, 28 / 3, 28 / 3])
    const last = slots[2]
    expect(last.dx + last.width).toBeCloseTo(32)
    expect(slots[1].dx - (slots[0].dx + slots[0].width)).toBeCloseTo(2)
  })

  it('never draws a bar thinner than a pixel', () => {
    expect(barSlot(4, 8, 7).width).toBe(1)
  })
})

describe('mergeIntervals', () => {
  it('merges overlapping and touching spans into one wash, in order', () => {
    expect(
      mergeIntervals(
        [
          { fromMs: 50, toMs: 60 },
          { fromMs: 0, toMs: 20 },
          { fromMs: 10, toMs: 30 },
          { fromMs: 30, toMs: 40 }
        ],
        0,
        100
      )
    ).toEqual([
      { fromMs: 0, toMs: 40 },
      { fromMs: 50, toMs: 60 }
    ])
  })

  it('clips to the window and drops what falls outside it', () => {
    expect(
      mergeIntervals(
        [
          { fromMs: -50, toMs: 10 },
          { fromMs: 90, toMs: 150 },
          { fromMs: 200, toMs: 300 },
          { fromMs: 40, toMs: 40 }
        ],
        0,
        100
      )
    ).toEqual([
      { fromMs: 0, toMs: 10 },
      { fromMs: 90, toMs: 100 }
    ])
  })
})

describe('tooltipLeft', () => {
  it('sits just right of the crosshair', () => {
    expect(tooltipLeft(100, 640, 210)).toBe(110)
  })

  it('is clamped inside the chart at the right edge', () => {
    expect(tooltipLeft(600, 640, 210)).toBe(422)
  })

  it('never goes negative in a chart narrower than the panel', () => {
    expect(tooltipLeft(50, 100, 210)).toBe(0)
  })
})

describe('stepHover', () => {
  it('starts from the latest reading when nothing is hovered', () => {
    expect(stepHover('ArrowLeft', null, 5)).toBe(3)
    expect(stepHover('ArrowRight', null, 5)).toBe(4)
  })

  it('steps and stops at the ends', () => {
    expect(stepHover('ArrowLeft', 0, 5)).toBe(0)
    expect(stepHover('ArrowRight', 2, 5)).toBe(3)
    expect(stepHover('ArrowRight', 4, 5)).toBe(4)
    expect(stepHover('Home', 3, 5)).toBe(0)
    expect(stepHover('End', 0, 5)).toBe(4)
  })

  it('recovers an index left past the end by a shorter range', () => {
    expect(stepHover('ArrowLeft', 9, 5)).toBe(3)
  })

  it('clears on Escape and ignores keys that are not the chart’s', () => {
    expect(stepHover('Escape', 2, 5)).toBeNull()
    expect(stepHover('Tab', 2, 5)).toBeUndefined()
    expect(stepHover('ArrowLeft', null, 0)).toBeUndefined()
  })
})

describe('summarize', () => {
  it('skips gaps and non-numbers', () => {
    expect(summarize([10, null, 30, undefined, NaN, 20])).toEqual({ mean: 20, min: 10, max: 30 })
  })

  it('is null when nothing was read', () => {
    expect(summarize([null, null])).toBeNull()
    expect(summarize([])).toBeNull()
  })
})

describe('hoverNotes', () => {
  const idle = (gpu: number): { fromMs: number; toMs: number; label: string } => ({
    fromMs: 0,
    toMs: 600,
    label: `GPU ${gpu} idle, run assigned`
  })
  const eightIdle = Array.from({ length: 8 }, (_, i) => idle(i))

  it('lists eight GPUs idle over the same minute as one row under the chart’s band name', () => {
    // Eight band rows under eight series rows outgrew the 200px chart and
    // were clipped by the fleet list's scrolling panel.
    expect(hoverNotes(300, 5, eightIdle, [], 'paid, idle')).toEqual([
      { kind: 'band', label: 'paid, idle' }
    ])
  })

  it('lists a band label once however many spans share it', () => {
    const same = eightIdle.map((b) => ({ ...b, label: 'paid, idle' }))
    expect(hoverNotes(300, 5, same, [])).toEqual([{ kind: 'band', label: 'paid, idle' }])
  })

  it('names the one band there is, even when the chart has a collective name', () => {
    expect(hoverNotes(300, 5, [idle(3)], [], 'paid, idle')).toEqual([
      { kind: 'band', label: 'GPU 3 idle, run assigned' }
    ])
  })

  it('caps band and marker rows, counting the rest', () => {
    const markers = Array.from({ length: 5 }, (_, i) => ({
      atMs: 300 + i,
      label: `chunk ${i} dispatched`
    }))
    expect(hoverNotes(300, 5, eightIdle, markers)).toEqual([
      { kind: 'band', label: 'GPU 0 idle, run assigned' },
      { kind: 'band', label: 'GPU 1 idle, run assigned' },
      { kind: 'band', label: 'GPU 2 idle, run assigned' },
      { kind: 'more', label: '+5 more' },
      { kind: 'marker', label: 'chunk 0 dispatched' },
      { kind: 'marker', label: 'chunk 1 dispatched' },
      { kind: 'marker', label: 'chunk 2 dispatched' },
      { kind: 'more', label: '+2 more' }
    ])
  })

  it('lists only what lies within reach of the crosshair', () => {
    const bands = [{ fromMs: 0, toMs: 100, label: 'early' }]
    const markers = [
      { atMs: 290, label: 'near' },
      { atMs: 250, label: 'far' }
    ]
    expect(hoverNotes(300, 10, bands, markers)).toEqual([{ kind: 'marker', label: 'near' }])
    expect(hoverNotes(105, 10, bands, [])).toEqual([{ kind: 'band', label: 'early' }])
  })
})

describe('tooltipRows', () => {
  it('lists every series in order when there are few enough', () => {
    expect(tooltipRows([5, null, 9])).toEqual([0, 1, 2])
    expect(tooltipRows([5, null, 9], 3)).toEqual([0, 1, 2])
  })

  it('past the limit, lists the highest values first, and no reading last', () => {
    // A fleet of two dozen GPU lines would stack a readout taller than the chart.
    expect(tooltipRows([5, null, 9, 9, 1], 3)).toEqual([2, 3, 0])
    expect(tooltipRows([null, null, 4], 2)).toEqual([2, 0])
  })
})
