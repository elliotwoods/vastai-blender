import { describe, expect, it, vi } from 'vitest'

vi.mock('../db/db', () => ({ getDb: () => ({}) }))

const { renderVramMb } = await import('./scenePerf')

const vram = (over = {}): Parameters<typeof renderVramMb>[0] => ({
  peakMb: null,
  gpu: 1,
  cardBaseMb: 6100,
  cardPeakMb: 12300,
  ...over
})

describe('renderVramMb', () => {
  it("takes nvidia-smi's figure for the render's own pid when it listed it", () => {
    expect(renderVramMb(vram({ peakMb: 7100.4 }), false)).toBe(7100)
  })

  it('falls back to what its card gained, only when it had the card to itself', () => {
    expect(renderVramMb(vram(), true)).toBe(6200)
    // Another render on the card: the growth is both of theirs.
    expect(renderVramMb(vram(), false)).toBeNull()
  })

  it('says nothing for an unpinned render or no reading', () => {
    expect(renderVramMb(vram({ gpu: null }), true)).toBeNull()
    expect(renderVramMb(vram({ cardPeakMb: null }), true)).toBeNull()
    expect(renderVramMb(null, true)).toBeNull()
  })
})
