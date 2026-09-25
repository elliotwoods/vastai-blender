/**
 * Say when a number grew: each time `value` goes up, `gen` goes up by one,
 * with the old and new values in `from` and `to`. Key an element on `gen`
 * and give it a CSS animation (vr-progress-glow): the remount restarts the
 * keyframe, so every step of growth flashes, not only the first. Going down
 * (a requeue, a job revived) is not growth and does not pulse, and neither
 * does the first render.
 *
 * State adjusted during render (React's "storing information from previous
 * renders"), not in an effect: the pulse lands in the same commit as the
 * growth it marks.
 */

import { useState } from 'react'

export interface GrowPulse {
  /** increases by one per growth; 0 = never grew */
  gen: number
  /** the value before the latest growth, and after it */
  from: number
  to: number
}

/** The pulse state, with the value it last saw. */
export interface GrowState extends GrowPulse {
  last: number
}

/** The next pulse state for `value` (pure; the hook's step). */
export function growStep(s: GrowState, value: number): GrowState {
  if (value === s.last) return s
  return value > s.last
    ? { last: value, gen: s.gen + 1, from: s.last, to: value }
    : { last: value, gen: s.gen, from: value, to: value }
}

export function useGrowPulse(value: number): GrowPulse {
  const [s, setS] = useState<GrowState>(() => ({ last: value, gen: 0, from: value, to: value }))
  const next = growStep(s, value)
  if (next !== s) setS(next)
  return next
}
