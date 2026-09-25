/**
 * Instances on the Vast account that no node here holds (plan 1.3), each
 * with what it costs and a destroy that asks first. Each one bills like a
 * node, and before this the Fleet showed none of them: an instance another
 * profile or computer left behind got one warning, once per launch, and
 * then billed unseen (#234).
 *
 * Nothing here is destroyed without the user: another Vast Render's
 * instance may be its live render, and one rented by hand is the user's
 * own. The panel stays while the list has anything on it, and a row goes
 * only when main has seen the instance gone.
 */

import { useState } from 'react'
import { ConfirmButton } from '../../components/ConfirmButton'
import { Icon } from '../../components/Icon'
import { InfoHint } from '../../components/Tooltip'
import { btn, chip, mono, panel, sectionLabel } from '../../lib/controls'
import { fmtDuration, fmtRate } from '../../lib/format'
import { ipc } from '../../lib/ipc'
import { useDestroyUnclaimed, useUnclaimed } from '../../lib/queries'
import { ipcErrorText } from '../../lib/recovery'
import { billsNow, unclaimedPerHour } from '../../lib/runway'
import { SCALE, TOKENS } from '../../lib/theme'
import { useNow } from '../../lib/useNow'
import type { UnclaimedInstance, UnclaimedOwner } from '../../../../shared/models'

const VAST_CONSOLE = 'https://cloud.vast.ai/instances/'

const OWNER: Record<UnclaimedOwner, { label: string; title: string }> = {
  thisProfile: {
    label: 'this install',
    title:
      "Its label carries this install's id, but no node here holds it: a destroy that has not " +
      'gone through yet, or a node this profile has lost track of. It bills until it is destroyed.'
  },
  otherVastRender: {
    label: 'another Vast Render',
    title:
      'Rented by Vast Render on another computer or profile. It may be that app’s live render, ' +
      'so it is never destroyed automatically.'
  },
  unlabelled: {
    label: 'not Vast Render',
    title: 'Rented by hand or by another tool. It is never destroyed automatically.'
  }
}

const HINT =
  'Instances on your Vast.ai account that no node here holds. Each bills at its rate until it ' +
  'is destroyed. The app never destroys another app’s or a hand-rented instance by itself: ' +
  'destroy one here only if you know it is stray.'

function confirmLabel(u: UnclaimedInstance): string {
  const rate = u.dphTotal != null ? ` (${fmtRate(u.dphTotal)})` : ''
  return u.owner === 'otherVastRender'
    ? `destroy another app's #${u.instanceId}?`
    : `destroy #${u.instanceId}${rate}?`
}

function Row({
  u,
  now,
  onDestroy,
  result
}: {
  u: UnclaimedInstance
  now: number
  onDestroy: () => Promise<unknown>
  result: { ok: boolean; message: string } | undefined
}): React.JSX.Element {
  const billing = billsNow(u)
  const owner = OWNER[u.owner]
  const error = result && !result.ok ? result.message : u.destroyError
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: `${SCALE.space2} ${SCALE.space3}`,
        borderTop: `1px solid ${TOKENS.border}`
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: SCALE.space3, minWidth: 0 }}>
        <span style={{ ...mono, fontSize: SCALE.textSm, color: TOKENS.text, width: 92 }}>
          #{u.instanceId}
        </span>
        <span style={{ ...chip({ tone: 'neutral' }), fontSize: SCALE.text2xs }} title={owner.title}>
          {owner.label}
        </span>
        <span
          style={{
            ...mono,
            fontSize: SCALE.textXs,
            color: TOKENS.textMuted,
            minWidth: 0,
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            userSelect: 'text'
          }}
          title={u.label ?? undefined}
        >
          {u.label ?? 'no label'}
        </span>
        <span style={{ ...mono, fontSize: SCALE.textSm, width: 150 }}>
          {u.gpuName ?? 'gpu unknown'}
          {u.numGpus > 1 ? ` ×${u.numGpus}` : ''}
        </span>
        <span style={{ fontSize: SCALE.textXs, color: TOKENS.textSecondary, width: 70 }}>
          {u.status ?? 'status ?'}
        </span>
        <span
          style={{
            ...mono,
            fontSize: SCALE.textSm,
            width: 92,
            color: billing ? TOKENS.warn : TOKENS.textFaint
          }}
          title={
            billing
              ? 'Billing at this rate'
              : u.dphTotal == null
                ? 'Vast reported no rate'
                : 'Stopped by Vast: its storage still bills, its GPUs do not'
          }
        >
          {u.dphTotal != null ? fmtRate(u.dphTotal) : '—'}
        </span>
        <span
          style={{ ...mono, fontSize: SCALE.textXs, color: TOKENS.textFaint, width: 78 }}
          title={
            (u.startedAt != null ? `started ${new Date(u.startedAt).toLocaleString()}; ` : '') +
            `listed here since ${new Date(u.firstSeenAt).toLocaleString()}`
          }
        >
          {u.startedAt != null ? `up ${fmtDuration(Math.max(0, now - u.startedAt))}` : ''}
        </span>
        <ConfirmButton
          label="destroy"
          confirmLabel={confirmLabel(u)}
          title="Destroy this instance on Vast.ai. Asks first."
          onConfirm={onDestroy}
        />
      </div>
      {error ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: SCALE.textXs,
            color: TOKENS.danger
          }}
        >
          <Icon name="alert" size={11} />
          <span style={{ ...mono, wordBreak: 'break-word' }}>{error}</span>
        </div>
      ) : null}
    </div>
  )
}

export function UnclaimedPanel(): React.JSX.Element | null {
  const { data: list } = useUnclaimed()
  const destroy = useDestroyUnclaimed()
  const now = useNow()
  const [results, setResults] = useState<Record<number, { ok: boolean; message: string }>>({})
  if (!list || list.length === 0) return null

  const perHour = unclaimedPerHour(list)
  const onDestroy = (id: number) => (): Promise<unknown> =>
    destroy.mutateAsync(id).then(
      (r) => setResults((prev) => ({ ...prev, [id]: r })),
      (e: unknown) =>
        setResults((prev) => ({ ...prev, [id]: { ok: false, message: ipcErrorText(e) } }))
    )

  return (
    <div
      role="region"
      aria-label="Unclaimed instances"
      style={{ ...panel(), borderColor: TOKENS.warnSoftBorder }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: SCALE.space3,
          padding: `${SCALE.space2} ${SCALE.space3}`,
          background: TOKENS.warnSoftBg,
          borderRadius: `${SCALE.radiusMd} ${SCALE.radiusMd} 0 0`
        }}
      >
        <Icon name="server" size={13} style={{ color: TOKENS.warn }} />
        <span style={{ ...sectionLabel(), color: TOKENS.warnSoftText }}>unclaimed instances</span>
        <InfoHint text={HINT} size={10} />
        <span style={{ fontSize: SCALE.textSm, color: TOKENS.warnSoftText }}>
          {list.length} on the account
          {perHour > 0 ? (
            <>
              , billing <span style={mono}>{fmtRate(perHour)}</span>
            </>
          ) : null}
        </span>
        <span style={{ flex: 1 }} />
        <button
          style={btn({ size: 'sm' })}
          title="Check these on the Vast.ai instances page"
          onClick={() => void ipc.invoke('shell:openExternal', VAST_CONSOLE)}
        >
          Open Vast console
          <Icon name="external" size={11} />
        </button>
      </div>
      {list.map((u) => (
        <Row
          key={u.instanceId}
          u={u}
          now={now}
          onDestroy={onDestroy(u.instanceId)}
          result={results[u.instanceId]}
        />
      ))}
    </div>
  )
}
