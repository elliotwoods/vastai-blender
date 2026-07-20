/**
 * Settings persistence — a small JSON file in userData with atomic writes,
 * plus OS-encrypted secrets via Electron safeStorage (DPAPI on Windows).
 * Deliberately not electron-store: this is ~all it would do for us, without
 * the ESM/CJS packaging friction.
 */

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
      concurrentTransfersPerNode: 3
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
  } catch {
    cache = defaults()
  }
  // The has* flags are derived, never trusted from disk.
  cache.public.hasVastApiKey = !!cache.secrets.vastApiKey
  cache.public.hasOtoyCredentials = !!cache.secrets.otoyUsername && !!cache.secrets.otoyPassword
  return cache
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
  const rest = { ...patch }
  delete rest.hasVastApiKey
  delete rest.hasOtoyCredentials
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
