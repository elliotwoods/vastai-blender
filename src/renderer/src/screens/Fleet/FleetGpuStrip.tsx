/**
 * The Fleet screen's top strip (Feature G): how many of the GPUs being paid
 * for are working, now and over the window. Paid GPUs sat idle unseen: the
 * phantom runs of job 81fe2875 held 7 of 24, and the Fleet showed only each
 * node's latest sample, as meters. Here "busy" is drawn under "rented", so
 * the space between the two lines is the idle share; the readout adds the
 * mean utilisation and the $/hr those idle GPUs cost.
 *
 * GPU counts and a percentage are different units, so they never share an
 * axis: the chart plots counts, and mean utilisation is a figure and a
 * hover line.
 */

import type { CSSProperties } from 'react'
import { TimeChart } from '../../components/charts/TimeChart'
import { InfoHint } from '../../components/Tooltip'
import { panel, sectionLabel } from '../../lib/controls'
import { fmtRate } from '../../lib/format'
import { useFleetGpuHistory } from '../../lib/queries'
import { ipcErrorText } from '../../lib/recovery'
import { SCALE, TOKENS } from '../../lib/theme'
import { rangeMs, useStoredRange } from '../../lib/usageRange'
import { useNow } from '../../lib/useNow'
import { GPU_BUSY_UTIL_PCT } from '../../../../shared/models'
import { RangePicker } from './RangePicker'
import {
  clockFormatter,
  fleetStripSeries,
  fmtGpus,
  gpuAxisMax,
  latestFleetPoint
} from './usageCharts'

const HINT =
  `GPUs on nodes that may be billing, and how many of them are busy: above ${GPU_BUSY_UTIL_PCT}% ` +
  'utilisation, or with a render pinned to them. The gap between the lines is GPUs paid for and ' +
  'idle; hover for the mean utilisation and what the idle ones cost per hour.'

const figure: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }
const figureValue: CSSProperties = {
  fontSize: SCALE.textXl,
  fontWeight: SCALE.weightSemibold,
  lineHeight: 1.1,
  color: TOKENS.text,
  whiteSpace: 'nowrap'
}

function Figure({
  label,
  value,
  sub,
  tone
}: {
  label: string
  value: string
  sub?: string
  tone?: string
}): React.JSX.Element {
  return (
    <div style={figure}>
      <span style={sectionLabel()}>{label}</span>
      <span style={{ ...figureValue, color: tone ?? TOKENS.text }}>{value}</span>
      {sub ? <span style={{ fontSize: SCALE.textXs, color: TOKENS.textFaint }}>{sub}</span> : null}
    </div>
  )
}

/**
 * `hasNodes`: the Fleet lists a node. Without one the strip shows only if
 * its window saw GPUs rented, so a fleet that has scaled down can still be
 * looked back on, and a profile that never rented shows no empty chart.
 */
export function FleetGpuStrip({ hasNodes }: { hasNodes: boolean }): React.JSX.Element | null {
  const [range, setRange] = useStoredRange('vr:fleet:gpuRange', '1h')
  const { data, error, isPlaceholderData } = useFleetGpuHistory(range)
  // The chart's right edge is now, between reads too.
  const now = useNow(15_000)
  const span = rangeMs(range)
  const toMs = Math.max(now, data?.toMs ?? 0)
  const fromMs = toMs - span
  const strip = data ? fleetStripSeries(data) : null
  const latest = latestFleetPoint(data)
  const formatX = clockFormatter(span)

  if (!hasNodes && !(strip && strip.peakRented > 0)) return null

  const busy = latest?.gpusBusy ?? null
  const rented = latest?.gpusRented ?? null
  const idle = latest?.idlePerHour ?? null

  return (
    <div style={{ ...panel(), padding: `${SCALE.space3} ${SCALE.space3} 0` }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: SCALE.space3,
          marginBottom: SCALE.space2
        }}
      >
        <span style={{ ...sectionLabel(), display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          gpu use
          <InfoHint text={HINT} size={10} />
        </span>
        <span style={{ flex: 1 }} />
        {error ? (
          <span style={{ fontSize: SCALE.textXs, color: TOKENS.textFaint }}>
            history unavailable: {ipcErrorText(error)}
          </span>
        ) : null}
        <RangePicker value={range} onChange={setRange} label="GPU use window" />
      </div>
      <div style={{ display: 'flex', gap: SCALE.space4, alignItems: 'stretch' }}>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: SCALE.space3,
            width: 132,
            flex: 'none',
            paddingTop: 4
          }}
        >
          <Figure
            label="gpus busy"
            value={busy != null && rented != null ? `${fmtGpus(busy)} / ${fmtGpus(rented)}` : '—'}
            sub={latest ? 'latest reading' : 'no reading yet'}
          />
          <Figure
            label="mean util"
            value={latest?.meanUtil != null ? `${latest.meanUtil.toFixed(0)}%` : '—'}
          />
          <Figure
            label="idle"
            value={idle != null ? fmtRate(idle) : '—'}
            // Money paid for nothing is the one figure here that wants attention.
            tone={idle != null && idle > 0 ? TOKENS.warn : undefined}
          />
        </div>
        <div
          style={{
            flex: 1,
            minWidth: 0,
            // Refetch keeps the frame: the previous range's chart stays, dimmed.
            opacity: isPlaceholderData ? 0.55 : 1,
            transition: 'opacity 120ms'
          }}
        >
          <TimeChart
            kind="line"
            height={150}
            fromMs={fromMs}
            toMs={toMs}
            spanMs={data?.bucketMs}
            yMax={gpuAxisMax(strip?.peakRented ?? 0)}
            format={fmtGpus}
            formatX={formatX}
            emptyNote="no GPUs rented in this window"
            series={
              strip
                ? [
                    {
                      id: 'rented',
                      label: 'rented',
                      color: TOKENS.textMuted,
                      points: strip.rented
                    },
                    {
                      id: 'busy',
                      label: 'busy',
                      color: TOKENS.accent,
                      points: strip.busy,
                      area: true
                    }
                  ]
                : []
            }
            tooltipExtra={(x) => {
              const p = strip?.byX.get(x)
              if (!p) return null
              const lines: string[] = []
              if (p.meanUtil != null) lines.push(`mean util ${p.meanUtil.toFixed(0)}%`)
              if (p.idlePerHour != null) lines.push(`idle ${fmtRate(p.idlePerHour)}`)
              return lines
            }}
          />
        </div>
      </div>
    </div>
  )
}
