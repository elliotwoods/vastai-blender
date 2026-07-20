/**
 * Parse a .blend file's header locally to learn which Blender version saved
 * it, and resolve that to a concrete release to install on nodes.
 *
 * Header: "BLENDER" + pointer-size char (_ or -) + endian char (v or V) +
 * 3 digits (major*100 + minor, e.g. 405 → 4.5). Blender ≥3.0 saves
 * zstd-compressed files, older versions gzip — both are handled by
 * decompressing just enough of the stream to read the 12-byte header.
 */

import { openSync, readSync, closeSync } from 'fs'
import { gunzipSync, zstdDecompressSync, constants as zconst } from 'zlib'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function readHead(path: string, bytes: number): Buffer {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const n = readSync(fd, buf, 0, bytes, 0)
    return buf.subarray(0, n)
  } finally {
    closeSync(fd)
  }
}

function parseHeader(buf: Buffer): { major: number; minor: number } | null {
  if (buf.length < 12 || buf.subarray(0, 7).toString('latin1') !== 'BLENDER') return null

  let n: number
  const b7 = buf.subarray(7, 9).toString('latin1')
  if (/^\d\d$/.test(b7)) {
    // New format (Blender ≥5.0): "BLENDER" + 2-digit header size + pointer
    // char + 2-digit sub-version + endian char + 4-digit version,
    // e.g. "BLENDER17-01v0501" → 501 → 5.1.
    const headerSize = parseInt(b7, 10)
    if (buf.length < headerSize) return null
    n = parseInt(buf.subarray(headerSize - 4, headerSize).toString('latin1'), 10)
  } else {
    // Legacy format (<5.0): "BLENDER" + pointer char + endian char +
    // 3-digit version, e.g. "BLENDER-v405" → 405 → 4.5.
    n = parseInt(buf.subarray(9, 12).toString('latin1'), 10)
  }
  if (!Number.isFinite(n) || n <= 0) return null
  return { major: Math.floor(n / 100), minor: n % 100 }
}

/** First zstd frame of a Blender file decompresses standalone (seekable format). */
function firstZstdFrame(buf: Buffer): Buffer {
  let end = buf.length
  const next = buf.indexOf(ZSTD_MAGIC, 4)
  if (next > 0) end = next
  return buf.subarray(0, end)
}

/** Returns "4.5"-style major.minor, or null if unreadable. */
export function blendFileVersion(path: string): string | null {
  const head = readHead(path, 4 * 1024 * 1024)
  if (head.length < 12) return null

  let plain: Buffer | null = null
  if (head.subarray(0, 7).toString('latin1') === 'BLENDER') {
    plain = head
  } else if (head[0] === 0x1f && head[1] === 0x8b) {
    try {
      plain = gunzipSync(head, { finishFlush: zconst.Z_SYNC_FLUSH })
    } catch {
      plain = null
    }
  } else if (head.subarray(0, 4).equals(ZSTD_MAGIC)) {
    try {
      plain = zstdDecompressSync(firstZstdFrame(head))
    } catch {
      plain = null
    }
  }
  if (!plain) return null
  const v = parseHeader(plain)
  return v ? `${v.major}.${v.minor}` : null
}

// ---------------------------------------------------------------------------
// Release resolution
// ---------------------------------------------------------------------------

/** Known-good fallbacks when the release listing is unreachable. */
const FALLBACK_PATCH: Record<string, string> = {
  '3.6': '3.6.19',
  '4.2': '4.2.9',
  '4.3': '4.3.2',
  '4.4': '4.4.3',
  '4.5': '4.5.3',
  '5.0': '5.0.1',
  '5.1': '5.1.0'
}

const DEFAULT_SERIES = '4.5'

const listingCache = new Map<string, string>()

/**
 * Resolve "4.5" → newest "4.5.x" from download.blender.org (cached per run),
 * falling back to the pinned map, then to "<series>.0".
 */
export async function resolveBlenderRelease(series: string): Promise<string> {
  const cached = listingCache.get(series)
  if (cached) return cached
  try {
    const res = await fetch(`https://download.blender.org/release/Blender${series}/`, {
      signal: AbortSignal.timeout(10_000)
    })
    if (res.ok) {
      const html = await res.text()
      const re = new RegExp(
        `blender-(${series.replace('.', '\\.')}\\.\\d+)-linux-x64\\.tar\\.xz`,
        'g'
      )
      const versions = new Set<string>()
      for (const m of html.matchAll(re)) versions.add(m[1])
      const sorted = [...versions].sort((a, b) => {
        const pa = Number(a.split('.')[2])
        const pb = Number(b.split('.')[2])
        return pb - pa
      })
      if (sorted.length > 0) {
        listingCache.set(series, sorted[0])
        return sorted[0]
      }
    }
  } catch {
    // offline / listing unreachable — fall through
  }
  const fallback = FALLBACK_PATCH[series] ?? `${series}.0`
  listingCache.set(series, fallback)
  return fallback
}

/**
 * Full resolution for a job: .blend header → series → concrete release,
 * honouring the settings override when set.
 */
export async function resolveJobBlenderVersion(
  blendPath: string,
  override: string | null
): Promise<string> {
  if (override) {
    // Accept both "4.5" (series) and "4.5.3" (exact release).
    return override.split('.').length >= 3 ? override : resolveBlenderRelease(override)
  }
  const series = blendFileVersion(blendPath) ?? DEFAULT_SERIES
  return resolveBlenderRelease(series)
}
