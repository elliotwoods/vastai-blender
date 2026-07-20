/**
 * Named `var(--token)` strings for the semantic tokens in styles/tokens.css.
 * Use these in the inline-style factories so a typo is a compile error and a
 * rename is one edit. The app is dark-only — no theme switching machinery.
 */

export const TOKENS = {
  // Surfaces / structure
  surface: 'var(--surface)',
  surfaceRaised: 'var(--surface-raised)',
  surfaceOverlay: 'var(--surface-overlay)',
  surfaceDisabled: 'var(--surface-disabled)',
  border: 'var(--border)',
  borderStrong: 'var(--border-strong)',
  // Text
  text: 'var(--text)',
  textSecondary: 'var(--text-secondary)',
  textMuted: 'var(--text-muted)',
  textFaint: 'var(--text-faint)',
  textDisabled: 'var(--text-disabled)',
  textOnAccent: 'var(--text-on-accent)',
  // Accent
  accent: 'var(--accent)',
  accentHover: 'var(--accent-hover)',
  accentFg: 'var(--accent-fg)',
  accentSoftBg: 'var(--accent-soft-bg)',
  accentSoftBorder: 'var(--accent-soft-border)',
  accentRing: 'var(--accent-ring)',
  // Feedback
  danger: 'var(--danger)',
  dangerBg: 'var(--danger-bg)',
  dangerBorder: 'var(--danger-border)',
  dangerStrong: 'var(--danger-strong)',
  warn: 'var(--warn)',
  warnSoftBg: 'var(--warn-soft-bg)',
  warnSoftBorder: 'var(--warn-soft-border)',
  warnSoftText: 'var(--warn-soft-text)',
  highlightBg: 'var(--highlight-bg)',
  // Media / transport
  playhead: 'var(--playhead)',
  rulerTick: 'var(--ruler-tick)',
  rulerLabel: 'var(--ruler-label)',
  // Shadows
  shadowPanel: 'var(--shadow-panel)',
  shadowPopover: 'var(--shadow-popover)',
  shadowFab: 'var(--shadow-fab)'
} as const

/** Non-color primitives (type / spacing / radius / elevation). */
export const SCALE = {
  fontSans: 'var(--font-sans)',
  fontMono: 'var(--font-mono)',
  text2xs: 'var(--text-2xs)',
  textXs: 'var(--text-xs)',
  textSm: 'var(--text-sm)',
  textMd: 'var(--text-md)',
  textLg: 'var(--text-lg)',
  textXl: 'var(--text-xl)',
  leadingTight: 'var(--leading-tight)',
  leadingNormal: 'var(--leading-normal)',
  weightRegular: 'var(--weight-regular)',
  weightMedium: 'var(--weight-medium)',
  weightSemibold: 'var(--weight-semibold)',
  weightBold: 'var(--weight-bold)',
  space1: 'var(--space-1)',
  space2: 'var(--space-2)',
  space3: 'var(--space-3)',
  space4: 'var(--space-4)',
  space5: 'var(--space-5)',
  space6: 'var(--space-6)',
  radiusSm: 'var(--radius-sm)',
  radiusMd: 'var(--radius-md)',
  radiusLg: 'var(--radius-lg)',
  radiusPill: 'var(--radius-pill)',
  elevation1: 'var(--elevation-1)',
  elevation2: 'var(--elevation-2)'
} as const

/**
 * Status tone → CSS variable triple, used by statusDot / chunk cells / rows.
 * Keep the mapping semantic (queued/running/done/error/dead) rather than
 * per-entity so nodes, jobs and chunks all share one palette.
 */
export type StatusTone = 'queued' | 'running' | 'done' | 'error' | 'dead'

export const STATUS_VARS: Record<StatusTone, { fill: string; border: string; text: string }> = {
  queued: {
    fill: 'var(--status-queued-fill)',
    border: 'var(--status-queued-border)',
    text: 'var(--status-queued-text)'
  },
  running: {
    fill: 'var(--status-running-fill)',
    border: 'var(--status-running-border)',
    text: 'var(--status-running-text)'
  },
  done: {
    fill: 'var(--status-done-fill)',
    border: 'var(--status-done-border)',
    text: 'var(--status-done-text)'
  },
  error: {
    fill: 'var(--status-error-fill)',
    border: 'var(--status-error-border)',
    text: 'var(--status-error-text)'
  },
  dead: {
    fill: 'var(--status-dead-fill)',
    border: 'var(--status-dead-border)',
    text: 'var(--status-dead-text)'
  }
}
