/**
 * Which clip to show. Extracted from GalleryScreen, where the same preference
 * order was written inline twice — once for the wall, once for the inspector —
 * and had to be kept in step by hand.
 */

import type { ClipAsset, ClipKind } from '../../../shared/models'

/** Big-view order: best available quality, HDR first when it's wanted. */
const INSPECT_ORDER: ClipKind[] = ['previewHdr', 'previewSdr', 'proxy']
/** Wall order: small and cheap to decode a dozen at a time. */
const WALL_ORDER: ClipKind[] = ['proxy', 'previewSdr', 'previewHdr']

export interface PickOptions {
  chunkId?: string
  /** Prefer the HDR rendition (caller has already checked display capability). */
  preferHdr?: boolean
  /**
   * Prefer the rolling live clip. Only meaningful while a chunk renders — a
   * finished chunk's definitive clips are strictly better.
   */
  preferLive?: boolean
  /** Use the wall's cheap-decode ordering rather than the inspect ordering. */
  wall?: boolean
}

export function pickClip(clips: ClipAsset[], opts: PickOptions = {}): ClipAsset | null {
  const pool = opts.chunkId ? clips.filter((c) => c.chunkId === opts.chunkId) : clips
  if (pool.length === 0) return null

  if (opts.preferLive) {
    const live = pool.find((c) => c.kind === 'live')
    if (live) return live
  }

  // Without an HDR preference, HDR drops to last rather than out — it is still
  // better than showing nothing when it is the only rendition present.
  const base = opts.wall ? WALL_ORDER : INSPECT_ORDER
  const order: ClipKind[] = opts.preferHdr
    ? base
    : [...base.filter((k) => k !== 'previewHdr'), 'previewHdr']

  for (const kind of order) {
    const hit = pool.find((c) => c.kind === kind)
    if (hit) return hit
  }

  // Last resort: a live clip beats showing nothing. The WALL never takes this
  // path — a grid of rolling in-progress clips is noise, and it is also the
  // only place `live` has to be actively excluded now that assets:index
  // (correctly) returns it.
  if (opts.wall) return null
  return pool.find((c) => c.kind === 'live') ?? null
}

/** Distinct chunk ids present in an asset list, in frame order where derivable. */
export function chunkIdsOf(clips: ClipAsset[]): string[] {
  return [...new Set(clips.map((c) => c.chunkId))]
}
