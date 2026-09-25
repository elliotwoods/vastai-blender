import { posix, win32 } from 'path'
import { describe, expect, it } from 'vitest'
import { isInside, resolveInside } from './paths'

// Every case runs against both platforms' path rules, whatever the host:
// the node is Linux, but the desktop the files land on may be Windows.
const ROOT = { posix: '/home/u/vast-renders/renders/job1', win32: 'C:\\Users\\u\\renders\\job1' }

describe('resolveInside', () => {
  it('joins a plain relative path onto the root', () => {
    expect(resolveInside(ROOT.posix, 'frames/0042.exr', posix)).toBe(
      '/home/u/vast-renders/renders/job1/frames/0042.exr'
    )
    expect(resolveInside(ROOT.win32, 'frames/0042.exr', win32)).toBe(
      'C:\\Users\\u\\renders\\job1\\frames\\0042.exr'
    )
  })

  it.each([
    ['../x.plist'],
    ['../../../../Library/LaunchAgents/x.plist'],
    ['frames/../../x/0001.exr'],
    // Stays inside once normalised, but no legitimate path spells it that way.
    ['frames/../frames/0001.exr'],
    ['..'],
    ['frames/..']
  ])('refuses a .. segment: %j', (rel) => {
    expect(resolveInside(ROOT.posix, rel, posix)).toBeNull()
    expect(resolveInside(ROOT.win32, rel, win32)).toBeNull()
  })

  it.each([
    ['/etc/passwd'],
    ['//server/share/x'],
    ['C:\\Windows\\x.bat'],
    ['C:/Windows/x.bat'],
    // Drive-relative: C:'s current directory, wherever that is.
    ['C:x.bat'],
    ['c:frames/0001.exr']
  ])('refuses an absolute or drive path: %j', (rel) => {
    expect(resolveInside(ROOT.posix, rel, posix)).toBeNull()
    expect(resolveInside(ROOT.win32, rel, win32)).toBeNull()
  })

  it.each([
    // A separator on Windows, where this climbs out to the Startup folder...
    ['..\\..\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\x.bat'],
    // ...and a plain filename character on the Linux node and a Mac.
    ['frames\\0001.exr'],
    ['\\\\server\\share\\x']
  ])('refuses a backslash on every platform: %j', (rel) => {
    expect(resolveInside(ROOT.posix, rel, posix)).toBeNull()
    expect(resolveInside(ROOT.win32, rel, win32)).toBeNull()
  })

  it.each([
    ['frames/0001.exr\n'],
    ['frames/0001.exr\nfile /etc/passwd'],
    ['frames/0001\r.exr'],
    ['frames/0001.exr\u0000.plist'],
    ['frames/\u001b[2J.exr'],
    ['frames/0001.exr\u007f']
  ])('refuses a control character: %j', (rel) => {
    expect(resolveInside(ROOT.posix, rel, posix)).toBeNull()
    expect(resolveInside(ROOT.win32, rel, win32)).toBeNull()
  })

  it('refuses the root itself', () => {
    for (const rel of ['', '.', './', './/.']) {
      expect(resolveInside(ROOT.posix, rel, posix)).toBeNull()
      expect(resolveInside(ROOT.win32, rel, win32)).toBeNull()
    }
  })

  it('normalises harmless spellings on the string alone', () => {
    // No symlinks followed, no disk touched: none of these exist.
    for (const rel of [
      'frames/./0042.exr',
      './frames/0042.exr',
      'frames//0042.exr',
      'frames/0042.exr/'
    ]) {
      expect(resolveInside(ROOT.posix, rel, posix)).toBe(
        '/home/u/vast-renders/renders/job1/frames/0042.exr'
      )
    }
  })

  it('copes with a root spelled with a trailing separator, or a filesystem root', () => {
    expect(resolveInside('/r/job1/', 'a.mp4', posix)).toBe('/r/job1/a.mp4')
    expect(resolveInside('/', 'a.mp4', posix)).toBe('/a.mp4')
    expect(resolveInside('C:\\r\\job1\\', 'a.mp4', win32)).toBe('C:\\r\\job1\\a.mp4')
    expect(resolveInside('C:\\', 'a.mp4', win32)).toBe('C:\\a.mp4')
  })

  it("refuses Win32's other ways of naming something else", () => {
    for (const rel of [
      // alternate data stream
      'frames/0001.exr:payload',
      // trailing dots and spaces are stripped by Win32
      'frames/0001.exr.',
      'frames/.. /x',
      'frames. /0001.exr',
      // devices, from any directory, with any extension
      'previews/CON.mp4',
      'previews/nul',
      'previews/com1.mp4',
      'previews/LPT9 .mp4',
      'AUX'
    ]) {
      expect(resolveInside(ROOT.win32, rel, win32), rel).toBeNull()
    }
    // Ordinary names that merely contain those letters are fine.
    expect(resolveInside(ROOT.win32, 'previews/console.mp4', win32)).toBe(
      'C:\\Users\\u\\renders\\job1\\previews\\console.mp4'
    )
  })

  it('refuses a non-string (a manifest field of the wrong type)', () => {
    expect(resolveInside(ROOT.posix, 42 as unknown as string, posix)).toBeNull()
    expect(resolveInside(ROOT.posix, null as unknown as string, posix)).toBeNull()
  })
})

describe('isInside', () => {
  it('accepts a path under the root and nothing else', () => {
    const root = '/home/u/vast-renders/renders'
    expect(isInside(root, '/home/u/vast-renders/renders/job1/previews/a_sdr.mp4', posix)).toBe(true)
    expect(isInside(root, '/home/u/vast-renders/renders', posix)).toBe(false)
    expect(isInside(root, '/home/u/vast-renders/renders/', posix)).toBe(false)
    expect(isInside(root, '/home/u/Library/LaunchAgents/x.plist', posix)).toBe(false)
    expect(isInside(root, '/home/u/vast-renders/renders/../../.zshrc', posix)).toBe(false)
    // A sibling that merely shares the prefix.
    expect(isInside(root, '/home/u/vast-renders/renders-old/x.mp4', posix)).toBe(false)
    expect(isInside(root, '/home/u/vast-renders/renders/job1/a\nb.mp4', posix)).toBe(false)
    expect(isInside(root, '', posix)).toBe(false)
  })

  it('speaks Windows paths, including another drive', () => {
    const root = 'C:\\Users\\u\\renders'
    expect(isInside(root, 'C:\\Users\\u\\renders\\job1\\previews\\a.mp4', win32)).toBe(true)
    expect(isInside(root, 'C:/Users/u/renders/job1/previews/a.mp4', win32)).toBe(true)
    expect(isInside(root, 'D:\\Users\\u\\renders\\job1\\a.mp4', win32)).toBe(false)
    expect(isInside(root, 'C:\\Users\\u\\AppData\\Roaming\\x.bat', win32)).toBe(false)
    expect(isInside(root, '\\\\server\\share\\renders\\a.mp4', win32)).toBe(false)
  })
})
