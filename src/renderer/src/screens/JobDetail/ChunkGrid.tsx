/**
 * The job's chunks as a grid of cells, each its frame range, its state in a
 * word, and a thin bar of its frames done. Failed and cancelled read apart
 * at a glance: failed is red and marked "!", cancelled is grey hatching
 * marked "–", with a legend under the grid saying which is which. A cell's
 * tooltip carries its node, retries and last error; a click opens the
 * preview at that chunk as soon as there is anything to see.
 */

import { mono, panel } from '../../lib/controls'
import { usePreview } from '../../lib/preview'
import { useChunkProgress } from '../../lib/progressStore'
import { CHUNK_TONE, SCALE, STATUS_VARS, TOKENS, type StatusTone } from '../../lib/theme'
import type { ChunkSnapshot } from '../../../../shared/models'
import { chunkCellInfo, chunkFrames } from './jobDetailModel'

function ChunkCell({
  chunk,
  step,
  nodeLabel
}: {
  chunk: ChunkSnapshot
  step: number
  nodeLabel: string | null
}): React.JSX.Element {
  const openPreview = usePreview((s) => s.open)
  const live = useChunkProgress(chunk.id)
  const tone = STATUS_VARS[CHUNK_TONE[chunk.state]]
  const cancelled = chunk.state === 'cancelled'
  const failed = chunk.state === 'failed'
  const total = chunkFrames(chunk, step)
  // The DB column is a floor: it only moves when the poller writes it. Live
  // progress leads it, so prefer whichever is further along.
  const done =
    chunk.state === 'complete' ? total : Math.max(chunk.framesDone, live?.framesDone ?? 0)
  const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0
  // Openable as soon as there is anything to see, not only when complete —
  // watching a chunk render is the point of the live preview.
  const clickable = done > 0 || chunk.state !== 'pending'
  const info = chunkCellInfo(chunk, nodeLabel)
  const open = (): void => openPreview({ jobId: chunk.jobId, chunkId: chunk.id })
  return (
    <div
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      data-chunk-state={chunk.state}
      onClick={clickable ? open : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                open()
              }
            }
          : undefined
      }
      title={info.title}
      style={{
        position: 'relative',
        overflow: 'hidden',
        border: `1px solid ${tone.border}`,
        background: tone.fill,
        color: cancelled ? TOKENS.textSecondary : tone.text,
        borderRadius: SCALE.radiusSm,
        padding: '6px 8px',
        minWidth: 0,
        cursor: clickable ? 'pointer' : 'default'
      }}
    >
      {cancelled ? (
        // The hatching faint enough that the words over it still read.
        <div
          className="vr-progress-hatch"
          aria-hidden="true"
          style={{ position: 'absolute', inset: 0, opacity: 0.4, pointerEvents: 'none' }}
        />
      ) : null}
      <div
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 4
        }}
      >
        <span style={{ ...mono, fontSize: SCALE.textXs, whiteSpace: 'nowrap' }}>
          {chunk.frameStart}–{chunk.frameEnd}
        </span>
        {info.mark ? (
          <span
            aria-hidden="true"
            style={{
              ...mono,
              fontWeight: SCALE.weightBold,
              fontSize: SCALE.textSm,
              lineHeight: 1,
              color: failed ? TOKENS.text : TOKENS.textSecondary
            }}
          >
            {info.mark}
          </span>
        ) : null}
      </div>
      <div style={{ position: 'relative', fontSize: 'var(--text-2xs)', opacity: 0.85 }}>
        {info.label}
        {chunk.retries > 0 ? ` · retry ${chunk.retries}` : ''}
      </div>
      <div
        style={{
          position: 'relative',
          height: 2,
          background: 'rgba(255,255,255,0.18)',
          borderRadius: 1,
          marginTop: 4
        }}
      >
        <div
          style={{
            height: '100%',
            width: `${pct}%`,
            background: cancelled ? TOKENS.textMuted : 'rgba(255,255,255,0.9)',
            borderRadius: 1
          }}
        />
      </div>
    </div>
  )
}

const LEGEND: Array<{ tone: StatusTone; label: string; mark?: string; hatch?: boolean }> = [
  { tone: 'queued', label: 'queued' },
  { tone: 'running', label: 'rendering' },
  { tone: 'done', label: 'complete' },
  { tone: 'error', label: 'failed', mark: '!' },
  { tone: 'dead', label: 'cancelled', mark: '–', hatch: true }
]

export function ChunkLegend(): React.JSX.Element {
  return (
    <div
      aria-label="chunk states"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: `4px ${SCALE.space3}`,
        fontSize: 'var(--text-2xs)',
        color: TOKENS.textFaint
      }}
    >
      {LEGEND.map((l) => (
        <span key={l.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span
            className={l.hatch ? 'vr-progress-hatch' : undefined}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 14,
              height: 11,
              borderRadius: 2,
              border: `1px solid ${STATUS_VARS[l.tone].border}`,
              ...(l.hatch ? null : { background: STATUS_VARS[l.tone].fill }),
              color: l.tone === 'error' ? TOKENS.text : TOKENS.textMuted,
              ...mono,
              fontSize: 9,
              fontWeight: SCALE.weightBold,
              lineHeight: 1
            }}
          >
            {l.mark ?? ''}
          </span>
          {l.label}
        </span>
      ))}
      <span style={{ marginLeft: 'auto' }}>click a chunk to preview it</span>
    </div>
  )
}

export function ChunkGrid({
  chunks,
  step,
  nodeLabel,
  maxHeight
}: {
  chunks: readonly ChunkSnapshot[]
  step: number
  /** a node's name for the tooltips ("RTX 4090 #1234567"); null = its id */
  nodeLabel?: (nodeId: string) => string | null
  /** px the grid may grow to before it scrolls; none = its full height */
  maxHeight?: number
}): React.JSX.Element {
  return (
    <div
      style={{
        ...panel(),
        padding: SCALE.space3,
        display: 'flex',
        flexDirection: 'column',
        gap: SCALE.space3,
        minWidth: 0,
        ...(maxHeight ? { height: maxHeight } : null)
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(104px, 1fr))',
          gap: SCALE.space2,
          alignContent: 'start',
          overflow: 'auto',
          flex: maxHeight ? 1 : undefined,
          minHeight: 0
        }}
      >
        {chunks.map((c) => (
          <ChunkCell
            key={c.id}
            chunk={c}
            step={step}
            nodeLabel={c.nodeId && nodeLabel ? nodeLabel(c.nodeId) : null}
          />
        ))}
        {chunks.length === 0 ? (
          <span style={{ fontSize: SCALE.textXs, color: TOKENS.textFaint }}>No chunks.</span>
        ) : null}
      </div>
      <ChunkLegend />
    </div>
  )
}
