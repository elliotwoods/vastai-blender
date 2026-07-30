/**
 * Turning metered GPU energy into an estimated CO2 figure.
 *
 * Two adjustments stand between "watt-hours nvidia-smi reported" and "kilograms
 * of CO2e", and both are assumptions the UI has to own up to:
 *
 *  1. **Where the machine is.** A kWh in Norway is ~30 gCO2e; the same kWh in
 *     Poland is ~660 — a factor of twenty. vast.ai reports an offer's location,
 *     so nodes rented from now on are costed against their own grid. Anything
 *     without a usable location (every node rented before the column existed)
 *     falls back to the world average, which is the honest thing to do rather
 *     than quietly assuming somewhere clean.
 *  2. **What the meter misses.** `power.draw` is the GPU package only — no host
 *     CPU or RAM, no PSU losses, no cooling. A whole-facility figure is roughly
 *     1.5-2x the card, so the caller supplies an overhead multiplier (the
 *     `co2OverheadFactor` setting).
 *
 * Everything here is pure — no DB, no Electron — so it unit-tests directly.
 */

/**
 * Annual average generation intensity, gCO2e per kWh, rounded to the nearest 10.
 * Figures are ~2023-2024 Ember / IEA country averages; they move a few percent
 * a year and are only ever used for an order-of-magnitude comparison, so
 * precision beyond two significant figures would be false.
 *
 * Covers the countries vast.ai hosts actually appear in. Anything missing falls
 * back to WORLD_AVERAGE rather than guessing from a neighbour.
 */
export const GRID_INTENSITY: Record<string, number> = {
  // Europe — the spread here is the whole reason this table exists
  IS: 30,
  NO: 30,
  SE: 40,
  CH: 50,
  FR: 60,
  FI: 80,
  AT: 160,
  DK: 180,
  BE: 190,
  SK: 200,
  ES: 200,
  PT: 220,
  GB: 240,
  SI: 250,
  HU: 250,
  IT: 330,
  IE: 340,
  RO: 340,
  LT: 350,
  HR: 360,
  LV: 380,
  NL: 380,
  UA: 400,
  RU: 440,
  DE: 460,
  CZ: 560,
  BG: 560,
  GR: 570,
  TR: 590,
  RS: 660,
  EE: 660,
  PL: 660,

  // Americas
  CA: 130,
  BR: 160,
  UY: 170,
  CL: 350,
  US: 380,
  AR: 390,
  CO: 400,
  PE: 420,
  MX: 470,

  // Asia-Pacific
  NZ: 130,
  SG: 400,
  JP: 490,
  KR: 500,
  MY: 590,
  TH: 590,
  VN: 590,
  PH: 620,
  CN: 580,
  TW: 640,
  HK: 700,
  ID: 720,
  IN: 710,
  AU: 550,

  // Middle East / Africa
  IL: 550,
  AE: 560,
  SA: 620,
  QA: 490,
  EG: 460,
  KE: 100,
  NG: 400,
  ZA: 710,

  // Central Asia / Caucasus
  GE: 130,
  KZ: 730,
  UZ: 610
}

/**
 * Global average grid intensity (gCO2e/kWh) — the fallback when a node's
 * location is unknown. Deliberately not optimistic: this is roughly where the
 * world's generation mix sits, so an unknown node is neither flattered nor
 * punished.
 */
export const WORLD_AVERAGE = 475

/**
 * Country names we accept when vast.ai spells one out instead of using a code.
 * Only the ones actually observed plus the obvious multi-word cases — a full
 * ISO name table would be dead weight.
 */
const NAME_TO_CODE: Record<string, string> = {
  'UNITED STATES': 'US',
  'UNITED STATES OF AMERICA': 'US',
  USA: 'US',
  'UNITED KINGDOM': 'GB',
  UK: 'GB',
  'GREAT BRITAIN': 'GB',
  'SOUTH KOREA': 'KR',
  KOREA: 'KR',
  'CZECH REPUBLIC': 'CZ',
  CZECHIA: 'CZ',
  NETHERLANDS: 'NL',
  GERMANY: 'DE',
  FRANCE: 'FR',
  POLAND: 'PL',
  SWEDEN: 'SE',
  NORWAY: 'NO',
  FINLAND: 'FI',
  ICELAND: 'IS',
  ESTONIA: 'EE',
  LATVIA: 'LV',
  LITHUANIA: 'LT',
  UKRAINE: 'UA',
  ROMANIA: 'RO',
  BULGARIA: 'BG',
  SPAIN: 'ES',
  PORTUGAL: 'PT',
  ITALY: 'IT',
  AUSTRIA: 'AT',
  SWITZERLAND: 'CH',
  BELGIUM: 'BE',
  DENMARK: 'DK',
  IRELAND: 'IE',
  CANADA: 'CA',
  MEXICO: 'MX',
  BRAZIL: 'BR',
  CHILE: 'CL',
  CHINA: 'CN',
  TAIWAN: 'TW',
  JAPAN: 'JP',
  INDIA: 'IN',
  SINGAPORE: 'SG',
  AUSTRALIA: 'AU',
  'NEW ZEALAND': 'NZ',
  'SOUTH AFRICA': 'ZA',
  ISRAEL: 'IL',
  TURKEY: 'TR',
  RUSSIA: 'RU',
  KAZAKHSTAN: 'KZ',
  VIETNAM: 'VN',
  THAILAND: 'TH',
  INDONESIA: 'ID'
}

/**
 * Pull an ISO-3166 alpha-2 code out of vast.ai's free-text location.
 *
 * The field is not a fixed shape — observed values include `"Poland, PL"`,
 * `"US"` and `"Quebec, CA"` — but the country code, when present, is always the
 * last comma-separated part. Try that first, then the whole string as a name,
 * then give up (null → world average).
 */
export function normaliseCountry(geo: string | null | undefined): string | null {
  if (!geo) return null
  const parts = geo
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length === 0) return null

  const last = parts[parts.length - 1].toUpperCase()
  if (last.length === 2 && last in GRID_INTENSITY) return last
  if (last in NAME_TO_CODE) return NAME_TO_CODE[last]

  // "Poland" alone, or a name that happens to sit before the code.
  for (const p of parts) {
    const up = p.toUpperCase()
    if (up in NAME_TO_CODE) return NAME_TO_CODE[up]
  }
  return null
}

export interface Intensity {
  /** gCO2e per kWh */
  gPerKwh: number
  /** ISO-3166 alpha-2, or null when the location could not be resolved */
  country: string | null
  /** false = fell back to the world average */
  known: boolean
}

/** Grid intensity for a node's raw vast.ai location string. */
export function intensityFor(geo: string | null | undefined): Intensity {
  const country = normaliseCountry(geo)
  if (country && country in GRID_INTENSITY) {
    return { gPerKwh: GRID_INTENSITY[country], country, known: true }
  }
  return { gPerKwh: WORLD_AVERAGE, country: null, known: false }
}

/**
 * gCO2e for metered GPU energy at a node's location.
 *
 * `overhead` scales the measured GPU draw up to a whole-facility estimate; pass
 * 1 to cost the card alone. Note the displayed Wh figures elsewhere in the app
 * are deliberately NOT scaled — only this estimate is, and the tooltip copy
 * says so.
 */
export function co2Grams(wh: number, geo: string | null | undefined, overhead: number): number {
  if (!(wh > 0)) return 0
  return (wh / 1000) * intensityFor(geo).gPerKwh * overhead
}
