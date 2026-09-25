import { afterEach, describe, expect, it, vi } from 'vitest'
import { hostPlatform, openFolderLabel, revealLabel } from './platform'

afterEach(() => vi.unstubAllGlobals())

describe('platform copy', () => {
  it('names the file manager per platform', () => {
    expect(revealLabel('darwin')).toBe('Show in Finder')
    expect(revealLabel('win32')).toBe('Show in Explorer')
    expect(revealLabel('linux')).toBe('Show in folder')
    expect(openFolderLabel('darwin')).toBe('Open in Finder')
    expect(openFolderLabel('win32')).toBe('Open in Explorer')
    expect(openFolderLabel('linux')).toBe('Open folder')
  })

  it('reads the platform from the preload bridge first', () => {
    vi.stubGlobal('window', { api: { platform: 'win32' } })
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
    expect(hostPlatform()).toBe('win32')
    expect(revealLabel()).toBe('Show in Explorer')
  })

  it('falls back to the user agent without a bridge', () => {
    vi.stubGlobal('window', {})
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)' })
    expect(hostPlatform()).toBe('darwin')
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64)' })
    expect(hostPlatform()).toBe('win32')
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' })
    expect(hostPlatform()).toBe('linux')
  })
})
