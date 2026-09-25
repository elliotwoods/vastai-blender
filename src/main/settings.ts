/**
 * Settings persistence — a small JSON file in userData with atomic writes,
 * plus OS-encrypted secrets via Electron safeStorage (DPAPI on Windows).
 * Deliberately not electron-store: this is ~all it would do for us, without
 * the ESM/CJS packaging friction.
 */

import { randomUUID } from 'crypto'
import { app, safeStorage } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { OfferFilters, SecretKey, SettingsPublic } from '../shared/models'

interface SettingsFile {
  public: SettingsPublic
  /** base64 of safeStorage-encrypted values */
  secrets: Partial<Record<SecretKey, string>>
}

const DEFAULT_FILTERS: OfferFilters = {
  gpuNames: [],
  maxDphTotal: null,
  minGpuRamGb: 10,
  minInetDownMbps: 100,
  minReliability: 0.95,
  minDiskGb: 40
}

function defaults(): SettingsFile {
  return {
    public: {
      hasVastApiKey: false,
      hasOtoyCredentials: false,
      projectRoot: join(app.getPath('documents'), 'vast-renders'),
      maxActiveNodes: 2,
      spendCapPerHour: 2,
      idleTimeoutMinutes: 5,
      proxyCodec: 'hevc',
      blenderVersionOverride: null,
      offerFilters: DEFAULT_FILTERS,
      sshKeyPath: '',
      concurrentTransfersPerNode: 3,
      thumbnails: true,
      livePreview: 'onDemand',
      livePreviewWidth: 960,
      maxNodeSlots: 0,
      slotsPerGpu: 1,
      eagerFleet: false,
      // ~1.6x GPU draw covers host CPU/RAM/PSU plus a typical datacentre PUE.
      co2OverheadFactor: 1.6
    },
    secrets: {}
  }
}

let cache: SettingsFile | null = null

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function load(): SettingsFile {
  if (cache) return cache
  // Whether what is on disk was read: the file, or its absence (ENOENT, a
  // first launch). Anything else (a file that does not parse, EACCES, EBUSY
  // or EPERM from an antivirus lock, EIO) leaves defaults in memory for the
  // session, and load() must not write them over the file.
  let readOk = true
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), 'utf-8')) as Partial<SettingsFile>
    const d = defaults()
    cache = {
      public: {
        ...d.public,
        ...raw.public,
        offerFilters: { ...DEFAULT_FILTERS, ...raw.public?.offerFilters }
      },
      secrets: raw.secrets ?? {}
    }
  } catch (e) {
    readOk = (e as NodeJS.ErrnoException | null)?.code === 'ENOENT'
    cache = defaults()
  }
  migrateNodeSlots(cache.public)
  // The has* flags are derived, never trusted from disk.
  cache.public.hasVastApiKey = !!cache.secrets.vastApiKey
  cache.public.hasOtoyCredentials = !!cache.secrets.otoyUsername && !!cache.secrets.otoyPassword
  ensureInstallId(cache, readOk)
  return cache
}

/**
 * Plan 1.3: this profile's install id, made the first time settings are
 * read and kept from then on. Every rental label carries its first 8
 * characters (`vastai-blender <install8>:<node8>`), so the reconcile can
 * tell this profile's instances from those of another install or profile on
 * the same Vast account, whose destroy would kill that app's live render.
 *
 * Saved at once, so the next launch labels its rentals with the same id, but
 * only when the file was read, or there was none (`readOk`). After a read
 * that failed, the file on disk is still the user's settings, API key and
 * all, and saving would write this session's defaults over it (#13): the id
 * is kept in memory for the session instead, as it is on a disk that will
 * not take the file. Its rentals are still recognised later: the reconcile
 * matches an instance to its node row by the label the row itself stores.
 */
function ensureInstallId(file: SettingsFile, readOk: boolean): void {
  const id = file.public.installId
  if (typeof id === 'string' && /^[0-9a-f-]{8,}$/.test(id)) return
  file.public.installId = randomUUID()
  if (!readOk) return
  try {
    persist()
  } catch {
    // Kept in memory for this session; see above.
  }
}

/**
 * `nodeSlots` (a literal slot count applied to every node) became
 * `maxNodeSlots` (an upper bound on the per-node auto-judged count).
 *
 * A value above 1 was a deliberate choice to run concurrently, so it carries
 * over as the cap. A persisted 1 was merely the old default and must NOT
 * become `maxNodeSlots: 1` — that would pin every node to a single slot and
 * silently disable node sharing for everyone upgrading.
 */
function migrateNodeSlots(pub: SettingsPublic & { nodeSlots?: number }): void {
  if (pub.nodeSlots == null) return
  if (pub.nodeSlots > 1 && !pub.maxNodeSlots) pub.maxNodeSlots = pub.nodeSlots
  delete pub.nodeSlots
}

function persist(): void {
  const file = settingsPath()
  mkdirSync(app.getPath('userData'), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf-8')
  renameSync(tmp, file)
}

export function getSettings(): SettingsPublic {
  return { ...load().public, offerFilters: { ...load().public.offerFilters } }
}

export function updateSettings(patch: Partial<SettingsPublic>): SettingsPublic {
  const s = load()
  // has* flags are derived from secrets — strip them from inbound patches.
  // So is the install id, which is main's and never changes (plan 1.3): a
  // renderer that sends back the settings it was given cannot rewrite it.
  const rest = { ...patch }
  delete rest.hasVastApiKey
  delete rest.hasOtoyCredentials
  delete rest.installId
  s.public = {
    ...s.public,
    ...rest,
    offerFilters: patch.offerFilters
      ? { ...s.public.offerFilters, ...patch.offerFilters }
      : s.public.offerFilters
  }
  persist()
  return getSettings()
}

export function setSecret(key: SecretKey, value: string): void {
  const s = load()
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS encryption unavailable — cannot store secret')
  }
  s.secrets[key] = safeStorage.encryptString(value).toString('base64')
  s.public.hasVastApiKey = !!s.secrets.vastApiKey
  s.public.hasOtoyCredentials = !!s.secrets.otoyUsername && !!s.secrets.otoyPassword
  persist()
}

/** Main-process only. Returns null when unset. */
export function getSecret(key: SecretKey): string | null {
  const b64 = load().secrets[key]
  if (!b64) return null
  try {
    return safeStorage.decryptString(Buffer.from(b64, 'base64'))
  } catch {
    return null
  }
}
