/**
 * The one way a settings change is saved from outside main (plan 1.14; #8
 * #99 #112 #159): settings:set, settings:update and fleet:setMaxNodes, and
 * the check a headless spec's settings go through before its overlay.
 *
 * settings:set used to merge whatever the renderer sent straight into
 * settings.json, one keystroke at a time. Backspacing the spend cap saved
 * null, which every reader takes as "no cap"; "1e3" in max nodes saved
 * 1000; an emptied idle timeout saved 0; and blenderVersionOverride reached
 * the node's shell unquoted. Every patch now goes through
 * sanitizeSettingsPatch, with this computer's path spelling, and only what
 * passed is saved.
 *
 * Only the fields the patch named are saved, never the whole sanitized
 * settings. What getSettings() returns can carry a headless run's overlay
 * (settingsOverlay.ts), and saving it back whole would write the run's
 * settings to disk: the bug the overlay exists to fix.
 */

import type {
  OfferFilters,
  SettingsFieldError,
  SettingsPatchResult,
  SettingsPublic
} from '../../shared/models'
import { sanitizeSettingsPatch, type PathFlavour } from '../../shared/settingsSanitize'
import { sessionOverlay, type OverlayFields, type SettingsOverlay } from './settingsOverlay'

/** settings.ts, as the gate uses it. */
export interface SettingsStore {
  /** What is in force: the saved settings, with any session overlay over them. */
  getSettings(): SettingsPublic
  /** Merge `patch` into the saved settings and write them (offerFilters merges too). */
  updateSettings(patch: Partial<SettingsPublic>): SettingsPublic
}

export interface GateOptions {
  pathFlavour: PathFlavour
  /** Defaults to this process's. */
  overlay?: SettingsOverlay
}

/** main's own fields: sanitizeSettingsPatch drops them without a word. */
const DERIVED = new Set(['hasVastApiKey', 'hasOtoyCredentials', 'installId'])

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * The fields of `patch` that passed, with the values sanitizeSettingsPatch
 * settled on (a clamped one at its limit). A field it refused is left out,
 * so it keeps what it had. Offer filters are picked one by one: `current`'s
 * other filters may be an overlay's. octane and dockerImageByEngine come
 * whole, as sanitized, because a null engine image is a deletion that only
 * a whole object carries; no overlay ever holds them. The spend cap and
 * "no spend cap" go together or not at all, so the saved pair can never
 * read null without the flag.
 */
export function acceptedFields(patch: unknown, result: SettingsPatchResult): OverlayFields {
  if (!isRecord(patch)) return {}
  const refused = new Set(result.errors.filter((e) => e.outcome === 'rejected').map((e) => e.field))
  const settled = result.settings as unknown as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(patch)) {
    const value = patch[key]
    if (value === undefined || DERIVED.has(key) || refused.has(key)) continue
    if (key === 'spendCapPerHour' || key === 'noSpendCap') continue
    if (!(key in settled)) continue
    if (key === 'offerFilters') {
      if (!isRecord(value)) continue
      const filters: Record<string, unknown> = {}
      for (const f of Object.keys(value)) {
        if (value[f] === undefined || refused.has(`offerFilters.${f}`)) continue
        if (f in result.settings.offerFilters) {
          filters[f] = (result.settings.offerFilters as unknown as Record<string, unknown>)[f]
        }
      }
      if (Object.keys(filters).length > 0) out.offerFilters = filters as Partial<OfferFilters>
      continue
    }
    out[key] = settled[key]
  }
  const capTouched = patch.spendCapPerHour !== undefined || patch.noSpendCap !== undefined
  if (capTouched && !refused.has('spendCapPerHour') && !refused.has('noSpendCap')) {
    out.spendCapPerHour = result.settings.spendCapPerHour
    out.noSpendCap = result.settings.noSpendCap === true
  }
  return out as OverlayFields
}

/**
 * Check `patch`, save what passed, and say what did not. The result's
 * settings are what is in force afterwards; its errors name each field not
 * saved as sent. A field the user saved leaves the session overlay, so a
 * person's change during a headless run takes effect at once.
 */
export function applySettingsPatch(
  patch: unknown,
  store: SettingsStore,
  opts: GateOptions
): SettingsPatchResult {
  const overlay = opts.overlay ?? sessionOverlay
  const result = sanitizeSettingsPatch(patch, store.getSettings(), {
    pathFlavour: opts.pathFlavour
  })
  const accepted = acceptedFields(patch, result)
  if (Object.keys(accepted).length > 0) {
    try {
      store.updateSettings(accepted as Partial<SettingsPublic>)
    } finally {
      // Even when the write to disk failed: settings.ts has already taken
      // the change in memory, and that is what it will hand out.
      overlay.release(accepted)
    }
  }
  return { settings: store.getSettings(), errors: result.errors }
}

/** One line per field not saved as sent, for a log or a thrown error. */
export function describeFieldErrors(errors: readonly SettingsFieldError[]): string {
  return errors.map((e) => `${e.field}: ${e.message}`).join('; ')
}
