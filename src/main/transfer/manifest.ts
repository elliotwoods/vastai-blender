/** Parse the node agent's manifest.jsonl (the only trusted download source). */

export interface ManifestFrame {
  kind: 'frame'
  file: string
  size: number
  /** sha256 hex; absent only in legacy manifests (then size-only verify). */
  sha256?: string
  mtime: number
}

export interface ManifestClip {
  kind: 'clip'
  file: string
  size: number
  sha256?: string
  mtime: number
  meta: {
    kindKey: 'previewSdr' | 'previewHdr' | 'proxy'
    file: string
    fps: number
    frames: number
    width: number
    height: number
    codec: 'hevc' | 'av1'
    hdr: boolean
  }
}

export type ManifestEntry = ManifestFrame | ManifestClip

export function parseManifest(text: string): ManifestEntry[] {
  const entries: ManifestEntry[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const e = JSON.parse(t) as ManifestEntry
      if ((e.kind === 'frame' || e.kind === 'clip') && e.file && e.size > 0) entries.push(e)
    } catch {
      // ignore torn tail line — it will be complete on the next poll
    }
  }
  return entries
}
