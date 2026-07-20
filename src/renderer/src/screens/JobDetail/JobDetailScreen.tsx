import { useEffect, useMemo, useRef, useState } from 'react'
import { AppToolbar } from '../../components/AppToolbar'
import { OpenInExplorerButton } from '../../components/OpenInExplorerButton'
import {
  btn,
  iconBtn,
  logLine,
  mono,
  panel,
  readout,
  sectionLabel,
  segmented
} from '../../lib/controls'
import { basename, fmtFrames, fmtMoney } from '../../lib/format'
import { ipc } from '../../lib/ipc'
import { useLogStore } from '../../lib/logStore'
import { useNav } from '../../lib/nav'
import { useJob } from '../../lib/queries'
import { SCALE, STATUS_VARS, TOKENS, type StatusTone } from '../../lib/theme'
import type { ChunkSnapshot, ChunkState } from '../../../../shared/models'

const CHUNK_TONE: Record<ChunkState, StatusTone> = {
  pending: 'queued',
  assigned: 'queued',
  rendering: 'running',
  encoding: 'running',
  downloading: 'running',
  complete: 'done',
  failed: 'error'
}

function ChunkCell({ chunk }: { chunk: ChunkSnapshot }): React.JSX.Element {
  const { navigate } = useNav()
  const tone = STATUS_VARS[CHUNK_TONE[chunk.state]]
  const total = chunk.frameEnd - chunk.frameStart + 1
  const pct = total > 0 ? Math.min(100, (chunk.framesDone / total) * 100) : 0
  const clickable = chunk.state === 'complete'
  return (
    <div
      onClick={
        clickable
          ? () => navigate({ screen: 'gallery', jobId: chunk.jobId, chunkId: chunk.id })
          : undefined
      }
      title={`${chunk.id}${chunk.nodeId ? ` on ${chunk.nodeId.slice(0, 8)}` : ''}${chunk.retries ? ` (retry ${chunk.retries})` : ''}`}
      style={{
        border: `1px solid ${tone.border}`,
        background: tone.fill,
        color: tone.text,
        borderRadius: SCALE.radiusSm,
        padding: '6px 8px',
        minWidth: 92,
        cursor: clickable ? 'pointer' : 'default'
      }}
    >
      <div style={{ ...mono, fontSize: SCALE.textXs }}>
        {chunk.frameStart}–{chunk.frameEnd}
      </div>
      <div style={{ fontSize: 'var(--text-2xs)', opacity: 0.8 }}>{chunk.state}</div>
      <div
        style={{ height: 2, background: 'rgba(255,255,255,0.25)', borderRadius: 1, marginTop: 4 }}
      >
        <div
          style={{
            height: '100%',
            width: `${pct}%`,
            background: 'rgba(255,255,255,0.9)',
            borderRadius: 1
          }}
        />
      </div>
    </div>
  )
}

const LINE_H = 16

function LogPanel({ nodeIds }: { nodeIds: string[] }): React.JSX.Element {
  const byNode = useLogStore((s) => s.byNode)
  const [selected, setSelected] = useState<string | null>(null)
  const [autoscroll, setAutoscroll] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [range, setRange] = useState({ from: 0, to: 200 })

  const activeNode = selected ?? nodeIds[0] ?? null
  const lines = useMemo(() => (activeNode ? (byNode[activeNode] ?? []) : []), [byNode, activeNode])

  // Manual windowing: fixed line height, render only the visible slice.
  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    const from = Math.max(0, Math.floor(el.scrollTop / LINE_H) - 20)
    const to = Math.min(lines.length, from + Math.ceil(el.clientHeight / LINE_H) + 40)
    setRange({ from, to })
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - LINE_H * 2
    setAutoscroll(atBottom)
  }

  useEffect(() => {
    const el = scrollRef.current
    if (el && autoscroll) {
      el.scrollTop = el.scrollHeight
      const from = Math.max(0, lines.length - Math.ceil(el.clientHeight / LINE_H) - 40)
      setRange({ from, to: lines.length })
    }
  }, [lines.length, autoscroll])

  return (
    <div style={{ ...panel(), display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: SCALE.space2,
          padding: SCALE.space2,
          borderBottom: `1px solid ${TOKENS.border}`
        }}
      >
        <span style={sectionLabel()}>logs</span>
        {nodeIds.map((id, i) => (
          <button
            key={id}
            style={segmented({
              active: id === activeNode,
              position:
                nodeIds.length === 1
                  ? 'only'
                  : i === 0
                    ? 'first'
                    : i === nodeIds.length - 1
                      ? 'last'
                      : 'middle'
            })}
            onClick={() => setSelected(id)}
          >
            <span style={mono}>{id.slice(0, 8)}</span>
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <button
          title="Autoscroll"
          style={iconBtn({ size: 'sm', active: autoscroll })}
          onClick={() => setAutoscroll(!autoscroll)}
        >
          ⇣
        </button>
      </div>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        style={{ flex: 1, overflow: 'auto', padding: SCALE.space2, minHeight: 0 }}
      >
        <div style={{ height: lines.length * LINE_H, position: 'relative' }}>
          {lines.slice(range.from, range.to).map((l, i) => (
            <div
              key={range.from + i}
              style={{
                ...logLine(),
                position: 'absolute',
                top: (range.from + i) * LINE_H,
                left: 0,
                right: 0,
                height: LINE_H,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis'
              }}
            >
              {l.line}
            </div>
          ))}
        </div>
        {lines.length === 0 ? (
          <span style={{ fontSize: SCALE.textXs, color: TOKENS.textFaint }}>
            No log output yet.
          </span>
        ) : null}
      </div>
    </div>
  )
}

export function JobDetailScreen({ jobId }: { jobId: string }): React.JSX.Element {
  const { data: job } = useJob(jobId)
  const { navigate } = useNav()

  const nodeIds = useMemo(() => {
    const ids = new Set<string>()
    for (const c of job?.chunks ?? []) if (c.nodeId) ids.add(c.nodeId)
    return [...ids]
  }, [job])

  const running = job && ['queued', 'running'].includes(job.state)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <AppToolbar
        right={
          job ? (
            <>
              <span style={readout()}>
                <span style={{ color: TOKENS.textFaint }}>frames</span>
                <span style={mono}>{fmtFrames(job.framesDone, job.framesTotal)}</span>
                <span style={{ color: TOKENS.textFaint }}>·</span>
                <span style={mono}>{fmtMoney(job.costSoFar)}</span>
              </span>
              <button
                style={btn({ size: 'sm' })}
                onClick={() => void ipc.invoke('shell:openPath', job.outputDir)}
              >
                open output
              </button>
              {running ? (
                <button
                  style={btn({ variant: 'danger', size: 'sm' })}
                  onClick={() => void ipc.invoke('job:cancel', jobId)}
                >
                  cancel
                </button>
              ) : null}
            </>
          ) : undefined
        }
        subRow={
          <>
            <button
              style={btn({ variant: 'ghost', size: 'sm' })}
              onClick={() => navigate({ screen: 'jobs' })}
            >
              Jobs
            </button>
            <span style={{ color: TOKENS.textFaint }}>/</span>
            <span style={{ fontSize: SCALE.textSm, color: TOKENS.textSecondary }}>
              {job ? job.name || basename(job.blendPath) : jobId}
            </span>
            {job?.blenderVersion ? (
              <span style={{ ...mono, fontSize: 'var(--text-2xs)', color: TOKENS.textFaint }}>
                blender {job.blenderVersion}
              </span>
            ) : null}
            {job ? <OpenInExplorerButton path={job.blendPath} /> : null}
          </>
        }
      />
      <div
        style={{ flex: 1, display: 'flex', gap: SCALE.space4, padding: SCALE.space4, minHeight: 0 }}
      >
        <div
          style={{
            flex: '0 0 58%',
            display: 'flex',
            flexDirection: 'column',
            gap: SCALE.space3,
            minHeight: 0
          }}
        >
          <span style={sectionLabel()}>chunks</span>
          <div
            style={{
              ...panel(),
              padding: SCALE.space3,
              display: 'flex',
              flexWrap: 'wrap',
              gap: SCALE.space2,
              alignContent: 'flex-start',
              overflow: 'auto'
            }}
          >
            {(job?.chunks ?? []).map((c) => (
              <ChunkCell key={c.id} chunk={c} />
            ))}
            {job && job.chunks.length === 0 ? (
              <span style={{ fontSize: SCALE.textXs, color: TOKENS.textFaint }}>No chunks.</span>
            ) : null}
          </div>
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <LogPanel nodeIds={nodeIds} />
        </div>
      </div>
    </div>
  )
}
