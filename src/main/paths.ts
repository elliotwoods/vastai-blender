/**
 * Containment for paths named by something outside the app's control.
 *
 * Two sources name local files by a path relative to a root the app owns:
 *  - a rented node's manifest.jsonl (`frames/0042.exr`, landing under the
 *    job's local folder). The node writes those lines, and so can its host
 *    (root on the box) and any .blend startup script, so a bare
 *    `join(jobDir, entry.file)` turns `../../Library/LaunchAgents/x.plist`
 *    into a file written anywhere the user can write;
 *  - the renderer's media:// URLs, relative to the project root.
 *
 * Both go through resolveInside, which hands back an absolute path only when
 * it is strictly inside the root, and null for anything else. It works on the
 * strings alone, with no realpath: everything under these roots is created by
 * the app, so there are no symlinks in them to follow, and a check that needed
 * the disk could not vet a file that does not exist yet (every download).
 */

import * as nodePath from 'path'
import type { PlatformPath } from 'path'

/** Device names Win32 opens from any directory, whatever the extension. */
const WIN_DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)$/i

/**
 * `root` joined with `rel`, or null unless the result is strictly inside
 * `root`. `rel` is a '/'-separated relative path, as a manifest line or a URL
 * carries one. Refused outright, before any resolving:
 *  - control characters (NUL truncates the path at the syscall; a newline
 *    splits it wherever it is later written one per line, as in ffmpeg's
 *    concat list);
 *  - backslashes, on every platform. Nothing the app accepts spells a path
 *    with them, so one is either a Windows separator smuggling a traversal
 *    past the '..' check (`..\..\x`) or a POSIX filename character that would
 *    become one if the project folder is later opened on Windows;
 *  - absolute paths in either convention: `/x`, `//server/share`, `C:\x` and
 *    the drive-relative `C:x`;
 *  - any `..` segment, even one that would stay inside.
 * On Windows also: `:` past the drive (an alternate data stream), a segment
 * ending in a dot or space (Win32 strips those, so `.. ` can come out as
 * `..`), and device names such as CON or NUL.1.
 *
 * `.` and empty segments are harmless and simply normalised away. The final
 * prefix check (with a trailing separator, or `C:\renders` would also admit
 * `C:\renders-old`) holds even if one of the rules above were missed.
 *
 * `path` is the platform's path module; tests pass `path.win32` to exercise
 * the Windows rules on any host.
 */
export function resolveInside(
  root: string,
  rel: string,
  path: PlatformPath = nodePath
): string | null {
  if (typeof rel !== 'string' || rel === '') return null
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  if (/[\x00-\x1f\x7f]/.test(rel)) return null
  if (rel.includes('\\')) return null
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || path.isAbsolute(rel)) return null
  const segments = rel.split('/')
  if (segments.includes('..')) return null
  if (path.sep === '\\') {
    for (const s of segments) {
      if (s === '' || s === '.') continue
      if (s.includes(':') || /[. ]$/.test(s)) return null
      if (WIN_DEVICE.test(s.split('.')[0].trimEnd())) return null
    }
  }
  const base = path.resolve(root)
  const abs = path.resolve(base, rel)
  const guard = base.endsWith(path.sep) ? base : base + path.sep
  return abs.startsWith(guard) ? abs : null
}

/**
 * True when the absolute path `absPath` is strictly inside `root`, by the same
 * rules as resolveInside. For paths already stored as absolute (the DB's
 * assets.abs_path and frames.local_path, built from node-supplied names)
 * before they are deleted or handed to another program.
 */
export function isInside(root: string, absPath: string, path: PlatformPath = nodePath): boolean {
  if (typeof absPath !== 'string' || absPath === '') return false
  const rel = path.relative(path.resolve(root), path.resolve(absPath))
  // relative() speaks the platform's separator; resolveInside speaks '/'.
  return resolveInside(root, rel.split(path.sep).join('/'), path) !== null
}
