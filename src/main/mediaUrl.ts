/**
 * Absolute path → `media://` URL for the renderer.
 *
 * The `media:` protocol handler in index.ts serves `media://project/<rel>` from
 * the configured project root, so everything the UI displays is expressed
 * relative to that root rather than as a raw path — which is also what keeps
 * the protocol's traversal guard meaningful.
 */

import { relative, sep } from 'path'
import { getSettings } from './settings'

export function toMediaUrl(absPath: string): string {
  const root = getSettings().projectRoot
  return `media://project/${relative(root, absPath).split(sep).join('/')}`
}
