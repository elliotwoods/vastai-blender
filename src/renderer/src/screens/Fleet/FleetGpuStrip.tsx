/**
 * The Fleet screen's top strip (Feature G): how many of the GPUs being paid
 * for are working, now and over the window. Paid GPUs sat idle unseen: the
 * phantom runs of job 81fe2875 held 7 of 24, and the Fleet showed only each
 * node's latest sample, as meters. Here "busy" is drawn under "rented", so
 * the space between the two lines is the idle share; the readout adds the
 * mean utilisation and the $/hr those idle GPUs cost.
 *
 * GPU counts and a percentage are different units, so they never share an
 * axis: the combined chart plots counts, and "per GPU" plots each GPU's
 * utilisation 0–100% on its own chart.
 *
 * The lead figure, "mean util", is over the whole window chosen (main's
 * summary, each GPU weighted by the time it was rented), not the newest
 * bucket: a fleet that idled for most of the hour and is busy now averaged
 * low, and that is what the hour cost. The other figures are the latest
 * reading and say so.
 */

import { useState, type CSSProperties } from 'react'
import { TimeChart } from '../../components/charts/TimeChart'
import { InfoHint } from '../../components/Tooltip'
import { panel, sectionLabel, segmented } from '../../lib/controls'
import { fmtMoney, fmtRate } from '../../lib/format'
import { useFleetGpuHistory } from '../../lib/queries'
import { ipcErrorText } from '../../lib/recovery'
import { SCALE, TOKENS } from '../../lib/theme'
import { USAGE_RANGES, rangeMs, useStoredRange } from '../../lib/usageRange'
import { useNow } from '../../lib/useNow'
import { GPU_BUSY_UTIL_PCT } from '../../../../shared/models'
import { RangePicker } from './RangePicker'
import {
  clockFormatter,
  fleetGpuLines,
  fleetStripSeries,
  fmtGpus,
  gpuAxisMax,
  latestFleetPoint
} from './usageCharts'

const HINT =
  `GPUs on nodes that may be billing, and how many of them are busy: above ${GPU_BUSY_UTIL_PCT}% ` +
  'utilisation, or with a render pinned to them. The gap between the lines is GPUs paid for and ' +
  'idle. "Per GPU" draws each GPU\'s utilisation instead. Mean util is over the whole window, ' +
  'each GPU weighted by the time it was rented; the other figures are the latest reading.'

type GpuView = 'combined' | 'perGpu'

const VIEW_KEY = 'vr:fleet:gpuView'
const VIEWS: ReadonlyArray<{ key: GpuView; label: string }> = [
  { key: 'combined', label: 'combined' },
  { key: 'perGpu', label: 'per GPU' }
]
/** Rows the per-GPU readout lists before "+N more": the busiest at the crosshair. */
const TOOLTIP_GPUS = 8

/** The strip's view, remembered like its range; storage is a convenience, never required. */
function useStoredView(): [GpuView, (v: GpuView) => void] {
  const [view, setView] = useState<GpuView>(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === 'perGpu' ? 'perGpu' : 'combined'
    } catch {
      return 'combined'
    }
  })
  const set = (v: GpuView): void => {
    setView(v)
    try {
      localStorage.setItem(VIEW_KEY, v)
    } catch {
      // best-effort persistence
    }
  }
  return [view, set]
}

function ViewPicker({
  value,
  onChange
}: {
  value: GpuView
  onChange: (v: GpuView) => void
}): React.JSX.Element {
  return (
    <span role="group" aria-label="GPU use view" style={{ display: 'flex' }}>
      {VIEWS.map((v, i) => (
        <button
          key={v.key}
          type="button"
          aria-pressed={v.key === value}
          style={segmented({ active: v.key === value, position: i === 0 ? 'first' : 'last' })}
          onClick={() => onChange(v.key)}
        >
          {v.label}
        </button>
      ))}
    </span>
  )
}

const figure: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }
const figureValue: CSSProperties = {
  fontSize: SCALE.textXl,
  fontWeight: SCALE.weightSemibold,
  lineHeight: 1.1,
  color: TOKENS.text,
  whiteSpace: 'nowrap'
}
const note: CSSProperties = { fontSize: SCALE.textXs, color: TOKENS.textFaint }

function Figure({
  label,
  value,
  sub,
  tone,
  lead = false
}: {
  label: string
  value: string
  sub?: string
  tone?: string
  /** the strip's headline figure, drawn larger */
  lead?: boolean
}): React.JSX.Element {
  return (
    <div style={figure}>
      <span style={sectionLabel()}>{label}</span>
      <span
        style={{
          ...figureValue,
          ...(lead ? { fontSize: `calc(${SCALE.textXl} * 1.6)` } : null),
          color: tone ?? TOKENS.text
        }}
      >
        {value}
      </span>
      {sub ? <span style={note}>{sub}</span> : null}
    </div>
  )
}

const pct = (v: number): string => `${v.toFixed(0)}%`

/**
 * `hasNodes`: the Fleet lists a node. Without one the strip shows only if
 * its window saw GPUs rented, so a fleet that has scaled down can still be
 * looked back on, and a profile that never rented shows no empty chart.
 */
export function FleetGpuStrip({ hasNodes }: { hasNodes: boolean }): React.JSX.Element | null {
  const [range, setRange] = useStoredRange('vr:fleet:gpuRange', '1h')
  const [view, setView] = useStoredView()
  const perGpu = view === 'perGpu'
  const { data, error, isPlaceholderData } = useFleetGpuHistory(range, { perGpu })
  // The chart's right edge is now, between reads too.
  const now = useNow(15_000)
  const span = rangeMs(range)
  const toMs = Math.max(now, data?.toMs ?? 0)
  const fromMs = toMs - span
  const strip = data ? fleetStripSeries(data) : null
  const latest = latestFleetPoint(data)
  const formatX = clockFormatter(span)
  // Just after switching to "per GPU", the combined read stands in until the
  // per-GPU one lands, and it has no lines to draw.
  const lines = perGpu && data?.gpus ? fleetGpuLines(data) : null
  const omitted = perGpu ? (data?.gpusOmitted ?? 0) : 0

  if (!hasNodes && !(strip && strip.peakRented > 0)) return null

  const busy = latest?.gpusBusy ?? null
  const rented = latest?.gpusRented ?? null
  const idle = latest?.idlePerHour ?? null
  const summary = data?.summary ?? null
  const over = `over the last ${USAGE_RANGES.find((r) => r.key === range)?.label ?? range}`

  const tooltipExtra = (x: number): string[] | null => {
    const p = strip?.byX.get(x)
    if (!p) return null
    const lines: string[] = []
    if (perGpu && p.gpusBusy != null && p.gpusRented != null) {
      lines.push(`${fmtGpus(p.gpusBusy)} / ${fmtGpus(p.gpusRented)} GPUs busy`)
    }
    if (p.meanUtil != null) lines.push(`mean util ${pct(p.meanUtil)}`)
    if (p.idlePerHour != null) lines.push(`idle ${fmtRate(p.idlePerHour)}`)
    return lines
  }

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
        {error ? <span style={note}>history unavailable: {ipcErrorText(error)}</span> : null}
        {omitted > 0 ? (
          <span style={note} title="The least-read GPUs are left off the chart">
            {omitted} more GPU{omitted === 1 ? '' : 's'} not drawn
          </span>
        ) : null}
        <ViewPicker value={view} onChange={setView} />
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
            paddingTop: 4,
            paddingBottom: SCALE.space3
          }}
        >
          <Figure
            lead
            label="mean util"
            value={summary?.meanUtil != null ? pct(summary.meanUtil) : '—'}
            sub={`all GPUs, ${over}`}
            tone={summary?.meanUtil != null ? TOKENS.accent : undefined}
          />
          <Figure
            label="gpus busy"
            value={busy != null && rented != null ? `${fmtGpus(busy)} / ${fmtGpus(rented)}` : '—'}
            sub={latest ? 'latest reading' : 'no reading yet'}
          />
          <Figure
            label="idle"
            value={idle != null ? fmtRate(idle) : '—'}
            sub={
              summary && summary.idleCost > 0
                ? `latest · ${fmtMoney(summary.idleCost)} ${over}`
                : latest
                  ? 'latest reading'
                  : undefined
            }
            // Money paid for nothing is the one figure here that wants attention.
            tone={idle != null && idle > 0 ? TOKENS.warn : undefined}
          />
        </div>
        <div
          style={{
            flex: 1,
            minWidth: 0,
            // Refetch keeps the frame: the previous read's chart stays, dimmed.
            opacity: isPlaceholderData ? 0.55 : 1,
            transition: 'opacity 120ms'
          }}
        >
          {perGpu ? (
            <TimeChart
              kind="line"
              height={150}
              fromMs={fromMs}
              toMs={toMs}
              spanMs={data?.bucketMs}
              yMax={100}
              format={pct}
              formatX={formatX}
              emptyNote={lines ? 'no GPU readings in this window' : 'loading per-GPU use…'}
              series={lines ?? []}
              tooltipMax={TOOLTIP_GPUS}
              tooltipExtra={tooltipExtra}
            />
          ) : (
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
              tooltipExtra={tooltipExtra}
            />
          )}
        </div>
      </div>
    </div>
  )
}
