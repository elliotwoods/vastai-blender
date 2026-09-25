/**
 * Host-platform copy: what the OS calls its file manager, so a folder button
 * says "Show in Finder" on a Mac and "Show in Explorer" on Windows.
 */

export type HostPlatform = 'darwin' | 'win32' | 'linux'

/**
 * The preload's `process.platform` when the bridge is there, else a guess
 * from the user agent (tests, and a renderer opened outside Electron).
 */
export function hostPlatform(): HostPlatform {
  const fromApi = typeof window !== 'undefined' ? window.api?.platform : undefined
  if (fromApi) return fromApi
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  if (/Mac/i.test(ua)) return 'darwin'
  if (/Win/i.test(ua)) return 'win32'
  return 'linux'
}

/** Tooltip for selecting an item in the file manager. */
export function revealLabel(platform: HostPlatform = hostPlatform()): string {
  return platform === 'darwin'
    ? 'Show in Finder'
    : platform === 'win32'
      ? 'Show in Explorer'
      : 'Show in folder'
}

/** Tooltip for opening a folder in the file manager. */
export function openFolderLabel(platform: HostPlatform = hostPlatform()): string {
  return platform === 'darwin'
    ? 'Open in Finder'
    : platform === 'win32'
      ? 'Open in Explorer'
      : 'Open folder'
}
