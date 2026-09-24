import { useLayoutEffect, useState } from 'react'

/**
 * Container width in px; 0 until the first measurement. The charts draw in
 * real pixels rather than a scaled viewBox, so strokes stay 1px and labels
 * stay upright at any panel width — which means knowing the width.
 */
export function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setW(el.clientWidth)
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return w
}
