/** Formatting helpers — all numerics render in mono via controls.mono. */

export function fmtMoney(x: number): string {
  return `$${x.toFixed(2)}`
}

export function fmtRate(perHour: number): string {
  return `$${perHour.toFixed(3)}/hr`
}

/** Instantaneous power draw. */
export function fmtWatts(w: number): string {
  return w >= 1000 ? `${(w / 1000).toFixed(2)} kW` : `${w.toFixed(0)} W`
}

/** Accumulated energy — Wh below a kilowatt-hour, kWh above. */
export function fmtEnergy(wh: number): string {
  return wh >= 1000 ? `${(wh / 1000).toFixed(2)} kWh` : `${wh.toFixed(0)} Wh`
}

/** Estimated emissions — grams below a kilo, kg to a tonne, then tonnes. */
export function fmtCo2(grams: number): string {
  if (grams >= 1_000_000) return `${(grams / 1_000_000).toFixed(2)} t CO₂e`
  if (grams >= 1000) return `${(grams / 1000).toFixed(2)} kg CO₂e`
  return `${grams.toFixed(0)} g CO₂e`
}

export function fmtFrames(done: number, total: number): string {
  return `${done.toLocaleString()} / ${total.toLocaleString()}`
}

export function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h > 0) return `${h}h ${m.toString().padStart(2, '0')}m`
  return `${m}m ${(s % 60).toString().padStart(2, '0')}s`
}

export function fmtBytes(n: number): string {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(2)} GB`
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(0)} KB`
  return `${n} B`
}

export function fmtTimeAgo(epochMs: number): string {
  const d = Date.now() - epochMs
  if (d < 60_000) return 'just now'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`
  return `${Math.floor(d / 86_400_000)}d ago`
}

export function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(i + 1) : p
}

/**
 * A length of time, as short as it can be while still reading at a glance:
 * "45s", "3m 20s", "2h 05m", "1d 3h". Two units at most, the second padded
 * where it sits in a clock-like pair, so a column of them lines up in mono.
 * Negative and non-finite spans read as "0s". fmtDuration stays as it is
 * for the places that want minutes and seconds always.
 */
export function fmtSpan(ms: number): string {
  const s = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${(s % 60).toString().padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${(m % 60).toString().padStart(2, '0')}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function hhmm(d: Date): string {
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

/** Whole calendar days from `a`'s local day to `b`'s (DST-safe). */
function calendarDays(a: Date, b: Date): number {
  const da = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())
  const db = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate())
  return Math.round((db - da) / 86_400_000)
}

/**
 * A moment near `now`, in the local time zone and on a 24-hour clock:
 * "14:32" on the same day, "Tue 14:32" within a week either side, else a
 * short date, "3 Oct" (with the year when it is not this one). For ETAs
 * and for when a job finished. Written out by hand rather than through
 * Intl so it reads the same on every machine.
 */
export function fmtEta(etaAt: number, now: number): string {
  const d = new Date(etaAt)
  const n = new Date(now)
  const days = calendarDays(n, d)
  if (days === 0) return hhmm(d)
  if (Math.abs(days) < 7) return `${WEEKDAYS[d.getDay()]} ${hhmm(d)}`
  const date = `${d.getDate()} ${MONTHS[d.getMonth()]}`
  return d.getFullYear() === n.getFullYear() ? date : `${date} ${d.getFullYear()}`
}

/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th … 21st. */
export function ordinal(n: number): string {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return `${n}th`
  switch (n % 10) {
    case 1:
      return `${n}st`
    case 2:
      return `${n}nd`
    case 3:
      return `${n}rd`
    default:
      return `${n}th`
  }
}

/** A sampling stride in words: "every frame", "every 2nd frame", "every 12th frame". */
export function fmtStride(n: number): string {
  return n <= 1 ? 'every frame' : `every ${ordinal(Math.round(n))} frame`
}
