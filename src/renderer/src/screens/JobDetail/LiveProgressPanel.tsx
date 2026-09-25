/**
 * What a running job's renders are doing right now: "2 nodes working ·
 * 3 chunks active", then a row per chunk in flight with its node and GPU, the
 * frame it is on, its bar, and Blender's own status read off its last line
 * (phase, samples, memory, time left on the frame), the line itself under
 * it. A chunk whose node has reported no progress for STALE_MS fades and
 * says for how long, so a hung render stands out from a slow one.
 *
 * Fed by chunk:progress through progressStore (useJobProgress), which keeps
 * the latest sample per chunk; nothing here polls.
 */

import { ProgressBar } from '../../components/ProgressBar'
import { mono, panel } from '../../lib/controls'
import type { ChunkProgress } from '../../lib/progressStore'
import { SCALE, STATUS_VARS, TOKENS } from '../../lib/theme'
import { useNow } from '../../lib/useNow'
import type { ChunkSnapshot, NodeSnapshot } from '../../../../shared/models'
import {
  chunkFrames,
  describeLive,
  fmtAgo,
  fmtClock,
  isActiveChunk,
  isStale,
  nodeLabel,
  phaseOf,
  statusParts
} from './jobDetailModel'

function ChunkLive({
  chunk,
  step,
  live,
  node,
  now
}: {
  chunk: ChunkSnapshot
  step: number
  live: ChunkProgress | undefined
  node: NodeSnapshot | undefined
  now: number
}): React.JSX.Element {
  const total = chunkFrames(chunk, step)
  const done = Math.max(chunk.framesDone, live?.framesDone ?? 0)
  const rs = live?.renderStatus
  const frame = live?.currentFrame ?? rs?.frame ?? null
  const stale = isStale(live?.lastProgressAt, now)
  const nodeId = live?.nodeId ?? chunk.nodeId
  const gpu = node?.currentWork.find((w) => w.chunkId === chunk.id)?.gpu
  const phase = phaseOf(rs) ?? (live?.status === 'encoding' ? 'encoding' : chunk.state)
  const parts = statusParts(rs)
  return (
    <div
      data-chunk={chunk.id}
      data-stale={stale || undefined}
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(150px, 220px) minmax(0, 1fr)',
        gap: `4px ${SCALE.space4}`,
        padding: `${SCALE.space2} ${SCALE.space3}`,
        borderTop: `1px solid ${TOKENS.border}`,
        opacity: stale ? 0.55 : 1,
        transition: 'opacity 300ms'
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span
          style={{
            fontSize: SCALE.textSm,
            color: TOKENS.text,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}
          title={nodeId ?? undefined}
        >
          {nodeId ? nodeLabel(node, nodeId) : 'no node yet'}
        </span>
        <span style={{ fontSize: SCALE.textXs, color: TOKENS.textFaint }}>
          {gpu != null ? `GPU ${gpu} · ` : ''}
          <span style={mono}>
            {chunk.frameStart}–{chunk.frameEnd}
          </span>
          {chunk.retries > 0 ? ` · retry ${chunk.retries}` : ''}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: SCALE.space3,
            fontSize: SCALE.textXs,
            flexWrap: 'wrap',
            rowGap: 2
          }}
        >
          <span style={{ color: TOKENS.textSecondary }}>
            {frame != null ? (
              <>
                frame <span style={{ ...mono, color: TOKENS.text }}>{frame}</span>
              </>
            ) : (
              'starting'
            )}
          </span>
          <span style={{ ...mono, color: TOKENS.textMuted }}>
            {done}/{total} done
          </span>
          <span style={{ color: TOKENS.accent }}>{phase}</span>
          {parts.map(([k, v]) => (
            <span key={k} style={{ color: TOKENS.textFaint, whiteSpace: 'nowrap' }}>
              {k} <span style={{ ...mono, color: TOKENS.textSecondary }}>{v}</span>
            </span>
          ))}
          {live?.avgFrameS != null ? (
            <span style={{ color: TOKENS.textFaint, whiteSpace: 'nowrap' }}>
              avg{' '}
              <span style={{ ...mono, color: TOKENS.textSecondary }}>
                {fmtClock(live.avgFrameS)}
              </span>
              /frame
            </span>
          ) : null}
          {stale && live?.lastProgressAt != null ? (
            <span
              style={{ color: STATUS_VARS.error.text, marginLeft: 'auto', whiteSpace: 'nowrap' }}
              title="No frame has started or been saved on this node for a while. A render may be stuck, or a frame may just be slow."
            >
              stale · no progress for {fmtAgo(now - live.lastProgressAt)}
            </span>
          ) : null}
        </div>
        <ProgressBar
          total={total}
          done={done}
          state={stale ? 'queued' : 'active'}
          ticks
          label={`frames of chunk ${chunk.frameStart}–${chunk.frameEnd}`}
        />
        <span
          title={live?.lastLine ?? undefined}
          style={{
            ...mono,
            fontSize: 'var(--text-2xs)',
            color: TOKENS.textFaint,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            minWidth: 0
          }}
        >
          {live?.lastLine ?? 'Blender has not said anything yet.'}
        </span>
      </div>
    </div>
  )
}

export function LiveProgressPanel({
  chunks,
  step,
  progress,
  nodes
}: {
  chunks: readonly ChunkSnapshot[]
  step: number
  /** useJobProgress(jobId) */
  progress: Readonly<Record<string, ChunkProgress>>
  nodes: readonly NodeSnapshot[] | undefined
}): React.JSX.Element | null {
  const active = chunks.filter((c) => isActiveChunk(c.state))
  const now = useNow(1000, active.length > 0)
  if (active.length === 0) return null
  const nodeIds = new Set(
    active.map((c) => progress[c.id]?.nodeId ?? c.nodeId).filter((n): n is string => !!n)
  )
  const byId = new Map((nodes ?? []).map((n) => [n.id, n]))
  return (
    <div style={{ ...panel(), minWidth: 0, overflow: 'hidden' }}>
      <div
        style={{
          padding: `${SCALE.space2} ${SCALE.space3}`,
          fontSize: SCALE.textSm,
          color: TOKENS.textSecondary
        }}
      >
        {describeLive(nodeIds.size, active.length)}
      </div>
      {active.map((c) => {
        const live = progress[c.id]
        const nodeId = live?.nodeId ?? c.nodeId
        return (
          <ChunkLive
            key={c.id}
            chunk={c}
            step={step}
            live={live}
            node={nodeId ? byId.get(nodeId) : undefined}
            now={now}
          />
        )
      })}
    </div>
  )
}
