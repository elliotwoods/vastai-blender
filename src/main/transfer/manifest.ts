/** Parse the node agent's manifest.jsonl (the only trusted download source). */

export interface ManifestFrame {
  kind: 'frame'
  file: string
  size: number
  /** sha256 hex; absent only in legacy manifests (then size-only verify). */
  sha256?: string
  mtime: number
}

/** Browser-decodable preview of one frame (the frame itself is often EXR). */
export interface ManifestThumb {
  kind: 'thumb'
  file: string
  size: number
  sha256?: string
  mtime: number
  meta: {
    /** null when the filename wasn't a plain frame number */
    frame: number | null
    width: number
  }
}

export interface ManifestClip {
  kind: 'clip'
  file: string
  size: number
  sha256?: string
  mtime: number
  meta: {
    kindKey: 'previewSdr' | 'previewHdr' | 'proxy' | 'live'
    file: string
    fps: number
    frames: number
    width: number
    height: number
    codec: 'hevc' | 'av1'
    hdr: boolean
  }
}

export type ManifestEntry = ManifestFrame | ManifestThumb | ManifestClip

const KINDS = new Set(['frame', 'thumb', 'clip'])

export function parseManifest(text: string): ManifestEntry[] {
  const entries: ManifestEntry[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const e = JSON.parse(t) as ManifestEntry
      if (KINDS.has(e.kind) && e.file && e.size > 0) entries.push(e)
    } catch {
      // ignore torn tail line — it will be complete on the next poll
    }
  }
  return entries
}
