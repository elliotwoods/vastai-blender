/**
 * The Settings screen's rules, pure so they are tested without a DOM (plan
 * 1.14; #99 #112).
 *
 * The screen used to send a patch on every keystroke of a `type="number"`
 * input. Backspacing the spend cap to retype it sent null, which main saved
 * as "no cap" and the scheduler read the same way. Numbers now go through
 * NumberField, which commits once, when the user is done; a cap field has
 * no blank at all, and "no spend cap" is a box the user ticks. Each save
 * goes to settings:update, which says per field what main refused or
 * clamped, and the screen shows that next to the field.
 */

import type {
  OfferFilters,
  SettingsFieldError,
  SettingsPatch,
  SettingsPublic
} from '../../../../shared/models'
import { BLENDER_VERSION_RE, SETTINGS_LIMITS } from '../../../../shared/settingsSanitize'

type Limited = keyof typeof SETTINGS_LIMITS

/** NumberField's min, max and integer for a setting, from the limits main enforces. */
export function limitsOf(key: Limited): { min: number; max: number; integer: boolean } {
  const lim: { min: number; max: number; integer?: boolean } = SETTINGS_LIMITS[key]
  return { min: lim.min, max: lim.max, integer: lim.integer === true }
}

/**
 * The fields a patch names, dotted as SettingsFieldError spells them. The
 * spend cap and its flag count as both, since main settles them together.
 */
export function fieldsOf(patch: SettingsPatch): string[] {
  const out: string[] = []
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (key === 'offerFilters') {
      for (const f of Object.keys(value as Partial<OfferFilters>)) out.push(`offerFilters.${f}`)
    } else if (key === 'spendCapPerHour' || key === 'noSpendCap') {
      out.push('spendCapPerHour', 'noSpendCap')
    } else {
      out.push(key)
    }
  }
  return [...new Set(out)]
}

/**
 * The errors to show once a save of `patch` came back with `errors`: this
 * save's, and any earlier one's for a field this save did not touch. A
 * field saved cleanly loses its old error.
 */
export function mergeFieldErrors(
  shown: readonly SettingsFieldError[],
  patch: SettingsPatch,
  errors: readonly SettingsFieldError[]
): SettingsFieldError[] {
  const touched = new Set(fieldsOf(patch))
  return [...shown.filter((e) => !touched.has(e.field)), ...errors]
}

/**
 * How the spend cap stands:
 * - 'cap': a figure is in force.
 * - 'noCap': the user turned the cap off on purpose.
 * - 'blank': no figure and no flag, as a settings file from before the flag
 *   can have. Scale-up reads that as $0/hr and rents nothing
 *   (nodeState.capacityBudget), so the screen says so.
 */
export type SpendCapMode = 'cap' | 'noCap' | 'blank'

export function spendCapMode(
  s: Pick<SettingsPublic, 'spendCapPerHour' | 'noSpendCap'>
): SpendCapMode {
  if (s.noSpendCap === true) return 'noCap'
  return typeof s.spendCapPerHour === 'number' ? 'cap' : 'blank'
}

/**
 * What ticking or unticking "no spend cap" sends. Unticking sends nothing:
 * the cap comes back on when the user types a figure, which saves the
 * figure and the flag together. Until then there is still no cap, and the
 * screen says so, rather than picking a figure the user never chose.
 */
export function noSpendCapPatch(checked: boolean): SettingsPatch | null {
  return checked ? { noSpendCap: true } : null
}

/**
 * Why `text` is not a Blender version override, or null when it is one, or
 * blank (match each .blend). Main checks the same rule (BLENDER_VERSION_RE);
 * the version goes unquoted into a command on the node.
 */
export function blenderVersionProblem(text: string): string | null {
  const t = text.trim()
  if (t === '' || BLENDER_VERSION_RE.test(t)) return null
  return 'a version such as 4.5 or 4.5.3, or blank to match each .blend'
}

/** The patch a finished Blender version edit sends. */
export function blenderVersionPatch(text: string): SettingsPatch {
  const t = text.trim()
  return { blenderVersionOverride: t === '' ? null : t }
}
