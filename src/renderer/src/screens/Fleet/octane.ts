/**
 * Octane on a node as NodeDetail shows it (plan 1.18): its capability chip
 * and whether it offers the VNC sign-in.
 */

import type { NodeSnapshot, OctaneState } from '../../../../shared/models'

/**
 * The node's Octane state: octaneState, or for a snapshot from before that
 * field, the two flags it replaces.
 */
export function octaneStateOf(
  node: Pick<NodeSnapshot, 'octaneState' | 'octaneReady' | 'octaneNeedsManualLogin'>
): OctaneState {
  if (node.octaneState) return node.octaneState
  if (node.octaneReady) return 'licensed'
  if (node.octaneNeedsManualLogin) return 'needsLogin'
  return 'none'
}

/** The capabilities row's Octane chip: its look and its words. */
export function octaneCap(state: OctaneState): {
  state: 'ok' | 'no' | 'unknown' | 'warn'
  label: string
} {
  switch (state) {
    case 'licensed':
      return { state: 'ok', label: 'octane' }
    case 'needsLogin':
      return { state: 'warn', label: 'octane sign-in needed' }
    case 'serverRunning':
      return { state: 'unknown', label: 'octane starting' }
    case 'none':
      return { state: 'no', label: 'octane' }
  }
}
