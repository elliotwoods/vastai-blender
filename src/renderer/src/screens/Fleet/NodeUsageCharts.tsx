/**
 * One node's GPU use over time, in NodeDetail (Feature G): each GPU's
 * utilisation and VRAM, and the node's power, under one range picker.
 * Where a GPU sat at or under GPU_BUSY_UTIL_PCT with a run assigned, the
 * utilisation chart is shaded: paid for and idle, the state the phantom
 * runs of job 81fe2875 left 7 of 24 GPUs in, and the one the lane fixes
 * (1.11) are checked against. A tick along the top marks each chunk sent to
 * the node.
 *
 * The last hour is drawn from the live store (lib/metricsStore); 6 h and
 * 24 h are read from main's history and refreshed each minute. Watts and
 * percent never share an axis, so power has its own chart.
 */

import { useMemo, type CSSProperties } from 'react'
import { TimeChart, type TimeMarker } from '../../components/charts/TimeChart'
import { Icon } from '../../components/Icon'
import { InfoHint } from '../../components/Tooltip'
import { sectionLabel } from '../../lib/controls'
import { fmtWatts } from '../../lib/format'
import { RING_MS, readingsOfHistory } from '../../lib/metricsStore'
import { useNodeChunks, useNodeMetricsHistory, useNodeReadings } from '../../lib/queries'
import { ipcErrorText } from '../../lib/recovery'
import { SCALE, TOKENS } from '../../lib/theme'
import { rangeMs, useStoredRange } from '../../lib/usageRange'
import { useNow } from '../../lib/useNow'
import { GPU_BUSY_UTIL_PCT, type NodeSnapshot } from '../../../../shared/models'
import { RangePicker } from './RangePicker'
import {
  IDLE_BAND_LABEL,
  clockFormatter,
  liveWindow,
  maxGapMs,
  nodeUsageCharts
} from './usageCharts'

const pct = (v: number): string => `${v.toFixed(0)}%`

const chartTitle: CSSProperties = {
  ...sectionLabel(),
  fontSize: SCALE.text2xs,
  padding: `0 0 2px 58px`
}

const IDLE_HINT =
  `Shaded where a GPU sat at or under ${GPU_BUSY_UTIL_PCT}% while a render was assigned to it: ` +
  'paid for and doing nothing. A tick along the top marks each chunk sent to this node.'

export function NodeUsageCharts({ node }: { node: NodeSnapshot }): React.JSX.Element {
  const [range, setRange] = useStoredRange('vr:fleet:nodeRange', '1h')
  const span = rangeMs(range)
  const live = span <= RING_MS
  const readingsLive = useNodeReadings(node.id)
  const history = useNodeMetricsHistory(node.id, range, !live)
  const chunks = useNodeChunks(node.id)
  // The right edge is now, and moves with each poll.
  const now = useNow(15_000)

  const historyData = history.data
  const readings = useMemo(
    () => (live ? readingsLive : historyData ? readingsOfHistory(historyData) : []),
    [live, readingsLive, historyData]
  )
  const { fromMs, toMs } = liveWindow(readings, now, span)
  const maxGap = maxGapMs(live ? 0 : (historyData?.bucketMs ?? 0))
  // Not memoised: a few hundred readings, redrawn once a poll, and the
  // window slides with the clock anyway.
  const charts = nodeUsageCharts(readings, fromMs, toMs, maxGap)
  const markers = useMemo<TimeMarker[]>(
    () =>
      (chunks.data ?? [])
        .filter((c) => c.assignedAt != null)
        .map((c) => ({
          atMs: c.assignedAt as number,
          label: `sent ${c.jobName} ${c.frameStart}–${c.frameEnd}${c.gpu != null ? ` to GPU ${c.gpu}` : ''}`
        })),
    [chunks.data]
  )
  const formatX = clockFormatter(span)
  const powerLimit = node.metrics?.powerLimitW ?? 0
  const waiting = !live && history.isLoading
  const empty = waiting ? 'loading…' : 'no readings in this window'

  return (
    <div>
      <div
        style={{
          ...sectionLabel(),
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          marginBottom: 5
        }}
      >
        <Icon name="activity" size={11} />
        gpu use over time
        <InfoHint text={IDLE_HINT} size={10} />
        <span style={{ flex: 1 }} />
        {history.error && !live ? (
          <span style={{ textTransform: 'none', letterSpacing: 0, color: TOKENS.textFaint }}>
            history unavailable: {ipcErrorText(history.error)}
          </span>
        ) : null}
        <RangePicker value={range} onChange={setRange} label="Node GPU use window" />
      </div>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: SCALE.space2,
          background: TOKENS.surfaceRaised,
          border: `1px solid ${TOKENS.border}`,
          borderRadius: SCALE.radiusSm,
          padding: `${SCALE.space2} 0 ${SCALE.space1}`,
          opacity: history.isPlaceholderData && !live ? 0.55 : 1,
          transition: 'opacity 120ms'
        }}
      >
        <div>
          <div style={chartTitle}>gpu utilisation %</div>
          <TimeChart
            kind="line"
            height={150}
            fromMs={fromMs}
            toMs={toMs}
            yMax={100}
            format={pct}
            formatX={formatX}
            series={charts.util}
            bands={charts.idle}
            bandLabel={IDLE_BAND_LABEL}
            markers={markers}
            emptyNote={empty}
          />
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: SCALE.space2 }}>
          <div style={{ flex: '1 1 320px', minWidth: 0 }}>
            <div style={chartTitle}>vram used %</div>
            <TimeChart
              kind="line"
              height={120}
              fromMs={fromMs}
              toMs={toMs}
              yMax={100}
              format={pct}
              formatX={formatX}
              series={charts.vram}
              emptyNote={empty}
            />
          </div>
          <div style={{ flex: '1 1 320px', minWidth: 0 }}>
            <div style={chartTitle}>gpu power, all cards</div>
            <TimeChart
              kind="line"
              height={120}
              fromMs={fromMs}
              toMs={toMs}
              // Out of the cards' summed power limit where the node reports
              // one, so the line reads as headroom, like the gauge above.
              yMax={powerLimit > 0 ? powerLimit : undefined}
              format={fmtWatts}
              formatX={formatX}
              series={
                charts.power.length > 0
                  ? [{ id: 'power', label: 'power', color: TOKENS.accent, points: charts.power }]
                  : []
              }
              emptyNote={waiting ? empty : 'no power readings in this window'}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
