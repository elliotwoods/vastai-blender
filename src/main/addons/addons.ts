/**
 * Registry of user-provided Blender extension zips. Zips are copied into
 * userData/addons/ and indexed in registry.json; the id/name/version come
 * from the zip's blender_manifest.toml. Fully generic — works with any
 * conformant extension zip (and a sys.path bootstrap fallback for
 * non-conformant ones).
 */

import { createHash, randomUUID } from 'crypto'
import { app } from 'electron'
import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { inflateRawSync } from 'zlib'
import type { AddonInfo } from '../../shared/models'

function addonsDir(): string {
  return join(app.getPath('userData'), 'addons')
}

function registryPath(): string {
  return join(addonsDir(), 'registry.json')
}

function loadRegistry(): AddonInfo[] {
  try {
    return JSON.parse(readFileSync(registryPath(), 'utf-8')) as AddonInfo[]
  } catch {
    return []
  }
}

function saveRegistry(addons: AddonInfo[]): void {
  mkdirSync(addonsDir(), { recursive: true })
  const tmp = `${registryPath()}.tmp`
  writeFileSync(tmp, JSON.stringify(addons, null, 2))
  renameSync(tmp, registryPath())
}

export function listAddons(): AddonInfo[] {
  return loadRegistry()
}

export function getAddon(id: string): AddonInfo | undefined {
  return loadRegistry().find((a) => a.id === id)
}

/**
 * Minimal blender_manifest.toml reader — pulls id/name/version with regexes
 * (the three fields are simple `key = "value"` lines in every conformant
 * manifest; a full TOML parser buys nothing here).
 */
function parseManifestFields(toml: string): { id?: string; name?: string; version?: string } {
  const grab = (key: string): string | undefined => {
    const m = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, 'm').exec(toml)
    return m?.[1]
  }
  return { id: grab('id'), name: grab('name'), version: grab('version') }
}

/**
 * Extract one entry's text from a zip without a zip library: a minimal ZIP
 * central-directory walk (stdlib only, sync — extension zips are small).
 */
function readZipEntry(zipPath: string, entryName: RegExp): string | null {
  const buf = readFileSync(zipPath)
  // End of central directory record
  let eocd = -1
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return null
  const count = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break
    const method = buf.readUInt16LE(offset + 10)
    const compSize = buf.readUInt32LE(offset + 20)
    const nameLen = buf.readUInt16LE(offset + 28)
    const extraLen = buf.readUInt16LE(offset + 30)
    const commentLen = buf.readUInt16LE(offset + 32)
    const localOffset = buf.readUInt32LE(offset + 42)
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf-8')
    if (entryName.test(name)) {
      // Local file header: variable name/extra lengths of its own.
      const lNameLen = buf.readUInt16LE(localOffset + 26)
      const lExtraLen = buf.readUInt16LE(localOffset + 28)
      const dataStart = localOffset + 30 + lNameLen + lExtraLen
      const data = buf.subarray(dataStart, dataStart + compSize)
      return method === 0 ? data.toString('utf-8') : inflateRawSync(data).toString('utf-8')
    }
    offset += 46 + nameLen + extraLen + commentLen
  }
  return null
}

export function registerAddon(zipPath: string): AddonInfo {
  const manifestText = readZipEntry(zipPath, /(^|\/)blender_manifest\.toml$/)
  let id: string
  let name: string
  let version: string
  let mechanism: AddonInfo['mechanism']
  if (manifestText) {
    const f = parseManifestFields(manifestText)
    if (!f.id) throw new Error('blender_manifest.toml has no id field')
    id = f.id
    name = f.name ?? f.id
    version = f.version ?? '0.0.0'
    mechanism = 'install'
  } else {
    // Non-conformant zip: fall back to sys.path bootstrap; id from filename.
    id = basename(zipPath)
      .replace(/\.zip$/i, '')
      .replace(/[^a-zA-Z0-9_]/g, '_')
    name = id
    version = '0.0.0'
    mechanism = 'bootstrap'
  }

  const registry = loadRegistry().filter((a) => a.id !== id)
  mkdirSync(addonsDir(), { recursive: true })
  const localZip = join(addonsDir(), `${id}-${randomUUID().slice(0, 8)}.zip`)
  copyFileSync(zipPath, localZip)
  const zipHash = createHash('sha256').update(readFileSync(localZip)).digest('hex')

  const info: AddonInfo = { id, name, version, zipPath: localZip, zipHash, mechanism }
  registry.push(info)
  saveRegistry(registry)
  return info
}

export function removeAddon(id: string): void {
  const registry = loadRegistry()
  const addon = registry.find((a) => a.id === id)
  if (addon) {
    try {
      rmSync(addon.zipPath, { force: true })
    } catch {
      // best effort
    }
  }
  saveRegistry(registry.filter((a) => a.id !== id))
}
