/**
 * "Work was recovered from your last session — resume?"
 *
 * Opening the app on a profile with a half-finished campaign used to start
 * renting up to `maxActiveNodes` on the first scheduler tick, before you had
 * seen a single screen. That is right when you meant to resume and expensive
 * when you did not, so main holds fleet scale-up and this asks.
 *
 * Only scale-UP is held: existing nodes still take work, idle ones still scale
 * down, and "add node" on the Fleet screen still works — so dismissing this is
 * never the only way to get moving again.
 */

import { btn } from '../lib/controls'
import { useRecoveryHold, useResumeRecovery } from '../lib/queries'
import { SCALE, TOKENS } from '../lib/theme'

export function RecoveryBanner(): React.JSX.Element | null {
  const { data: hold } = useRecoveryHold()
  const resume = useResumeRecovery()
  if (!hold) return null

  const n = hold.chunks
  return (
    <div
      role="status"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: SCALE.space3,
        padding: `${SCALE.space2} ${SCALE.space4}`,
        background: TOKENS.warnSoftBg,
        borderBottom: `1px solid ${TOKENS.warnSoftBorder}`,
        color: TOKENS.warnSoftText,
        fontSize: SCALE.textSm
      }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>
        {n} unfinished {n === 1 ? 'chunk' : 'chunks'} recovered from your last session. Renting is
        paused so this doesn&apos;t start a fleet you weren&apos;t expecting.
      </span>
      <button
        style={btn({ size: 'sm', variant: 'primary' })}
        disabled={resume.isPending}
        onClick={() => resume.mutate()}
      >
        Resume rendering
      </button>
    </div>
  )
}
