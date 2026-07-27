/**
 * Resource-usage vocabulary shared by the fleet row and the node detail panel.
 * Four numbers describe a render node — %GPU, %VRAM, %CPU, %RAM — and they get
 * the same colour treatment everywhere. (Kept out of the .tsx meter components
 * so fast-refresh keeps working; see react-refresh/only-export-components.)
 */

import { TOKENS } from './theme'

export type Tone = 'normal' | 'warn' | 'danger' | 'idle'

export const TONE_COLOR: Record<Tone, string> = {
  normal: TOKENS.accent,
  warn: TOKENS.warn,
  danger: TOKENS.danger,
  idle: TOKENS.textDisabled
}

/**
 * Colour by headroom: amber when a resource is nearly full, red when it is
 * effectively out (a VRAM/RAM wall is what kills a render), grey when idle.
 *
 * `compute: true` inverts the intent for utilisation meters — a GPU pinned at
 * 99% is exactly what you're paying for, so it stays accent-coloured and only
 * an idle machine is dimmed.
 */
export function usageTone(
  pct: number | null,
  opts: { idleBelow?: number; compute?: boolean } = {}
): Tone {
  if (pct == null) return 'idle'
  if (opts.idleBelow != null && pct < opts.idleBelow) return 'idle'
  if (opts.compute) return 'normal'
  if (pct >= 95) return 'danger'
  if (pct >= 85) return 'warn'
  return 'normal'
}

/** used/total as a 0–100 percentage; null when the total isn't known yet. */
export function pctOf(used: number, total: number): number | null {
  return total > 0 ? Math.max(0, Math.min(100, (used / total) * 100)) : null
}
