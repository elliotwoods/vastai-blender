/**
 * Global transport keys, extracted from TransportBar.
 *
 * The handler binds at the window for as long as its owner is mounted, so two
 * mounted transports meant every arrow key stepped twice. Now the binding is
 * explicitly gated: the overlay claims the keys while it is open and the
 * screen behind it stands down, instead of "whoever mounted last wins".
 *
 * Space play/pause, ←/→ step (Shift ±10), Home/End, `<` / `>` speed preset.
 */

import { useEffect } from 'react'
import type { ClipSyncController } from './ClipSyncController'
import { applySpeed, stepSpeed } from './speed'

export function useTransportKeys(controller: ClipSyncController, enabled = true): void {
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent): void => {
      // Typing a frame number must not also scrub.
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      switch (e.key) {
        case ' ':
          e.preventDefault()
          controller.toggle()
          break
        case 'ArrowLeft':
          e.preventDefault()
          controller.step(e.shiftKey ? -10 : -1)
          break
        case 'ArrowRight':
          e.preventDefault()
          controller.step(e.shiftKey ? 10 : 1)
          break
        case 'Home':
          e.preventDefault()
          controller.first()
          break
        case 'End':
          e.preventDefault()
          controller.last()
          break
        case '<':
          e.preventDefault()
          applySpeed(controller, stepSpeed(controller.rate, -1))
          break
        case '>':
          e.preventDefault()
          applySpeed(controller, stepSpeed(controller.rate, 1))
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [controller, enabled])
}
