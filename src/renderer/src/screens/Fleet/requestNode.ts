/**
 * What "+ request node" sends once the user has confirmed going past the
 * spend cap (plan 1.5).
 */

import type { RequestNodeOptions, SettingsPublic } from '../../../../shared/models'

/**
 * Past the cap, the price the offer filter allows is the only bound: the
 * question names it, and main is told it (maxPerHour), so a confirmed
 * rental cannot come back dearer than the price the user agreed to. With
 * no price filter there is no bound to send, and the question says so.
 */
export function overCapRequest(
  settings: Pick<SettingsPublic, 'offerFilters'> | undefined
): RequestNodeOptions {
  return { overSpendCap: true, maxPerHour: settings?.offerFilters?.maxDphTotal ?? null }
}
