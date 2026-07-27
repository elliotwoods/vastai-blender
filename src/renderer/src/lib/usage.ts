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
 */
export function usageTone(pct: number | null, opts: { idleBelow?: number } = {}): Tone {
  if (pct == null) return 'idle'
  if (pct >= 95) return 'danger'
  if (pct >= 85) return 'warn'
  if (opts.idleBelow != null && pct < opts.idleBelow) return 'idle'
  return 'normal'
}

/** used/total as a 0–100 percentage; null when the total isn't known yet. */
export function pctOf(used: number, total: number): number | null {
  return total > 0 ? Math.max(0, Math.min(100, (used / total) * 100)) : null
}
