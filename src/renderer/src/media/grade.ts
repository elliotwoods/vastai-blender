/** Exposure/grade model: applied live as a CSS filter on SDR video. */

export interface Grade {
  contrast: number
  brightness: number
  saturate: number
  lift: number
}

export const GRADE_PRESETS: Record<string, Grade> = {
  neutral: { contrast: 1.0, brightness: 1.0, saturate: 1.0, lift: 0.0 },
  punchy: { contrast: 1.35, brightness: 0.96, saturate: 1.1, lift: 0.0 },
  flat: { contrast: 1.0, brightness: 1.0, saturate: 1.0, lift: 0.0 },
  high: { contrast: 1.6, brightness: 0.9, saturate: 1.25, lift: 0.0 },
  mono: { contrast: 1.35, brightness: 0.98, saturate: 0.0, lift: 0.02 }
}

export const DEFAULT_GRADE: Grade = GRADE_PRESETS.neutral

export function gradeToFilter(g: Grade): string {
  // lift approximated by folding into brightness.
  return `contrast(${g.contrast}) brightness(${g.brightness + g.lift}) saturate(${g.saturate})`
}

export function isNeutral(g: Grade): boolean {
  return g.contrast === 1 && g.brightness === 1 && g.saturate === 1 && g.lift === 0
}
