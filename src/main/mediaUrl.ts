/**
 * Absolute path → `media://` URL for the renderer.
 *
 * The `media:` protocol handler in index.ts (its URL-to-path step is
 * app/mediaProtocol.ts) serves two forms, each resolved inside its own root,
 * which is what keeps the protocol's traversal guard meaningful:
 *  - media://job/<jobId>/<rel>: one of a job's files, relative to the job's
 *    own jobs.output_dir (plan 1.13). A job keeps the folder it was
 *    submitted under, so its URLs still load after the project root has
 *    changed in Settings. Every file of a job is handed out this way
 *    (jobFileMediaUrl).
 *  - media://project/<rel>: relative to the current project root. For a file
 *    that is no job's, and the form URLs had before 1.13. Made for a job's
 *    file, it pointed nowhere once the root changed, and every earlier job's
 *    previews went blank (#9 #61 #175 #202 #214).
 */

import { relative, sep } from 'path'
import { jobMediaUrl } from './app/mediaProtocol'
import { getSettings } from './settings'

export function toMediaUrl(absPath: string): string {
  const root = getSettings().projectRoot
  return `media://project/${relative(root, absPath).split(sep).join('/')}`
}

/**
 * The URL of `absPath`, one of job `jobId`'s files, where `outputDir` is the
 * job's jobs.output_dir: media://job/<jobId>/<rel>. A path outside the job's
 * folder, which nothing writes, keeps the project form.
 */
export function jobFileMediaUrl(jobId: string, outputDir: string, absPath: string): string {
  return jobMediaUrl(jobId, outputDir, absPath) ?? toMediaUrl(absPath)
}
