/**
 * What the main window may hand to the OS or navigate to.
 *
 * The renderer decodes clips and thumbnails made on rented machines, and it
 * asks main to open URLs and local paths on its behalf. If it is ever
 * compromised (a crafted clip meeting a media-decoder bug), or simply handed a
 * bad path by a node, main is the last place such a request can be refused:
 * `shell.openExternal` launches whatever protocol handler a URL names, and
 * `shell.openPath` runs an executable on Windows and launches a `.app` on
 * macOS. So every one of those goes through a rule here first.
 *
 * Pure functions with no Electron import (the disk is only read through an
 * injectable stat), so the rules are unit-tested on any host.
 */

import { lstatSync, statSync } from 'fs'
import * as nodePath from 'path'
import type { PlatformPath } from 'path'
import { fileURLToPath } from 'url'
import { isInside } from '../paths'

/**
 * The URL to give `shell.openExternal`, or null to refuse. Only http(s): any
 * other scheme (file:, smb:, a custom protocol some installed app registered)
 * hands the string to a local program rather than a browser. The URL comes
 * back re-serialised, so the OS parses exactly what was checked here.
 */
export function externalUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
}

/**
 * The renderer's own document: the dev server's page under `electron-vite
 * dev`, or the built index.html on disk.
 */
export type AppPage = { url: string } | { file: string }

/**
 * True when navigating to `target` just reloads the app's own page. The app
 * never navigates: it is one page that routes in-page (query strings such as
 * `?screen=` included, which is why only origin and path are compared). So
 * anything else is either a mistake or someone else's page, and the preload
 * would hand that page `window.api` and with it the fleet.
 */
export function isAppPage(target: string, page: AppPage, path: PlatformPath = nodePath): boolean {
  let url: URL
  try {
    url = new URL(target)
  } catch {
    return false
  }
  if ('file' in page) {
    if (url.protocol !== 'file:') return false
    // Compared as paths, not URL strings: Electron's loadFile and Node's
    // pathToFileURL need not percent-encode an install path the same way,
    // and Windows paths compare case-insensitively (path.win32.relative).
    let file: string
    try {
      file = fileURLToPath(url, { windows: path.sep === '\\' })
    } catch {
      return false
    }
    return path.relative(path.resolve(page.file), path.resolve(file)) === ''
  }
  let own: URL
  try {
    own = new URL(page.url)
  } catch {
    return false
  }
  return url.origin === own.origin && url.pathname === own.pathname
}

/** What is on disk at a path, as far as opening it is concerned. */
export type PathKind = 'dir' | 'file' | 'link' | 'other' | 'missing'

/**
 * `abs`'s kind on disk. `follow` stats through a symlink; otherwise a symlink
 * is reported as one, since its name says nothing about what it points at.
 */
export function diskKind(abs: string, follow: boolean): PathKind {
  try {
    const s = follow ? statSync(abs) : lstatSync(abs)
    if (s.isSymbolicLink()) return 'link'
    if (s.isDirectory()) return 'dir'
    if (s.isFile()) return 'file'
    return 'other'
  } catch {
    return 'missing'
  }
}

/**
 * Files that open in a viewer rather than run: every still format Blender can
 * write a frame in (the blend picks it, so `frames/` holds any of these), and
 * the clip containers. Anything else inside the project, a `.exe` or `.bat`
 * or `.command` a node smuggled in under a frame's name, is only revealed.
 */
const VIEWABLE_FILES = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.exr',
  '.tif',
  '.tiff',
  '.tga',
  '.bmp',
  '.hdr',
  '.webp',
  '.jp2',
  '.j2c',
  '.dpx',
  '.cin',
  '.sgi',
  '.rgb',
  '.bw',
  '.mp4',
  '.m4v',
  '.mov',
  '.webm',
  '.mkv',
  '.avi'
])

/**
 * Directories macOS does not open as folders: "opening" one of these bundles
 * launches or installs the code inside it. No folder the app makes is named
 * like this; a project root pointed at /Applications/X.app would be.
 */
const CODE_BUNDLES = new Set([
  '.app',
  '.appex',
  '.prefpane',
  '.saver',
  '.pkg',
  '.mpkg',
  '.workflow',
  '.action',
  '.qlgenerator',
  '.mdimporter',
  '.plugin',
  '.bundle',
  '.kext',
  '.systemextension'
])

export type OpenPathVerdict =
  | { action: 'open'; path: string }
  | { action: 'reveal'; path: string }
  | { action: 'refuse'; reason: string }

/**
 * What `shell:openPath` does with `raw`, given the folders it may open things
 * in (the project root and the jobs' output folders):
 *  - open: a folder, or a viewable image or clip, inside one of the roots (or
 *    a root itself, which is what "Open output folder" asks for);
 *  - reveal: anything else inside a root. Selecting it in Explorer/Finder
 *    shows the user the file without running it;
 *  - refuse: a path outside every root, or one that does not exist.
 *
 * A root is stat'ed through a symlink (a project folder moved to another
 * drive and linked back is ordinary); anything inside one is not, because the
 * app writes only plain files and folders there.
 */
export function openPathVerdict(
  raw: unknown,
  roots: readonly string[],
  kindOf: (abs: string, follow: boolean) => PathKind = diskKind,
  path: PlatformPath = nodePath
): OpenPathVerdict {
  if (typeof raw !== 'string' || raw === '' || !path.isAbsolute(raw)) {
    return { action: 'refuse', reason: 'not an absolute path' }
  }
  const abs = path.resolve(raw)
  const usable = roots.filter((r) => typeof r === 'string' && r !== '' && path.isAbsolute(r))
  const isRoot = usable.some((r) => path.relative(path.resolve(r), abs) === '')
  if (!isRoot && !usable.some((r) => isInside(r, abs, path))) {
    return { action: 'refuse', reason: 'outside the project and job folders' }
  }
  const ext = path.extname(abs).toLowerCase()
  switch (kindOf(abs, isRoot)) {
    case 'missing':
      return { action: 'refuse', reason: 'no such file or folder' }
    case 'dir':
      return CODE_BUNDLES.has(ext) ? { action: 'reveal', path: abs } : { action: 'open', path: abs }
    case 'file':
      return VIEWABLE_FILES.has(ext)
        ? { action: 'open', path: abs }
        : { action: 'reveal', path: abs }
    default:
      return { action: 'reveal', path: abs }
  }
}

/**
 * The path to give `shell.showItemInFolder` for `shell:showItemInFolder`, or
 * null to refuse. Revealing runs nothing, but Explorer does open the folder:
 * for a UNC path (`\\host\share\x`) that is an SMB connection to the host,
 * which can hand it the user's NTLM hash. So only what the app shows the user
 * is revealed: one of `places`, or anything inside one. The places are the
 * folders shell:openPath opens things in plus the files the app names (a
 * job's .blend, an addon's zip, the SSH key). One may be a UNC path the user
 * chose, a .blend on a NAS; the renderer cannot add another.
 */
export function revealPath(
  raw: unknown,
  places: readonly string[],
  path: PlatformPath = nodePath
): string | null {
  if (typeof raw !== 'string' || raw === '' || !path.isAbsolute(raw)) return null
  const abs = path.resolve(raw)
  const known = places.some(
    (p) =>
      typeof p === 'string' &&
      p !== '' &&
      path.isAbsolute(p) &&
      (path.relative(path.resolve(p), abs) === '' || isInside(p, abs, path))
  )
  return known ? abs : null
}
