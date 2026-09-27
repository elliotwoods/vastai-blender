/**
 * The job's chunks. A few of them are cards, each its frame range, its state
 * in a word, and a thin bar of its frames done. Past DENSE_AFTER (a job cut
 * into 2-frame chunks has a hundred and more) they are a map of small tiles
 * instead, a row per run of chunks labelled with its first frame: cards at
 * that count were a wall of identical boxes, and squeezed into the log's
 * height, unreadable slivers. Failed and cancelled read apart
 * at a glance: failed is red and marked "!", cancelled is grey hatching
 * marked "–", with a legend under the grid saying which is which. A cell's
 * tooltip carries its node, retries and last error; a click opens the
 * preview at that chunk as soon as there is anything to see.
 */

import { useRef } from 'react'
import { useWidth } from '../../components/charts/useWidth'
import { mono, panel } from '../../lib/controls'
import { usePreview } from '../../lib/preview'
import { useChunkProgress } from '../../lib/progressStore'
import { CHUNK_TONE, SCALE, STATUS_VARS, TOKENS, type StatusTone } from '../../lib/theme'
import type { ChunkSnapshot } from '../../../../shared/models'
import {
  chunkCellInfo,
  chunkFrames,
  DENSE_AFTER,
  isActiveChunk,
  LABEL_W,
  TILE_GAP,
  tilesPerRow
} from './jobDetailModel'

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

const TILE_H = 18

function ChunkTile({
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
  const total = chunkFrames(chunk, step)
  const done =
    chunk.state === 'complete' ? total : Math.max(chunk.framesDone, live?.framesDone ?? 0)
  const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0
  const clickable = done > 0 || chunk.state !== 'pending'
  const info = chunkCellInfo(chunk, nodeLabel)
  const open = (): void => openPreview({ jobId: chunk.jobId, chunkId: chunk.id })
  return (
    <div
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-label={`frames ${chunk.frameStart}–${chunk.frameEnd}, ${info.label}`}
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
      className={chunk.state === 'cancelled' ? 'vr-progress-hatch' : undefined}
      style={{
        position: 'relative',
        overflow: 'hidden',
        height: TILE_H,
        minWidth: 0,
        borderRadius: 2,
        border: `1px solid ${tone.border}`,
        ...(chunk.state === 'cancelled' ? null : { background: tone.fill }),
        cursor: clickable ? 'pointer' : 'default',
        display: 'grid',
        placeItems: 'center'
      }}
    >
      {isActiveChunk(chunk.state) ? (
        // Frames done, filling from the bottom.
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            height: `${pct}%`,
            background: 'rgba(255,255,255,0.35)'
          }}
        />
      ) : null}
      {info.mark ? (
        <span
          aria-hidden="true"
          style={{
            position: 'relative',
            ...mono,
            fontSize: 10,
            fontWeight: SCALE.weightBold,
            lineHeight: 1,
            color: chunk.state === 'failed' ? TOKENS.text : TOKENS.textSecondary
          }}
        >
          {info.mark}
        </span>
      ) : null}
    </div>
  )
}

function ChunkMap({
  chunks,
  step,
  nodeLabel,
  perRow
}: {
  chunks: readonly ChunkSnapshot[]
  step: number
  nodeLabel?: (nodeId: string) => string | null
  perRow: number
}): React.JSX.Element {
  const rows: ChunkSnapshot[][] = []
  for (let i = 0; i < chunks.length; i += perRow) rows.push(chunks.slice(i, i + perRow))
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `${LABEL_W}px repeat(${perRow}, minmax(0, 1fr))`,
        gap: TILE_GAP,
        alignItems: 'center'
      }}
    >
      {rows.map((row) => [
        <span
          key={`l-${row[0].id}`}
          style={{
            ...mono,
            fontSize: 'var(--text-2xs)',
            color: TOKENS.textFaint,
            textAlign: 'right',
            paddingRight: 4
          }}
        >
          {row[0].frameStart}
        </span>,
        ...row.map((c) => (
          <ChunkTile
            key={c.id}
            chunk={c}
            step={step}
            nodeLabel={c.nodeId && nodeLabel ? nodeLabel(c.nodeId) : null}
          />
        ))
      ])}
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
  const ref = useRef<HTMLDivElement>(null)
  const width = useWidth(ref)
  const byFrame = [...chunks].sort((a, b) => a.frameStart - b.frameStart)
  const dense = byFrame.length > DENSE_AFTER
  return (
    <div
      style={{
        ...panel(),
        padding: SCALE.space3,
        display: 'flex',
        flexDirection: 'column',
        gap: SCALE.space3,
        minWidth: 0,
        ...(maxHeight ? { maxHeight } : null)
      }}
    >
      <div ref={ref} style={{ overflow: 'auto', minHeight: 0, flexShrink: 1 }}>
        {dense ? (
          <ChunkMap
            chunks={byFrame}
            step={step}
            nodeLabel={nodeLabel}
            perRow={tilesPerRow(width)}
          />
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(104px, 1fr))',
              // Rows at their content's height: auto rows let a height-capped
              // grid squash its cards (overflow: hidden takes their minimum
              // height to 0).
              gridAutoRows: 'max-content',
              gap: SCALE.space2
            }}
          >
            {byFrame.map((c) => (
              <ChunkCell
                key={c.id}
                chunk={c}
                step={step}
                nodeLabel={c.nodeId && nodeLabel ? nodeLabel(c.nodeId) : null}
              />
            ))}
            {byFrame.length === 0 ? (
              <span style={{ fontSize: SCALE.textXs, color: TOKENS.textFaint }}>No chunks.</span>
            ) : null}
          </div>
        )}
      </div>
      <ChunkLegend />
    </div>
  )
}
