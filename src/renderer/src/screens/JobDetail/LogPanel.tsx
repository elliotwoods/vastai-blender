/**
 * The job's nodes' logs, one node at a time, windowed by hand (a fixed line
 * height, only the visible slice rendered) and following the newest line
 * until the user scrolls up. A fixed height, so it sits beside or under the
 * chunk grid without pushing the page around as lines arrive.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../components/Icon'
import { iconBtn, logLine, mono, panel, sectionLabel, segmented } from '../../lib/controls'
import { useLogStore } from '../../lib/logStore'
import { SCALE, TOKENS } from '../../lib/theme'

export const LOG_HEIGHT = 360
const LINE_H = 16

export function LogPanel({
  nodeIds,
  height = LOG_HEIGHT
}: {
  nodeIds: string[]
  /** px; the panel keeps it whatever it holds */
  height?: number
}): React.JSX.Element {
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
    <div style={{ ...panel(), display: 'flex', flexDirection: 'column', height, minWidth: 0 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
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
          aria-label="Autoscroll"
          aria-pressed={autoscroll}
          style={iconBtn({ size: 'sm', active: autoscroll })}
          onClick={() => setAutoscroll(!autoscroll)}
        >
          <Icon name="autoscroll" />
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
