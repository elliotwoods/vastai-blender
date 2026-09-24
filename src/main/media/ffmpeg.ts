/**
 * Where the desktop's own ffmpeg is. Only used for lossless remuxing (job clip
 * stitching) — every encode happens on the nodes.
 *
 * ffmpeg-static ships a per-platform binary inside node_modules. In a packaged
 * build that path points into app.asar, which cannot be exec'd, so it is
 * rewritten to the asarUnpack'd copy (see electron-builder.yml). With neither
 * present we fall back to an ffmpeg on PATH, and finally to null — callers
 * treat that as "feature unavailable", never as an error.
 */

import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { promisify } from 'util'

const execFileP = promisify(execFile)

let resolved: Promise<string | null> | null = null

export function ffmpegPath(): Promise<string | null> {
  resolved ??= resolve()
  return resolved
}

async function resolve(): Promise<string | null> {
  try {
    const mod = (await import('ffmpeg-static')) as { default?: string | null }
    const p = mod.default?.replace('app.asar', 'app.asar.unpacked') ?? null
    if (p && existsSync(p)) return p
  } catch {
    // not installed for this platform — fall through to PATH
  }
  try {
    await execFileP('ffmpeg', ['-version'], { timeout: 5000 })
    return 'ffmpeg'
  } catch {
    return null
  }
}

/** Run ffmpeg with args; rejects with its stderr tail on failure. */
export async function runFfmpeg(bin: string, args: string[]): Promise<void> {
  try {
    await execFileP(bin, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024
    })
  } catch (e) {
    const err = e as Error & { stderr?: string }
    throw new Error(`ffmpeg failed: ${(err.stderr ?? err.message).trim().slice(-400)}`)
  }
}
