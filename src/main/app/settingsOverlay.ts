/**
 * Settings a headless run (VR_JOB_SPEC) puts in force for its own session,
 * never saved (plan 1.14).
 *
 * The spec driver used to call updateSettings with the spec's fleet size,
 * spend cap, slot counts and offer filters, which saved them to
 * settings.json. Two sessions of spec runs left Elliot's own settings
 * rewritten for good: the next time he opened the app it rented with a
 * campaign's 30 nodes and filters he had never chosen. A spec now sets an
 * overlay instead. getSettings() lays it over what is saved, so every
 * reader sees the run's values for as long as the process lives, and
 * settings.ts never writes it, because persist() writes only its own cache.
 *
 * A person's change wins. A value the user sets through the app while the
 * run goes (the Fleet stepper to 0 to stop renting, a new cap) is theirs:
 * settingsGate saves it and releases that field from the overlay, so it is
 * in force at once rather than hidden behind the spec's.
 *
 * The overlay holds only fields a spec may set, as SettingsPublic spells
 * them, already through sanitizeSettingsPatch. Nothing here reads the disk
 * or Electron, so settings.ts can import it without a cycle.
 */

import type { OfferFilters, SettingsPublic } from '../../shared/models'

/** Top-level fields as saved, and offer filters one by one. */
export type OverlayFields = Partial<Omit<SettingsPublic, 'offerFilters'>> & {
  offerFilters?: Partial<OfferFilters>
}

/** Fields that are main's own, never a spec's: derived, or made once. */
const NOT_OVERLAID = new Set(['hasVastApiKey', 'hasOtoyCredentials', 'installId'])

/** The spend cap and its "no cap" flag are one decision, held and released together. */
const SPEND_CAP = ['spendCapPerHour', 'noSpendCap'] as const

export class SettingsOverlay {
  private top: Record<string, unknown> = {}
  private filters: Partial<OfferFilters> = {}

  /** Put `fields` in force for this session, over anything set before. */
  set(fields: OverlayFields): void {
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined || NOT_OVERLAID.has(key)) continue
      if (key === 'offerFilters') {
        for (const [f, v] of Object.entries(value as Partial<OfferFilters>)) {
          if (v !== undefined) (this.filters as Record<string, unknown>)[f] = v
        }
      } else {
        this.top[key] = value
      }
    }
  }

  /**
   * `base` (the saved settings) with the overlay laid over it, as a new
   * object. Offer filters merge one by one, so a filter the spec did not
   * name keeps its saved value.
   */
  apply(base: SettingsPublic): SettingsPublic {
    if (this.isEmpty()) return base
    return {
      ...base,
      ...(this.top as Partial<SettingsPublic>),
      offerFilters: { ...base.offerFilters, ...this.filters }
    }
  }

  /**
   * A person just saved `saved` (as settingsGate saves it): each of those
   * fields is theirs from now on. Returns the fields released, dotted as
   * SettingsFieldError spells them.
   */
  release(saved: OverlayFields): string[] {
    const released: string[] = []
    const drop = (key: string): void => {
      if (key in this.top) {
        delete this.top[key]
        released.push(key)
      }
    }
    for (const key of Object.keys(saved)) {
      if ((saved as Record<string, unknown>)[key] === undefined) continue
      if (key === 'offerFilters') {
        for (const f of Object.keys(saved.offerFilters ?? {})) {
          if (f in this.filters) {
            delete (this.filters as Record<string, unknown>)[f]
            released.push(`offerFilters.${f}`)
          }
        }
      } else if ((SPEND_CAP as readonly string[]).includes(key)) {
        for (const k of SPEND_CAP) drop(k)
      } else {
        drop(key)
      }
    }
    return released
  }

  /** What is in force, for a log line or a test. */
  fields(): OverlayFields {
    const out: OverlayFields = { ...(this.top as OverlayFields) }
    if (Object.keys(this.filters).length > 0) out.offerFilters = { ...this.filters }
    return out
  }

  isEmpty(): boolean {
    return Object.keys(this.top).length === 0 && Object.keys(this.filters).length === 0
  }

  clear(): void {
    this.top = {}
    this.filters = {}
  }
}

/**
 * This process's overlay: the headless spec driver sets it, and settingsGate
 * releases from it. settings.ts's getSettings() is to return
 * `sessionOverlay.apply(saved)`. In a build whose getSettings() does not
 * yet, a spec's settings are not in force, so the spec driver submits
 * nothing and the run ends (app/headless/jobSpec.ts).
 */
export const sessionOverlay = new SettingsOverlay()
