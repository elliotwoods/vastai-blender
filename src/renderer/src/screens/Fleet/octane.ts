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

/**
 * Which VNC login panel a node shows: null when it offers none (it is not
 * waiting for a sign-in), and otherwise a key that changes with the rental
 * and the SSH endpoint the tunnel runs over. VncLogin mounts its panel
 * under this key, so the address and password of a tunnel opened for an
 * earlier sign-in, or over a connection since replaced, are never shown as
 * current: the node leaving needsLogin drops them, and coming back to it
 * starts with a fresh "Open VNC login".
 */
export function vncLoginKey(
  node: Pick<
    NodeSnapshot,
    | 'id'
    | 'instanceId'
    | 'sshHost'
    | 'sshPort'
    | 'octaneState'
    | 'octaneReady'
    | 'octaneNeedsManualLogin'
  >
): string | null {
  if (octaneStateOf(node) !== 'needsLogin') return null
  return `${node.id}|${node.instanceId ?? ''}|${node.sshHost ?? ''}:${node.sshPort ?? ''}`
}
