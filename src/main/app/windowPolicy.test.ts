import { mkdirSync, writeFileSync } from 'fs'
import { dirname, join, posix, resolve, win32 } from 'path'
import { pathToFileURL } from 'url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setup, type App, type World } from '../test/harness'
import {
  externalUrl,
  isAppPage,
  openPathVerdict,
  revealPath,
  type OpenPathVerdict,
  type PathKind
} from './windowPolicy'

describe('externalUrl', () => {
  it.each([
    ['https://cloud.vast.ai/billing/', 'https://cloud.vast.ai/billing/'],
    ['http://example.com', 'http://example.com/'],
    ['HTTPS://Cloud.Vast.AI/instances/', 'https://cloud.vast.ai/instances/']
  ])('passes http(s), re-serialised: %j', (raw, href) => {
    expect(externalUrl(raw)).toBe(href)
  })

  it.each([
    ['file:///C:/Windows/System32/calc.exe'],
    ['file:///Applications/Calculator.app'],
    ['smb://attacker/share/x.exe'],
    ['ms-msdt:/id PCWDiagnostic'],
    ['vscode://file/etc/passwd'],
    ['javascript:alert(1)'],
    ['data:text/html,<script>1</script>'],
    ['//cloud.vast.ai/'],
    ['cloud.vast.ai'],
    [''],
    [42],
    [null]
  ])('refuses anything else: %j', (raw) => {
    expect(externalUrl(raw)).toBeNull()
  })
})

describe('isAppPage', () => {
  const dev = { url: 'http://localhost:5173' }

  it('accepts the dev page, with or without the in-page query and hash', () => {
    expect(isAppPage('http://localhost:5173/', dev)).toBe(true)
    expect(isAppPage('http://localhost:5173/?screen=fleet', dev)).toBe(true)
    expect(isAppPage('http://localhost:5173/#x', dev)).toBe(true)
  })

  it.each([
    ['http://localhost:5174/'],
    ['https://localhost:5173/'],
    ['http://localhost:5173/other.html'],
    ['http://127.0.0.1:5173/'],
    ['https://example.com/'],
    ['file:///etc/passwd'],
    ['about:blank'],
    ['not a url']
  ])('refuses anything else in dev: %j', (target) => {
    expect(isAppPage(target, dev)).toBe(false)
  })

  // The host's own path rules: this is the one comparison that has to agree
  // with how Electron spelled the URL of the file it loaded.
  const index = resolve('out', 'renderer', 'index.html')
  const built = { file: index }

  it('accepts the built index.html however its URL is spelled', () => {
    expect(isAppPage(pathToFileURL(index).href, built)).toBe(true)
    expect(isAppPage(pathToFileURL(index).href + '?screen=jobs#top', built)).toBe(true)
  })

  it.each([
    [pathToFileURL(resolve('out', 'renderer', 'other.html')).href],
    [pathToFileURL(resolve('Downloads', 'dropped.html')).href],
    [pathToFileURL(resolve('frames', '0001.png')).href],
    ['http://localhost:5173/'],
    ['https://example.com/index.html']
  ])('refuses any other page in a build: %j', (target) => {
    expect(isAppPage(target, built)).toBe(false)
  })

  it('compares Windows file pages case-insensitively and whatever the host', () => {
    const page = {
      file: 'C:\\Program Files\\Vast Render\\resources\\app.asar\\out\\renderer\\index.html'
    }
    const url =
      'file:///c:/Program%20Files/Vast%20Render/resources/app.asar/out/renderer/index.html'
    expect(isAppPage(url, page, win32)).toBe(true)
    expect(isAppPage('file:///C:/Users/u/Downloads/index.html', page, win32)).toBe(false)
  })
})

describe('openPathVerdict', () => {
  // Every case runs against both platforms' path rules, as in paths.test.ts:
  // the node is Linux, but the desktop that opens the file may be Windows.
  const cases = {
    posix: {
      path: posix,
      project: '/home/u/vast-renders',
      oldJob: '/mnt/old-root/renders/job0',
      join: (...s: string[]) => posix.join(...s)
    },
    win32: {
      path: win32,
      project: 'C:\\Users\\u\\vast-renders',
      oldJob: 'D:\\old-root\\renders\\job0',
      join: (...s: string[]) => win32.join(...s)
    }
  }

  describe.each(Object.entries(cases))('%s', (_name, c) => {
    const roots = [c.project, c.join(c.project, 'renders', 'job1'), c.oldJob]
    const disk =
      (kinds: Record<string, PathKind>) =>
      (abs: string): PathKind =>
        kinds[abs] ?? 'missing'
    const frame = c.join(c.project, 'renders', 'job1', 'frames', '0042.exr')
    const verdict = (p: unknown, kinds: Record<string, PathKind>): OpenPathVerdict =>
      openPathVerdict(p, roots, disk(kinds), c.path)

    it('opens the project root, a job folder and a frame', () => {
      const jobDir = c.join(c.project, 'renders', 'job1')
      expect(verdict(c.project, { [c.project]: 'dir' })).toEqual({
        action: 'open',
        path: c.project
      })
      expect(verdict(jobDir, { [jobDir]: 'dir' })).toEqual({ action: 'open', path: jobDir })
      expect(verdict(frame, { [frame]: 'file' })).toEqual({ action: 'open', path: frame })
    })

    it("opens inside a job's own folder after the project root has moved", () => {
      const old = c.join(c.oldJob, 'frames', '0001.PNG')
      expect(verdict(old, { [old]: 'file' })).toEqual({ action: 'open', path: old })
    })

    it.each([['0042.exe'], ['0042.bat'], ['0042.cmd'], ['0042.lnk'], ['0042.command'], ['0042']])(
      'reveals, never runs, a non-media file inside a root: %s',
      (name) => {
        const p = c.join(c.project, 'renders', 'job1', 'frames', name)
        expect(verdict(p, { [p]: 'file' })).toEqual({ action: 'reveal', path: p })
      }
    )

    it('reveals a code bundle, a symlink and anything that is not a plain file', () => {
      const app = c.join(c.project, 'renders', 'job1', 'frames', '0042.app')
      const link = c.join(c.project, 'renders', 'job1', 'frames', '0043.png')
      const fifo = c.join(c.project, 'renders', 'job1', 'pipe.mp4')
      expect(verdict(app, { [app]: 'dir' })).toEqual({ action: 'reveal', path: app })
      expect(verdict(link, { [link]: 'link' })).toEqual({ action: 'reveal', path: link })
      expect(verdict(fifo, { [fifo]: 'other' })).toEqual({ action: 'reveal', path: fifo })
    })

    it('stats a root through a symlink, and nothing inside one', () => {
      const seen: Array<[string, boolean]> = []
      const kindOf = (abs: string, follow: boolean): PathKind => {
        seen.push([abs, follow])
        return 'dir'
      }
      openPathVerdict(c.project, roots, kindOf, c.path)
      openPathVerdict(c.join(c.project, 'renders'), roots, kindOf, c.path)
      expect(seen).toEqual([
        [c.project, true],
        [c.join(c.project, 'renders'), false]
      ])
    })

    it('refuses what is not there', () => {
      expect(verdict(frame, {})).toEqual({ action: 'refuse', reason: 'no such file or folder' })
    })
  })

  it.each([
    ['/Applications/Calculator.app'],
    ['/home/u/vast-renders-old/x.png'],
    ['/home/u/vast-renders/../.ssh/id_ed25519'],
    ['/home/u'],
    ['/'],
    ['vast-renders/renders/job1/frames/0042.exr'],
    [''],
    [null],
    [['/home/u/vast-renders']]
  ])('refuses a path outside every root (posix): %j', (p) => {
    const v = openPathVerdict(p, ['/home/u/vast-renders'], () => 'file', posix)
    expect(v.action).toBe('refuse')
  })

  it.each([
    ['C:\\Windows\\System32\\calc.exe'],
    ['C:\\Users\\u\\vast-renders-old\\x.png'],
    ['C:\\Users\\u\\vast-renders\\..\\Desktop\\x.bat'],
    ['\\\\attacker\\share\\x.png'],
    ['D:\\vast-renders\\x.png'],
    ['C:\\Users\\u\\vast-renders\\renders\\job1\\0001.png::$DATA'],
    ['C:\\Users\\u\\vast-renders\\renders\\job1\\0001.png.']
  ])('refuses a path outside every root (win32): %j', (p) => {
    const v = openPathVerdict(p, ['C:\\Users\\u\\vast-renders'], () => 'file', win32)
    expect(v.action).toBe('refuse')
  })

  it('ignores roots that are not absolute paths, so an unset one opens nothing', () => {
    expect(openPathVerdict('/x/y.png', ['', 'x'], () => 'file', posix).action).toBe('refuse')
    expect(openPathVerdict(resolve('y.png'), [''], () => 'file').action).toBe('refuse')
  })
})

describe('revealPath', () => {
  const places = [
    'C:\\Users\\u\\vast-renders',
    'D:\\scenes\\shot010.blend',
    '\\\\nas\\projects\\shot020.blend',
    'C:\\Users\\u\\AppData\\Roaming\\Vast Render\\addons'
  ]
  const reveal = (p: unknown): string | null => revealPath(p, places, win32)

  it('reveals a place, and anything inside a folder one', () => {
    const clip = 'C:\\Users\\u\\vast-renders\\renders\\job1\\previews\\clip.mp4'
    expect(reveal(clip)).toBe(clip)
    expect(reveal('C:\\Users\\u\\vast-renders')).toBe('C:\\Users\\u\\vast-renders')
    expect(reveal('d:\\scenes\\shot010.blend')).toBe('d:\\scenes\\shot010.blend')
    expect(reveal('C:\\Users\\u\\AppData\\Roaming\\Vast Render\\addons\\x-1a2b3c4d.zip')).toBe(
      'C:\\Users\\u\\AppData\\Roaming\\Vast Render\\addons\\x-1a2b3c4d.zip'
    )
  })

  it('reveals a UNC path only when it is one of the places, as a .blend the user chose', () => {
    expect(reveal('\\\\nas\\projects\\shot020.blend')).toBe('\\\\nas\\projects\\shot020.blend')
  })

  // Explorer connects to the host of a UNC path it is asked to show, and a
  // compromised renderer could name its own.
  it.each([
    ['\\\\attacker\\share\\x.png'],
    ['\\\\attacker@SSL\\share\\x'],
    ['\\\\?\\UNC\\attacker\\share\\x'],
    ['\\\\.\\pipe\\x'],
    ['\\\\nas\\projects\\other.blend'],
    ['C:\\Windows\\System32\\calc.exe'],
    ['C:\\Users\\u\\vast-renders-old\\x.png'],
    ['C:\\Users\\u\\vast-renders\\..\\.ssh\\id_ed25519'],
    ['D:\\scenes\\shot010.blend\\..\\secret.txt'],
    ['vast-renders\\x.png'],
    [''],
    [null],
    [42]
  ])('refuses anything else: %j', (p) => {
    expect(reveal(p)).toBeNull()
  })

  it('refuses everything when no place is set', () => {
    expect(revealPath('/home/u/x.png', ['', 'relative/dir'], posix)).toBeNull()
    expect(revealPath('/home/u/x.png', [], posix)).toBeNull()
  })
})

// The handler itself, through the lifecycle harness: the real ipc.ts on a
// recorded `shell`, a real project folder on disk, jobs in the real schema.
describe('shell:openPath', () => {
  let w: World
  let app: App
  beforeEach(async () => {
    w = await setup()
    app = await w.boot({ start: false })
  })
  afterEach(() => w.dispose())

  /** A file on disk under `dir`, returned as an absolute path. */
  const touch = (dir: string, ...rel: string[]): string => {
    const p = join(dir, ...rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, 'x')
    return p
  }
  const calls = (): Array<[string, unknown]> => w.desktop.map((c) => [c.method, c.args[0]])

  it('opens a job folder and a rendered frame', async () => {
    const jobId = await w.submitJob(app)
    const jobDir = join(w.settings.projectRoot, 'renders', jobId)
    const frame = touch(jobDir, 'frames', '0001.exr')
    await w.invoke('shell:openPath', w.settings.projectRoot)
    await w.invoke('shell:openPath', jobDir)
    await w.invoke('shell:openPath', frame)
    expect(calls()).toEqual([
      ['openPath', w.settings.projectRoot],
      ['openPath', jobDir],
      ['openPath', frame]
    ])
  })

  // The attack the audit found: a node names a frame `0001.bat`, it lands in
  // the job's frames/ folder, and the filmstrip's double-click opened it.
  it('reveals, never runs, an executable a node named as a frame', async () => {
    const jobId = await w.submitJob(app)
    const jobDir = join(w.settings.projectRoot, 'renders', jobId)
    const bat = touch(jobDir, 'frames', '0001.bat')
    const exe = touch(jobDir, 'frames', '0002.exe')
    await w.invoke('shell:openPath', bat)
    await w.invoke('shell:openPath', exe)
    expect(calls()).toEqual([
      ['showItemInFolder', bat],
      ['showItemInFolder', exe]
    ])
  })

  it('refuses anything outside the project and job folders', async () => {
    const elsewhere = touch(w.dir, 'Downloads', 'invoice.pdf.exe')
    const image = touch(w.dir, 'Pictures', 'holiday.png')
    await w.invoke('shell:openPath', elsewhere)
    await w.invoke('shell:openPath', image)
    await w.invoke('shell:openPath', join(w.settings.projectRoot, '..', 'Downloads'))
    expect(calls()).toEqual([])
  })

  it("still opens a job's frames after the project root has moved", async () => {
    const jobId = await w.submitJob(app)
    const frame = touch(w.settings.projectRoot, 'renders', jobId, 'frames', '0001.png')
    w.settings.projectRoot = join(w.dir, 'new-project')
    await w.invoke('shell:openPath', frame)
    expect(calls()).toEqual([['openPath', frame]])
  })
})

// shell:showItemInFolder through the real ipc.ts: it reveals what the app
// itself shows (job folders and frames, a job's .blend, the SSH key) and
// nothing a compromised renderer makes up — a UNC path on Windows would hand
// the user's NTLM hash to whoever serves the share.
describe('shell:showItemInFolder', () => {
  let w: World
  let app: App
  beforeEach(async () => {
    w = await setup()
    app = await w.boot({ start: false })
  })
  afterEach(() => w.dispose())

  const calls = (): Array<[string, unknown]> => w.desktop.map((c) => [c.method, c.args[0]])

  it("reveals a job's frames and its .blend, which lives outside the project", async () => {
    const blend = w.blend()
    const jobId = await w.submitJob(app, { blendPath: blend })
    const frame = join(w.settings.projectRoot, 'renders', jobId, 'frames', '0001.png')
    await w.invoke('shell:showItemInFolder', frame)
    await w.invoke('shell:showItemInFolder', blend)
    expect(calls()).toEqual([
      ['showItemInFolder', frame],
      ['showItemInFolder', blend]
    ])
  })

  it('refuses a UNC share, a relative path and anything the app never showed', async () => {
    await w.submitJob(app)
    await w.invoke('shell:showItemInFolder', '\\\\attacker\\share\\x.png')
    await w.invoke('shell:showItemInFolder', 'renders/x.png')
    await w.invoke('shell:showItemInFolder', join(w.dir, 'Downloads', 'invoice.pdf'))
    expect(calls()).toEqual([])
  })
})
