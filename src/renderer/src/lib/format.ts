/** Formatting helpers — all numerics render in mono via controls.mono. */

export function fmtMoney(x: number): string {
  return `$${x.toFixed(2)}`
}

export function fmtRate(perHour: number): string {
  return `$${perHour.toFixed(3)}/hr`
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
