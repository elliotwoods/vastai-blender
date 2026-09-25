/**
 * Inline SVG icon set — no icon dependency, no font, no sprite sheet. Every
 * glyph is a stroked 24×24 path drawn in `currentColor`, so an icon inherits
 * the colour of the text it sits next to (TOKENS.textFaint, warn, danger…).
 *
 * Usage: `<Icon name="gpu" />` or `<Icon name="temp" size={15} />`.
 */

import type { CSSProperties, ReactElement } from 'react'

const PATHS = {
  gpu: (
    <>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <circle cx="8.5" cy="12" r="2.5" />
      <path d="M14 10h5M14 14h5M6 18v3M18 18v3" />
    </>
  ),
  cpu: (
    <>
      <rect x="5" y="5" width="14" height="14" rx="2" />
      <rect x="9.5" y="9.5" width="5" height="5" />
      <path d="M9 2v3M15 2v3M9 19v3M15 19v3M19 9h3M19 15h3M2 9h3M2 15h3" />
    </>
  ),
  memory: (
    <>
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    </>
  ),
  temp: (
    <>
      <path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </>
  ),
  power: (
    <>
      <path d="M13 2 3 14h9l-1 8 10-12h-9z" />
    </>
  ),
  dollar: (
    <>
      <path d="M12 1.5v21M17 5.5H9.7a3.3 3.3 0 0 0 0 6.5h4.6a3.3 3.3 0 0 1 0 6.5H6" />
    </>
  ),
  battery: (
    <>
      <rect x="1.5" y="7" width="17" height="10" rx="2" />
      <path d="M22 10.5v3M6 10v4M10 10v4" />
    </>
  ),
  cost: (
    <>
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <path d="M2 10h20M6 15h3" />
    </>
  ),
  server: (
    <>
      <rect x="2" y="3" width="20" height="7" rx="2" />
      <rect x="2" y="14" width="20" height="7" rx="2" />
      <path d="M6.5 6.5h.01M6.5 17.5h.01" />
    </>
  ),
  network: (
    <>
      <circle cx="18" cy="5" r="2.5" />
      <circle cx="6" cy="12" r="2.5" />
      <circle cx="18" cy="19" r="2.5" />
      <path d="m8.2 10.8 7.6-4.4M8.2 13.2l7.6 4.4" />
    </>
  ),
  terminal: (
    <>
      <path d="m4 17 6-6-6-6M12 19h8" />
    </>
  ),
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  copy: (
    <>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </>
  ),
  external: (
    <>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <path d="M15 3h6v6M10 14 21 3" />
    </>
  ),
  check: (
    <>
      <path d="m20 6-11 11-5-5" />
    </>
  ),
  cross: (
    <>
      <path d="M18 6 6 18M6 6l12 12" />
    </>
  ),
  question: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.2 9.5a2.8 2.8 0 0 1 5.5.8c0 1.9-2.7 2.4-2.7 4M12 17.5h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  alert: (
    <>
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <path d="M12 9v4M12 17h.01" />
    </>
  ),
  cube: (
    <>
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <path d="m3.3 7 8.7 5 8.7-5M12 22V12" />
    </>
  ),
  // -- grading controls (media/GradePanel) --------------------------------
  /** exposure: sun */
  exposure: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  /** contrast: half-filled circle */
  contrast: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none" />
    </>
  ),
  /** brightness: small sun, no rays below */
  brightness: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3" />
    </>
  ),
  /** saturation: droplet */
  saturation: <path d="M12 3s6 6.4 6 10a6 6 0 0 1-12 0c0-3.6 6-10 6-10z" />,
  /** gamma: a curve */
  gamma: (
    <>
      <path d="M3 21V3M3 21h18" />
      <path d="M3 18C9 18 12 6 21 6" />
    </>
  ),
  /** temperature: thermometer-ish arrows, warm/cool */
  whitebalance: (
    <>
      <circle cx="12" cy="12" r="5" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
      <path d="M12 7a5 5 0 0 1 0 10z" fill="currentColor" stroke="none" />
    </>
  ),
  /** lift: raise-the-floor arrow */
  lift: (
    <>
      <path d="M3 21h18" />
      <path d="M12 17V7M8 11l4-4 4 4" />
    </>
  ),
  /** histogram */
  histogram: <path d="M4 20V12M9 20V6M14 20V9M19 20V14" />,
  layers: (
    <>
      <path d="m12 2 10 5-10 5L2 7z" />
      <path d="m2 17 10 5 10-5M2 12l10 5 10-5" />
    </>
  ),
  activity: (
    <>
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </>
  ),
  chevron: (
    <>
      <path d="m9 6 6 6-6 6" />
    </>
  ),
  list: (
    <>
      <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />
    </>
  ),
  grid: (
    <>
      <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
    </>
  ),
  // -- actions --------------------------------------------------------------
  trash: (
    <>
      <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M5.5 6 6.5 20a1.5 1.5 0 0 0 1.5 1.4h8a1.5 1.5 0 0 0 1.5-1.4L18.5 6M10 11v6M14 11v6" />
    </>
  ),
  /** drag handle: two columns of dots */
  grip: <path d="M9 5h.01M9 12h.01M9 19h.01M15 5h.01M15 12h.01M15 19h.01" strokeWidth={3} />,
  link: (
    <>
      <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
      <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
    </>
  ),
  /** link, broken: the two halves pulled apart, with break ticks */
  unlink: (
    <>
      <path d="m18.8 13.2 1.7-1.7a5 5 0 0 0-7-7l-1.7 1.7" />
      <path d="m5.2 10.8-1.7 1.7a5 5 0 0 0 7 7l1.7-1.7" />
      <path d="M8 2v3M2 8h3M16 22v-3M22 16h-3" />
    </>
  ),
  /** autoscroll: arrow down onto a floor (follow the tail) */
  autoscroll: (
    <>
      <path d="M12 3v12M7 10l5 5 5-5" />
      <path d="M5 20h14" />
    </>
  ),
  /** expand: two corners pulled outward */
  expand: (
    <>
      <path d="M15 3h6v6M9 21H3v-6" />
      <path d="M21 3l-7 7M3 21l7-7" />
    </>
  ),
  /** gauge: speedometer dial */
  gauge: (
    <>
      <path d="M3.5 17a9 9 0 1 1 17 0" />
      <path d="m12 14 4-5" />
      <circle cx="12" cy="14" r="1.2" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  // -- transport (media/TransportBar) -------------------------------------
  // Solid shapes (stroked too, so corners round like the line icons): at
  // 13px an outline triangle reads as a thin wedge. One family, all filled.
  play: <path d="M7 4.5v15l12.5-7.5z" fill="currentColor" />,
  pause: (
    <>
      <rect x="6" y="4.5" width="4" height="15" rx="0.8" fill="currentColor" />
      <rect x="14" y="4.5" width="4" height="15" rx="0.8" fill="currentColor" />
    </>
  ),
  /** skip to start: bar + triangle */
  skipStart: (
    <>
      <path d="M6 5v14" />
      <path d="M19 5v14l-10-7z" fill="currentColor" />
    </>
  ),
  skipEnd: (
    <>
      <path d="M18 5v14" />
      <path d="M5 5v14l10-7z" fill="currentColor" />
    </>
  ),
  /** rewind: two triangles */
  rewind: <path d="M11.5 6v12L3 12zM21 6v12l-8.5-6z" fill="currentColor" />,
  fastForward: <path d="M12.5 6v12L21 12zM3 6v12l8.5-6z" fill="currentColor" />,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>
  )
} as const

export type IconName = keyof typeof PATHS

/** Every icon name, for tests and pickers. */
export const ICON_NAMES = Object.keys(PATHS) as IconName[]

export function Icon({
  name,
  size = 13,
  style
}: {
  name: IconName
  size?: number
  style?: CSSProperties
}): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0, display: 'block', ...style }}
    >
      {PATHS[name]}
    </svg>
  )
}
