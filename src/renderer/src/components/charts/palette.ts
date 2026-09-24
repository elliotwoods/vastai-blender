/**
 * Categorical series colours — one per GPU index on a node, so "GPU 3" is the
 * same colour in every chart and survives a filter that hides GPU 2 (colour
 * follows the entity, never its row number).
 *
 * The eight hues are the dataviz reference palette, in its validated order.
 * The order is what keeps neighbours apart under colour-blindness, so it is
 * not cosmetic: never re-sort it, and never generate a ninth hue. Checked with
 * the dataviz skill's validate_palette.js (OKLab ΔE ×100):
 *   dark, on --surface-raised #1b1d21 and --surface #131417: every check
 *     passes — worst adjacent CVD ΔE 8.4 (target ≥ 8), normal vision 19.3
 *     (floor 15), all eight ≥ 3:1 against both surfaces.
 *   light, on #fcfcfb: passes — CVD 9.1, normal vision 19.6 — but aqua,
 *     yellow and magenta sit under 3:1, so a light theme owes those lines a
 *     legend or labels (TimeChart always draws the legend for ≥ 2 series).
 *
 * Each slot is a CSS `light-dark()` pair, resolved by the `color-scheme` in
 * styles/tokens.css — dark today, and a light theme gets its own validated
 * steps rather than an automatic flip. `light-dark()` is valid in CSS
 * properties, so the charts apply these through `style`, not SVG attributes.
 */

import { TOKENS } from '../../lib/theme'

const SLOTS: ReadonlyArray<readonly [light: string, dark: string]> = [
  ['#2a78d6', '#3987e5'], // blue
  ['#eb6834', '#d95926'], // orange
  ['#1baf7a', '#199e70'], // aqua
  ['#eda100', '#c98500'], // yellow
  ['#e87ba4', '#d55181'], // magenta
  ['#008300', '#008300'], // green
  ['#4a3aa7', '#9085e9'], // violet
  ['#e34948', '#e66767'] // red
]

/** How many series can carry their own hue. */
export const SERIES_SLOTS = SLOTS.length

/**
 * The colour for GPU `index` (0-based, as nvidia-smi numbers them). Past the
 * eighth, every GPU shares the de-emphasis grey: a generated ninth hue would
 * be indistinguishable from an existing one, so the tail folds into "other"
 * and the legend and tooltip carry which is which.
 */
export function gpuColor(index: number): string {
  const slot = SLOTS[index]
  return slot ? `light-dark(${slot[0]}, ${slot[1]})` : TOKENS.textFaint
}
