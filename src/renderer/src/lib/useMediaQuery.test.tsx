import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { matchesMedia, subscribeMedia, useMediaQuery } from './useMediaQuery'

function Probe({ q }: { q: string }): React.JSX.Element {
  return <span>{String(useMediaQuery(q))}</span>
}

describe('useMediaQuery', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('is false with no window, and in a server render', () => {
    expect(matchesMedia('(min-width: 1px)')).toBe(false)
    expect(subscribeMedia('(min-width: 1px)', () => {})).toBeTypeOf('function')
    expect(renderToStaticMarkup(<Probe q="(min-width: 1px)" />)).toBe('<span>false</span>')
  })

  it('reads matchMedia and follows its changes', () => {
    const listeners = new Set<() => void>()
    const list = {
      matches: true,
      addEventListener: (_: string, cb: () => void) => listeners.add(cb),
      removeEventListener: (_: string, cb: () => void) => listeners.delete(cb)
    }
    vi.stubGlobal('window', { matchMedia: vi.fn(() => list) })
    expect(matchesMedia('(min-width: 1280px)')).toBe(true)
    const onChange = vi.fn()
    const off = subscribeMedia('(min-width: 1280px)', onChange)
    listeners.forEach((l) => l())
    expect(onChange).toHaveBeenCalledOnce()
    off()
    expect(listeners.size).toBe(0)
  })
})
