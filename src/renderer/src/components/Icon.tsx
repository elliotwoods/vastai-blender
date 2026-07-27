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
  )
} as const

export type IconName = keyof typeof PATHS

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
