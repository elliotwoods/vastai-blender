/**
 * Making a CO2 figure mean something.
 *
 * "1.8 kg CO2e" is a number almost nobody has intuition for. Anchoring it
 * against a familiar activity — "≈ 1.2 × a full hot bath" — turns it into a
 * judgement you can actually make about a render.
 *
 * The ladder below is spaced two to three anchors per order of magnitude from
 * a few grams to fifteen tonnes, which is what makes the phrasing work: a
 * multiplier is always found within roughly [1, 3), so the output never reads
 * "≈ 0.004 × a transatlantic flight" or "≈ 900 × a phone charge".
 *
 * The values are deliberately one- or two-significant-figure anchors, not
 * citations. They come from the usual public lifecycle estimates and vary
 * substantially by source, methodology and country — they are here to give a
 * sense of scale, and the surrounding copy never claims more than that.
 */

export interface Comparison {
  /** kg CO2e */
  kg: number
  /** noun phrase, always starting with an article: "a full hot bath" */
  label: string
}

/** Ascending. Keep it that way — `compareCo2` scans from the top down. */
export const COMPARISONS: Comparison[] = [
  { kg: 0.004, label: 'a phone charge' },
  { kg: 0.01, label: 'a lift ride up 8 floors' },
  { kg: 0.03, label: 'an hour of a gaming laptop' },
  { kg: 0.09, label: 'a kilometre in an electric car' },
  { kg: 0.2, label: 'a kilometre in a petrol car' },
  { kg: 0.4, label: 'a cup of coffee' },
  { kg: 0.7, label: 'an 8-minute hot shower' },
  { kg: 2, label: 'a full hot bath' },
  { kg: 3, label: 'a cheeseburger' },
  { kg: 8, label: "a day of a home's electricity" },
  { kg: 20, label: 'a return train trip London–Paris' },
  { kg: 60, label: 'a kilogram of beef' },
  { kg: 130, label: 'a tank of petrol burned' },
  { kg: 500, label: 'a one-way flight London–New York' },
  { kg: 1000, label: 'a transatlantic round trip' },
  { kg: 2500, label: 'a year of gas heating for a home' },
  { kg: 5000, label: "an average person's yearly footprint in the UK" },
  { kg: 15000, label: "an average person's yearly footprint in the US" }
]

/** Trim a multiplier to a readable precision without fake significant figures. */
function fmtMultiple(n: number): string {
  if (n >= 100) return n.toFixed(0)
  if (n >= 10) return n.toFixed(0)
  if (n >= 1) return n.toFixed(1)
  return n.toFixed(2)
}

/**
 * The closest everyday equivalent to some CO2e, as `≈ 1.4 × a full hot bath`.
 *
 * Picks the largest anchor that the value clears, so the multiplier is ≥ 1 and
 * — given the ladder's spacing — below about 3. Below the smallest anchor it
 * uses that one with a fractional multiplier, which is the honest way to say
 * "less than a phone charge". Returns null for nothing worth comparing.
 */
export function compareCo2(grams: number): string | null {
  if (!(grams > 0)) return null
  const kg = grams / 1000

  let chosen = COMPARISONS[0]
  for (const c of COMPARISONS) {
    if (kg >= c.kg) chosen = c
    else break
  }
  return `≈ ${fmtMultiple(kg / chosen.kg)} × ${chosen.label}`
}
