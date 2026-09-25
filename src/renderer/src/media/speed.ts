/**
 * Preview playback speed: the presets the transport offers, stepping between
 * them, and the remembered choice.
 *
 * Kept out of SpeedControl so the keys (`<` / `>`) and the control share one
 * setter, and so the stepping is testable without React.
 */

import type { ClipSyncController } from './ClipSyncController'

export const SPEED_PRESETS: readonly number[] = [0.25, 0.5, 1, 2, 4]

export const LS_PREVIEW_SPEED = 'vr:preview:speed'

/**
 * The preset `dir` steps from `current`. A rate between presets steps to the
 * neighbouring preset in that direction; the ends hold.
 */
export function stepSpeed(current: number, dir: 1 | -1): number {
  if (dir > 0) {
    return SPEED_PRESETS.find((p) => p > current + 1e-9) ?? SPEED_PRESETS[SPEED_PRESETS.length - 1]
  }
  for (let i = SPEED_PRESETS.length - 1; i >= 0; i--) {
    if (SPEED_PRESETS[i] < current - 1e-9) return SPEED_PRESETS[i]
  }
  return SPEED_PRESETS[0]
}

/** "0.25×", "1×", "4×". */
export function speedLabel(rate: number): string {
  return `${rate}×`
}

/**
 * The remembered speed, or 1× when nothing valid is stored. A view
 * preference: a private window or cleared storage falls back.
 */
export function readStoredSpeed(): number {
  try {
    const v = Number(localStorage.getItem(LS_PREVIEW_SPEED))
    return SPEED_PRESETS.includes(v) ? v : 1
  } catch {
    return 1
  }
}

/** Set the controller's speed and remember it. */
export function applySpeed(controller: ClipSyncController, rate: number): void {
  controller.setRate(rate)
  try {
    localStorage.setItem(LS_PREVIEW_SPEED, String(controller.rate))
  } catch {
    // best-effort persistence
  }
}
