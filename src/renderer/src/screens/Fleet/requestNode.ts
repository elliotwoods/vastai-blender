/**
 * What "+ request node" sends once the user has confirmed going past the
 * spend cap (plan 1.5).
 */

import type { RequestNodeOptions, SettingsPublic } from '../../../../shared/models'

/** The most one rental past the cap may cost, and where that figure comes from. */
export interface OverCapBound {
  perHour: number
  from: 'offerFilter' | 'spendCap'
}

/**
 * Past the cap, the price the offer filter allows bounds the rental: the
 * question names it, and main is told it (maxPerHour), so a confirmed
 * rental cannot come back dearer than the price the user agreed to. With
 * no price in the filter, the cap itself does: one node dearer than the
 * whole fleet's cap is never what "one more, past the cap" means, and
 * unbounded the top-ranked offer could be an 8×H100 at any $/hr. Null only
 * with neither a filter price nor a cap above $0 (no cap set), and the
 * question then says "at any price".
 */
export function overCapBound(
  settings: Pick<SettingsPublic, 'offerFilters' | 'spendCapPerHour' | 'noSpendCap'> | undefined
): OverCapBound | null {
  const filter = settings?.offerFilters?.maxDphTotal
  if (filter != null && filter >= 0) return { perHour: filter, from: 'offerFilter' }
  const cap = settings?.noSpendCap === true ? null : settings?.spendCapPerHour
  if (cap != null && cap > 0) return { perHour: cap, from: 'spendCap' }
  return null
}

export function overCapRequest(
  settings: Pick<SettingsPublic, 'offerFilters' | 'spendCapPerHour' | 'noSpendCap'> | undefined
): RequestNodeOptions {
  return { overSpendCap: true, maxPerHour: overCapBound(settings)?.perHour ?? null }
}
