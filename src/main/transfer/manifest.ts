/**
 * Parse the node agent's manifest.jsonl (the only trusted download source).
 *
 * "Trusted" means the agent lists a file only once it is complete, not that
 * the lines themselves can be believed. The rented machine's host has root on
 * it, and any .blend can run startup scripts there. So every line is checked
 * here, at the trust boundary, against exactly what the agent writes
 * (remote/agent/noderunner.py, remote/encode/encode_preview.py): an entry's
 * `file` becomes a local path under the job's folder, and its sha256 is the
 * only check on the bytes. A line that fails is dropped, and reported in
 * `rejected` so that a dropped frame can be counted as missing.
 */

import type { ClipKind } from '../../shared/models'

export interface ManifestFrame {
  kind: 'frame'
  file: string
  size: number
  /** sha256, lowercase hex */
  sha256: string
  mtime: number
}

/** Browser-decodable preview of one frame (the frame itself is often EXR). */
export interface ManifestThumb {
  kind: 'thumb'
  file: string
  size: number
  sha256: string
  mtime: number
  meta: {
    /** null when the agent couldn't read a frame number from the name */
    frame: number | null
    width: number
  }
}

export interface ManifestClip {
  kind: 'clip'
  file: string
  size: number
  sha256: string
  mtime: number
  meta: {
    kindKey: ClipKind
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

/** A line that named a known kind but failed validation. Nothing of it is fetched. */
export interface ManifestReject {
  kind: ManifestEntry['kind']
  /** The line's `file`, quoted and escaped: safe to put in an alert. */
  file: string
  reason: string
}

export interface ParsedManifest {
  entries: ManifestEntry[]
  rejected: ManifestReject[]
}

/**
 * The only names the agent writes, per kind. Anchored and narrow on purpose.
 * resolveInside (paths.ts) is the backstop against traversal, but a name of
 * this shape cannot climb, cannot be absolute, and cannot carry a control
 * character, a backslash or a drive letter in the first place.
 */
const FILE_PATTERNS: Record<ManifestEntry['kind'], RegExp> = {
  // Whatever Blender printed "Saved:" for under `-o frames/####` (FrameTracker
  // lists it as-is): the zero-padded frame number, then the view suffix of a
  // stereo or multiview scene that saves each view to its own file (Views
  // Format 'Individual': `_L` and `_R` by default, or whatever a view is set
  // to), then the format's extension, which a scene with File Extensions off
  // leaves out. 0042.exr, 0042_L.png, 0042. The suffix may not start with a
  // digit, or it would run on into the frame number, nor hold a dot.
  frame: /^frames\/(\d{1,9})([A-Za-z_-][A-Za-z0-9_-]{0,62})?(?:\.[A-Za-z0-9]{1,8})?$/,
  // Named after the frame's stem (PreviewWorker._one): 0042.jpg, 0042_L.jpg.
  thumb: /^thumbs\/(\d{1,9})([A-Za-z_-][A-Za-z0-9_-]{0,62})?\.jpg$/,
  // <chunkId>_{sdr,hdr,proxy}.mp4 and <chunkId>_live_<runToken>_<NNNN>.mp4.
  clip: /^previews\/[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\.mp4$/
}

/**
 * The frame a frame or thumbnail name is for, and its view suffix ('' for a
 * frame saved as one file): `frames/0042_L.png` is frame 42, view `_L`. Null
 * for any other name.
 */
export function parseFrameName(file: string): { frame: number; view: string } | null {
  const m = FILE_PATTERNS.frame.exec(file) ?? FILE_PATTERNS.thumb.exec(file)
  return m ? { frame: parseInt(m[1], 10), view: m[2] ?? '' } : null
}

const MiB = 1024 ** 2
const GiB = 1024 ** 3

/**
 * Upper bound on a declared size. A download reads up to the declared size
 * before anything can be checked, so without a cap one line could fill the
 * user's disk. Generous: an 8K multilayer EXR with every pass is a few GiB,
 * and a thumbnail is tens of KB.
 */
const MAX_BYTES: Record<ManifestEntry['kind'], number> = {
  frame: 8 * GiB,
  thumb: 64 * MiB,
  clip: 8 * GiB
}

const SHA256 = /^[0-9a-f]{64}$/

/**
 * What follows `previews/<chunkId>_` in each clip the agent writes, by
 * kindKey (encode_preview.py; PreviewWorker's live remux, whose run token is
 * the render's start in epoch seconds). Exhaustive over ClipKind: a new
 * rendition won't compile until it's listed here.
 *
 * FILE_PATTERNS.clip only says what a clip name may look like. This pins it
 * to the chunk being downloaded and to what the clip says it is. A clip named
 * for another chunk, or for the stitched job clip (job_previewSdr.v1.mp4),
 * would overwrite that file and take over its assets row (abs_path is UNIQUE
 * and clips are written INSERT OR REPLACE), and as 'live' the next prune of
 * superseded live clips would then delete it.
 */
const CLIP_NAMES: Record<ClipKind, RegExp> = {
  previewSdr: /^sdr\.mp4$/,
  previewHdr: /^hdr\.mp4$/,
  proxy: /^proxy\.mp4$/,
  live: /^live_\d{1,20}_\d{4,9}\.mp4$/
}

/** Is `file` the name the agent gives this chunk's clip of this kind? */
function isClipName(file: string, kindKey: ClipKind, chunkId: string): boolean {
  const prefix = `previews/${chunkId}_`
  return file.startsWith(prefix) && CLIP_NAMES[kindKey].test(file.slice(prefix.length))
}

const CODECS = new Set(['hevc', 'av1'])

type Json = Record<string, unknown>

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isKind(v: unknown): v is ManifestEntry['kind'] {
  return v === 'frame' || v === 'thumb' || v === 'clip'
}

/** A finite number, at least zero. */
function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0
}

/**
 * A node-supplied value made safe to show: truncated, JSON-quoted, and with
 * everything outside printable ASCII escaped (control characters, and the
 * bidi overrides that could make an alert read as something else).
 */
function printable(v: unknown): string {
  if (typeof v !== 'string') return `<${v === null ? 'null' : typeof v}>`
  const s = v.length > 80 ? `${v.slice(0, 80)}...` : v
  return JSON.stringify(s).replace(
    /[^\x20-\x7e]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
  )
}

/**
 * The entry rebuilt from its validated fields, or the reason it can't be.
 * Rebuilt rather than cast, so nothing the node adds beyond these fields
 * travels any further.
 */
function validate(e: Json, kind: ManifestEntry['kind'], chunkId: string): ManifestEntry | string {
  const { file, size, sha256, mtime } = e
  if (typeof file !== 'string' || !FILE_PATTERNS[kind].test(file)) {
    return 'not a file name the agent writes'
  }
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) return 'bad size'
  if (size > MAX_BYTES[kind]) return `over the ${kind} size cap`
  // Every kind has carried one since the agent first hashed thumbs and clips;
  // without it, the size would be the only check on the bytes.
  if (typeof sha256 !== 'string' || !SHA256.test(sha256)) return 'missing or malformed sha256'
  if (typeof mtime !== 'number' || !Number.isFinite(mtime)) return 'bad mtime'
  const base = { file, size, sha256, mtime }

  if (kind === 'frame') return { kind, ...base }

  const meta = e.meta
  if (!isObject(meta)) return 'missing meta'

  if (kind === 'thumb') {
    // The downloader files a thumbnail under meta.frame. The agent reports the
    // stem's number (null for a view's, which int() cannot read), so anything
    // else would attach it to some other frame.
    const stem = parseFrameName(file)!.frame
    if (meta.frame !== null && meta.frame !== stem) return 'meta.frame does not match the name'
    if (!isCount(meta.width)) return 'bad meta.width'
    return { kind, ...base, meta: { frame: meta.frame === null ? null : stem, width: meta.width } }
  }

  const { kindKey, fps, frames, width, height, codec, hdr } = meta
  if (typeof kindKey !== 'string' || !Object.hasOwn(CLIP_NAMES, kindKey)) {
    return 'unknown meta.kindKey'
  }
  if (meta.file !== file) return 'meta.file does not match file'
  if (!isClipName(file, kindKey as ClipKind, chunkId)) {
    return `not the name of this chunk's ${kindKey} clip`
  }
  if (!isCount(fps) || !isCount(frames) || !isCount(width) || !isCount(height)) {
    return 'bad clip dimensions'
  }
  if (typeof codec !== 'string' || !CODECS.has(codec)) return 'unknown meta.codec'
  if (typeof hdr !== 'boolean') return 'bad meta.hdr'
  return {
    kind,
    ...base,
    meta: {
      kindKey: kindKey as ClipKind,
      file,
      fps,
      frames,
      width,
      height,
      codec: codec as 'hevc' | 'av1',
      hdr
    }
  }
}

/** Parse the manifest of chunk `chunkId`: its clips must be named for it. */
export function parseManifest(text: string, chunkId: string): ParsedManifest {
  const entries: ManifestEntry[] = []
  const rejected: ManifestReject[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    let e: unknown
    try {
      e = JSON.parse(t)
    } catch {
      continue // torn tail line — it will be complete on the next poll
    }
    // A kind this app doesn't know is skipped, not rejected, as it always was.
    if (!isObject(e) || !isKind(e.kind)) continue
    const out = validate(e, e.kind, chunkId)
    if (typeof out === 'string') {
      rejected.push({ kind: e.kind, file: printable(e.file), reason: out })
    } else {
      entries.push(out)
    }
  }
  return { entries, rejected }
}
