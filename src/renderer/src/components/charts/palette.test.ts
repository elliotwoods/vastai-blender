import { describe, expect, it } from 'vitest'
import { TOKENS } from '../../lib/theme'
import { SERIES_SLOTS, gpuColor } from './palette'

describe('gpuColor', () => {
  it('gives each of the first eight GPUs its own light/dark pair', () => {
    const colors = Array.from({ length: SERIES_SLOTS }, (_, i) => gpuColor(i))
    expect(SERIES_SLOTS).toBe(8)
    expect(new Set(colors).size).toBe(8)
    for (const c of colors) expect(c).toMatch(/^light-dark\(#[0-9a-f]{6}, #[0-9a-f]{6}\)$/)
  })

  it('keeps the validated order: GPU 0 is blue, GPU 1 orange', () => {
    // The order is the colour-blind safety mechanism — a re-sort puts
    // look-alike hues next to each other.
    expect(gpuColor(0)).toBe('light-dark(#2a78d6, #3987e5)')
    expect(gpuColor(1)).toBe('light-dark(#eb6834, #d95926)')
  })

  it('follows the GPU, not its position in a filtered list', () => {
    expect(gpuColor(3)).toBe(gpuColor(3))
    expect(gpuColor(3)).not.toBe(gpuColor(2))
  })

  it('folds GPUs past the eighth into the de-emphasis grey instead of inventing a hue', () => {
    expect(gpuColor(8)).toBe(TOKENS.textFaint)
    expect(gpuColor(15)).toBe(TOKENS.textFaint)
    expect(gpuColor(-1)).toBe(TOKENS.textFaint)
  })
})
