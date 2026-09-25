/**
 * The Fleet's buttons that end or restart what a node is doing: destroy (a
 * row's) and reprovision (NodeDetail's). Each asks before it acts
 * (ConfirmButton): one stray click on a row of destroy buttons ended a
 * paid-for, half-provisioned node, and a reprovision kills every render on
 * the node (audit D4, plan 1.15). Kept free of the IPC bridge so they
 * render in a test; the screens pass the action in, and return its promise
 * so the button stays disabled until main has answered.
 */

import { ConfirmButton } from '../../components/ConfirmButton'
import { canDestroy, canReprovision } from '../../lib/recovery'
import type { NodeSnapshot } from '../../../../shared/models'

export function DestroyNodeButton({
  node,
  onDestroy
}: {
  node: Parameters<typeof canDestroy>[0]
  onDestroy: () => Promise<unknown>
}): React.JSX.Element {
  return (
    <ConfirmButton
      label="destroy"
      disabled={!canDestroy(node)}
      title={
        node.state === 'destroying'
          ? 'Being destroyed'
          : node.state === 'destroyed'
            ? canDestroy(node)
              ? 'Vast has not confirmed this instance gone, so it may still be billing: destroy it again'
              : 'Destroyed'
            : "Destroy this node's instance on Vast.ai. What it is rendering goes back to the queue."
      }
      onConfirm={onDestroy}
    />
  )
}

export function ReprovisionButton({
  node,
  onReprovision
}: {
  node: Pick<NodeSnapshot, 'state' | 'sshHost'>
  onReprovision: () => Promise<unknown>
}): React.JSX.Element {
  return (
    <ConfirmButton
      label="reprovision"
      confirmLabel="restart its agent?"
      variant="default"
      disabled={!canReprovision(node)}
      title={
        canReprovision(node)
          ? "Ship the scripts again and restart the node's agent. Every render on it is " +
            "stopped and goes back to the queue, counted against its chunk's allowance for " +
            'machine failures, not its render retries.'
          : 'Only a node that is up can be reprovisioned'
      }
      onConfirm={onReprovision}
    />
  )
}
