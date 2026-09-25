import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Plan 1.3: this profile's install id, which every rental label carries so
// the reconcile can tell this profile's instances from another install's.
// Made once, kept in settings.json, and never changed by a settings patch.

const paths = vi.hoisted(() => ({ userData: '' }))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? paths.userData : join(paths.userData, name))
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, 'utf-8'),
    decryptString: (b: Buffer) => b.toString('utf-8')
  }
}))

/** settings.ts as a fresh launch finds it: nothing cached. */
async function launch(): Promise<typeof import('./settings')> {
  vi.resetModules()
  return import('./settings')
}

function onDisk(): { public: Record<string, unknown> } {
  return JSON.parse(readFileSync(join(paths.userData, 'settings.json'), 'utf-8')) as {
    public: Record<string, unknown>
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

beforeEach(() => {
  paths.userData = mkdtempSync(join(tmpdir(), 'vr-settings-'))
})
afterEach(() => {
  chmodSync(paths.userData, 0o700)
  rmSync(paths.userData, { recursive: true, force: true })
})

describe('1.3 install id', () => {
  it('is made at the first read, saved, and the same at the next launch', async () => {
    const id = (await launch()).getSettings().installId
    expect(id).toMatch(UUID)
    expect(onDisk().public.installId).toBe(id)

    expect((await launch()).getSettings().installId).toBe(id)
  })

  it('a settings file from before install ids gets one, and keeps the rest', async () => {
    writeFileSync(
      join(paths.userData, 'settings.json'),
      JSON.stringify({ public: { maxActiveNodes: 7 }, secrets: {} })
    )
    const s = (await launch()).getSettings()
    expect(s.installId).toMatch(UUID)
    expect(s.maxActiveNodes).toBe(7)
    expect(onDisk().public).toMatchObject({ installId: s.installId, maxActiveNodes: 7 })
  })

  it('a settings patch cannot change it', async () => {
    const settings = await launch()
    const id = settings.getSettings().installId
    const after = settings.updateSettings({
      installId: 'aaaaaaaa-0000-0000-0000-000000000000',
      maxActiveNodes: 5
    })
    expect(after.installId).toBe(id)
    expect(after.maxActiveNodes).toBe(5)
    expect(onDisk().public.installId).toBe(id)
  })

  it('a file that was read keeps its secrets and the rest when the id is added', async () => {
    const secrets = { vastApiKey: 'ZW5jcnlwdGVkLWtleQ==', otoyUsername: 'dXNlcg==' }
    writeFileSync(
      join(paths.userData, 'settings.json'),
      JSON.stringify({ public: { spendCapPerHour: 6, projectRoot: '/Volumes/r' }, secrets })
    )
    const id = (await launch()).getSettings().installId
    const saved = JSON.parse(readFileSync(join(paths.userData, 'settings.json'), 'utf-8')) as {
      public: Record<string, unknown>
      secrets: unknown
    }
    expect(saved.secrets).toEqual(secrets)
    expect(saved.public).toMatchObject({
      installId: id,
      spendCapPerHour: 6,
      projectRoot: '/Volumes/r'
    })
  })

  // Review of 21be3e7 (major): the id was saved after ANY failed read, so the
  // first read of a launch that met a hand-edited file or a Windows antivirus
  // lock wrote the defaults, secrets {}, over settings.json: the Vast key,
  // the spend cap and the project root gone for good, and a relaunch mid-
  // render left with no key to reach the instances still billing (#13).
  it('a settings.json that does not parse is left exactly as it was; the session still has an id', async () => {
    const file = join(paths.userData, 'settings.json')
    const text = '{ "public": { "maxActiveNodes": 7, }, "secrets": { "vastApiKey": "ZW5j" } '
    writeFileSync(file, text)
    const settings = await launch()
    const id = settings.getSettings().installId
    expect(id).toMatch(UUID)
    expect(settings.getSettings().installId).toBe(id)
    expect(readFileSync(file, 'utf-8')).toBe(text)
  })

  it.skipIf(process.getuid?.() === 0)(
    'a settings.json that cannot be read (a lock, EACCES) is left exactly as it was',
    async () => {
      const file = join(paths.userData, 'settings.json')
      const text = JSON.stringify({
        public: { maxActiveNodes: 7, spendCapPerHour: 6 },
        secrets: { vastApiKey: 'ZW5jcnlwdGVkLWtleQ==' }
      })
      writeFileSync(file, text)
      chmodSync(file, 0o000)
      try {
        const settings = await launch()
        expect(settings.getSettings().installId).toMatch(UUID)
      } finally {
        chmodSync(file, 0o600)
      }
      expect(readFileSync(file, 'utf-8')).toBe(text)
      // The lock gone, the next launch reads it, secrets and all, and saves
      // an id of its own.
      const next = (await launch()).getSettings()
      expect(next).toMatchObject({ maxActiveNodes: 7, spendCapPerHour: 6, hasVastApiKey: true })
      expect(onDisk().public.installId).toBe(next.installId)
    }
  )

  it('a disk that will not take the file still gives the session one id', async () => {
    chmodSync(paths.userData, 0o500)
    const settings = await launch()
    const id = settings.getSettings().installId
    expect(id).toMatch(UUID)
    expect(settings.getSettings().installId).toBe(id)
    expect(existsSync(join(paths.userData, 'settings.json'))).toBe(false)
  })
})
