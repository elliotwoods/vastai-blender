/**
 * "What is this machine actually rendering" — one strip per render slot.
 *
 * Replaces `resolveChunk()`, which regex-parsed `NodeSnapshot.currentChunkId`.
 * That field was a display string built by joining every in-flight chunk id
 * with ", ", so on any multi-slot node the parse failed outright, and retry
 * chunks (`…-rN`) failed it too — the panel showed comma-salad and no job
 * link in exactly the cases where knowing what is running matters most.
 *
 * Static shape comes from `node:chunks` (a join, so it is an invoke and only
 * runs while the row is expanded); the moving numbers come from the
 * progressStore, which is fed by `chunk:progress` push events. Idle slots are
 * rendered rather than omitted: an unfilled slot on a machine you are paying
 * for is the most actionable thing this panel can say.
 */

import { Icon } from '../../components/Icon'
import { btn, chip, mono, sectionLabel } from '../../lib/controls'
import { fmtDuration } from '../../lib/format'
import { useNav } from '../../lib/nav'
import { useChunkProgress } from '../../lib/progressStore'
import { useNodeChunks } from '../../lib/queries'
import { CHUNK_TONE, SCALE, STATUS_VARS, TOKENS } from '../../lib/theme'
import { useNow } from '../../lib/useNow'
import { Thumb } from '../../media/Thumb'
import { usePreview } from '../../lib/preview'
import { Meter } from './meters'
import type { NodeChunkView, NodeSnapshot } from '../../../../shared/models'

/** How many finished chunks to keep visible below the live ones. */
const RECENT_LIMIT = 3

function eta(elapsedMs: number, done: number, total: number): string | null {
  if (done <= 0 || done >= total || elapsedMs < 30_000) return null
  return fmtDuration((elapsedMs / done) * (total - done))
}

function Slot({ chunk, now }: { chunk: NodeChunkView; now: number }): React.JSX.Element {
  const { navigate } = useNav()
  const openPreview = usePreview((s) => s.open)
  const live = useChunkProgress(chunk.chunkId)
  const tone = STATUS_VARS[CHUNK_TONE[chunk.state]]

  // Rendered (from the agent) leads downloaded (from our own transfers) — show
  // the leading edge so the bar tracks the render, not the network.
  const done = Math.max(chunk.framesDone, live?.framesDone ?? 0)
  const total = live?.framesTotal || chunk.framesTotal
  const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0
  const elapsedMs = chunk.assignedAt ? now - chunk.assignedAt : 0
  const remaining = chunk.assignedAt ? eta(elapsedMs, done, total) : null

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: SCALE.space3,
        padding: `6px ${SCALE.space2}`,
        borderLeft: `2px solid ${chunk.live ? tone.border : TOKENS.border}`,
        background: TOKENS.surfaceRaised,
        borderRadius: SCALE.radiusSm,
        opacity: chunk.live ? 1 : 0.7
      }}
    >
      <Thumb
        url={chunk.thumbUrl}
        width={96}
        height={54}
        state={chunk.state}
        title={`${chunk.chunkId} — click to inspect`}
        onClick={() => openPreview({ jobId: chunk.jobId, chunkId: chunk.chunkId })}
      />

      <div
        style={{ minWidth: 0, flex: '1 1 200px', display: 'flex', flexDirection: 'column', gap: 3 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: SCALE.space2, minWidth: 0 }}>
          <button
            style={{
              ...btn({ variant: 'ghost', size: 'sm' }),
              color: TOKENS.accent,
              padding: '1px 4px'
            }}
            onClick={() => navigate({ screen: 'job', jobId: chunk.jobId })}
            title={chunk.chunkId}
          >
            {chunk.jobName}
            <Icon name="external" size={10} />
          </button>
          <span style={{ ...mono, fontSize: SCALE.text2xs, color: TOKENS.textFaint }}>
            {chunk.frameStart}–{chunk.frameEnd}
          </span>
          {chunk.retries > 0 ? (
            <span style={chip({ tone: 'warn' })} title={`retry ${chunk.retries}`}>
              r{chunk.retries}
            </span>
          ) : null}
        </div>
        <Meter pct={pct} tone={chunk.state === 'failed' ? 'danger' : 'normal'} />
      </div>

      <span
        style={{
          ...mono,
          fontSize: SCALE.text2xs,
          color: TOKENS.textSecondary,
          whiteSpace: 'nowrap'
        }}
      >
        {done}/{total}
        {live?.currentFrame != null ? (
          <span style={{ color: TOKENS.textFaint }}> · f{live.currentFrame}</span>
        ) : null}
      </span>

      <span
        style={{ ...mono, fontSize: SCALE.text2xs, color: TOKENS.textFaint, whiteSpace: 'nowrap' }}
        title={
          chunk.assignedAt
            ? 'elapsed · remaining (estimated)'
            : 'dispatched before this was recorded'
        }
      >
        {chunk.assignedAt ? fmtDuration(elapsedMs) : '—'}
        {remaining ? ` · ~${remaining}` : ''}
      </span>

      <span
        style={{
          border: `1px solid ${tone.border}`,
          background: tone.fill,
          color: tone.text,
          borderRadius: SCALE.radiusSm,
          padding: '2px 8px',
          fontSize: SCALE.text2xs,
          whiteSpace: 'nowrap'
        }}
        title={
          chunk.live
            ? chunk.state
            : `${chunk.state} — no live run on this node (finished, or its run died)`
        }
      >
        {chunk.engine} · {chunk.state}
      </span>
    </div>
  )
}

function IdleSlot(): React.JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: SCALE.space2,
        padding: `6px ${SCALE.space2}`,
        borderLeft: `2px dashed ${TOKENS.border}`,
        borderRadius: SCALE.radiusSm,
        fontSize: SCALE.textXs,
        color: TOKENS.textFaint
      }}
    >
      idle slot — paid for, not rendering
    </div>
  )
}

export function NodeWorkload({ node }: { node: NodeSnapshot }): React.JSX.Element {
  const { data: chunks } = useNodeChunks(node.id)
  const now = useNow(5_000)

  const liveIds = new Set(node.currentWork.map((w) => w.chunkId))
  const all = chunks ?? []
  const running = all.filter((c) => liveIds.has(c.chunkId) || c.live)
  const recent = all.filter((c) => !liveIds.has(c.chunkId) && !c.live).slice(0, RECENT_LIMIT)
  // The snapshot is the authority on how many slots are occupied; the query is
  // a join that may be a beat behind it.
  const idle = Math.max(0, node.slotTarget - Math.max(node.slotsInUse, running.length))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SCALE.space2 }}>
      <span style={{ ...sectionLabel(), display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        <Icon name="layers" size={11} />
        workload
        <span style={{ ...mono, color: TOKENS.textFaint }}>
          {node.slotsInUse}/{node.slotTarget}
        </span>
      </span>

      {running.map((c) => (
        <Slot key={c.chunkId} chunk={c} now={now} />
      ))}
      {Array.from({ length: idle }, (_, i) => (
        <IdleSlot key={`idle-${i}`} />
      ))}
      {running.length === 0 && idle === 0 ? (
        <span style={{ fontSize: SCALE.textXs, color: TOKENS.textFaint }}>
          Nothing assigned to this node.
        </span>
      ) : null}

      {recent.length > 0 ? (
        <>
          <span style={sectionLabel()}>recent</span>
          {recent.map((c) => (
            <Slot key={c.chunkId} chunk={c} now={now} />
          ))}
        </>
      ) : null}
    </div>
  )
}
