/**
 * Which local file a media:// URL names (index.ts serves it, with ranges).
 *
 * Two forms:
 *  - media://job/<jobId>/<rel>: a file of one job, relative to that job's
 *    own jobs.output_dir (plan 1.13). A job's folder is fixed when it is
 *    submitted, under the project root of that moment. URLs relative to the
 *    current root (media://project/<rel>) broke every earlier job's
 *    previews once the root was changed in Settings: `relative()` from the
 *    new root gave `../old/...`, which the URL parser collapses, and on
 *    Windows another drive gave an absolute `D:\...` (#9 #61 #175 #202
 *    #214). A job's URL names the job, and survives any root change.
 *  - media://<root>/<rel> for the fixed roots index.ts names: `project`
 *    (the current project root; URLs handed out before 1.13 still use it)
 *    and `fixtures`.
 *
 * Every path goes through resolveInside, so a URL, from a renderer or from a
 * file name a node chose, can name nothing outside its root. Each segment
 * is percent-decoded on its own, after the URL parser has already applied
 * any literal or encoded `..` (it can then only move between jobs, each
 * looked up in the database); an encoded slash decodes into a separator
 * that resolveInside then judges, `..` included.
 */

import * as nodePath from 'path'
import type { PlatformPath } from 'path'
import { resolveInside } from '../paths'

/** The file a media:// URL names, or the status to answer instead. */
export type MediaTarget = { abs: string } | { status: 400 | 403 | 404; reason: string }

export interface MediaPlaces {
  /** Fixed roots by host (fixtures, project). */
  roots: Record<string, string>
  /** A job's output folder (jobs.output_dir), or null when there is no such job. */
  jobDir(jobId: string): string | null
}

/** The host of media://job/<jobId>/<rel>. Never a fixed root's name. */
export const JOB_HOST = 'job'

/**
 * Resolve a media:// URL to a file inside its root (see the header). `path`
 * is the platform's path module; tests pass `path.win32`.
 */
export function resolveMediaUrl(
  url: string,
  places: MediaPlaces,
  path: PlatformPath = nodePath
): MediaTarget {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { status: 400, reason: 'not a URL' }
  }
  // Chromium lowercases a standard scheme's host; Node's parser does not.
  const host = parsed.host.toLowerCase()
  let segments: string[]
  try {
    segments = parsed.pathname
      .split('/')
      .filter((s) => s !== '')
      .map((s) => decodeURIComponent(s))
  } catch {
    return { status: 400, reason: 'malformed escape in the path' }
  }

  let root: string | null
  if (host === JOB_HOST) {
    const jobId = segments.shift()
    if (!jobId) return { status: 404, reason: 'no job named' }
    root = places.jobDir(jobId)
    if (root == null) return { status: 404, reason: 'unknown job' }
  } else {
    root = Object.hasOwn(places.roots, host) ? places.roots[host] : null
    if (root == null) return { status: 404, reason: 'unknown media root' }
  }
  const abs = resolveInside(root, segments.join('/'), path)
  return abs ? { abs } : { status: 403, reason: 'forbidden' }
}

/**
 * The media://job URL of `absPath`, a file inside `outputDir`, the job's
 * jobs.output_dir: what resolveMediaUrl turns back into `absPath`. Null for
 * a path outside the job's folder, which no job URL can name. Each segment
 * is percent-encoded, so a `%`, `#` or `?` in a file name survives.
 */
export function jobMediaUrl(
  jobId: string,
  outputDir: string,
  absPath: string,
  path: PlatformPath = nodePath
): string | null {
  const rel = path.relative(path.resolve(outputDir), path.resolve(absPath))
  const segments = rel.split(path.sep)
  if (rel === '' || path.isAbsolute(rel) || segments.includes('..')) return null
  return (
    `media://${JOB_HOST}/${encodeURIComponent(jobId)}/` +
    segments.map((s) => encodeURIComponent(s)).join('/')
  )
}
