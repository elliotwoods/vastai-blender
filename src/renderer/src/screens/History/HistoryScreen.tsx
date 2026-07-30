/**
 * Where the toolbar's live numbers get a past tense: spend, balance, power and
 * fleet size over 1 day / 7 days / 30 days / all time, plus which jobs the
 * money actually went on.
 *
 * Range and metric live in the route rather than local state so Alt+Left steps
 * back through them and `?screen=history&metric=power` still works for shots.
 */

import type { CSSProperties } from 'react'
import { AppToolbar } from '../../components/AppToolbar'
import { Chart, type ChartPoint, type MarkKind } from './Chart'
import { InfoHint, Tooltip } from '../../components/Tooltip'
import { chip, mono, panel, sectionLabel, segmented, tableRow } from '../../lib/controls'
import { compareCo2 } from '../../lib/co2'
import { fmtCo2, fmtEnergy, fmtMoney, fmtWatts } from '../../lib/format'
import { HINTS } from '../../lib/hints'
import { useNav } from '../../lib/nav'
import { useHistorySummary } from '../../lib/queries'
import { SCALE, TOKENS } from '../../lib/theme'
import { useNow } from '../../lib/useNow'
import { Meter } from '../Fleet/meters'
import type {
  HistoryMetric,
  HistoryRange,
  HistorySummary,
  HistoryTotals,
  JobCostRow
} from '../../../../shared/models'

const RANGES: Array<{ key: HistoryRange; label: string }> = [
  { key: '1d', label: '1D' },
  { key: '7d', label: '7D' },
  { key: '30d', label: '30D' },
  { key: 'all', label: 'ALL' }
]

const METRICS: Array<{ key: HistoryMetric; label: string }> = [
  { key: 'spend', label: 'spend' },
  { key: 'balance', label: 'balance' },
  { key: 'power', label: 'power' },
  { key: 'fleet', label: 'fleet' }
]

/** Axis labels: clock within a day, date once the window spans several. */
function xFormatter(range: HistoryRange): (ms: number) => string {
  const opts: Intl.DateTimeFormatOptions =
    range === '1d'
      ? { hour: '2-digit', minute: '2-digit' }
      : range === '7d'
        ? // Minutes included so "Mon, 14:00" can't be misread as a day-of-month.
          { weekday: 'short', hour: '2-digit', minute: '2-digit' }
        : { day: 'numeric', month: 'short' }
  return (ms) => new Date(ms).toLocaleString(undefined, opts)
}

function fmtHours(h: number): string {
  return h >= 10 ? `${h.toFixed(0)} h` : `${h.toFixed(1)} h`
}

function fmtPct(p: number): string {
  return `${p.toFixed(0)}%`
}

/** Compact `label / value` tile, matching the toolbar readouts' vocabulary. */
function Stat({
  label,
  value,
  tone,
  hint
}: {
  label: string
  value: string
  tone?: string
  hint?: string
}): React.JSX.Element {
  return (
    <div
      style={{
        ...panel(),
        padding: '8px 12px',
        minWidth: 108,
        display: 'flex',
        flexDirection: 'column',
        gap: 3
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <span style={sectionLabel()}>{label}</span>
        {hint ? <InfoHint text={hint} size={10} /> : null}
      </span>
      <span style={{ ...mono, fontSize: SCALE.textLg, color: tone ?? TOKENS.text }}>{value}</span>
    </div>
  )
}

interface MetricView {
  kind: MarkKind
  points: ChartPoint[]
  format: (v: number) => string
  baseline: 'zero' | 'fit'
  color?: string
  stats: Array<{ label: string; value: string; tone?: string; hint?: string }>
  note: string
}

/**
 * What a quantity of energy did to the atmosphere, as tooltip copy: the
 * estimate, an everyday equivalent, and — because this is an estimate built on
 * two assumptions — which grids it was costed against.
 */
function co2Hint(co2g: number, sources: HistoryTotals['co2Sources']): string {
  if (!(co2g > 0)) return HINTS.co2
  const where = sources.length
    ? sources.map((s) => `${s.country ?? 'unknown location'} ${s.gPerKwh} g/kWh`).join(', ')
    : 'the world-average grid'
  return `${fmtCo2(co2g)}\n${compareCo2(co2g) ?? ''}\n\n${HINTS.co2}\nCosted against: ${where}.`
}

/**
 * Everything that differs between the four series, in one place — each returns
 * its marks, its formatter and the stat tiles that belong above it.
 */
function viewFor(metric: HistoryMetric, s: HistorySummary): MetricView {
  const t = s.totals
  switch (metric) {
    case 'spend':
      return {
        kind: 'bars',
        points: s.buckets.map((b) => ({ x: b.tsStart, y: b.cost })),
        format: fmtMoney,
        baseline: 'zero',
        stats: [
          { label: 'total spend', value: fmtMoney(t.cost) },
          { label: 'on jobs', value: fmtMoney(t.cost - s.unattributedCost) },
          { label: 'idle / setup', value: fmtMoney(s.unattributedCost), tone: TOKENS.textMuted },
          { label: 'node hours', value: fmtHours(t.nodeHours) }
        ],
        note: 'Spend per bucket, metered by this app once a minute while it was running.'
      }
    case 'balance':
      return {
        kind: 'step',
        points: s.balancePoints.map((p) => ({ x: p.ts, y: p.balance })),
        format: fmtMoney,
        baseline: 'fit',
        color: TOKENS.warn,
        stats: [
          { label: 'balance', value: t.balanceEnd != null ? fmtMoney(t.balanceEnd) : '—' },
          {
            label: 'change',
            value:
              t.balanceStart != null && t.balanceEnd != null
                ? `${t.balanceEnd - t.balanceStart >= 0 ? '+' : '−'}${fmtMoney(Math.abs(t.balanceEnd - t.balanceStart))}`
                : '—',
            tone:
              t.balanceStart != null && t.balanceEnd != null && t.balanceEnd < t.balanceStart
                ? TOKENS.warn
                : undefined
          },
          { label: 'spent', value: fmtMoney(t.cost) }
        ],
        note: 'Vast.ai credit, recorded only when it moves — top-ups show as steps up.'
      }
    case 'power':
      return {
        kind: 'line',
        points: s.buckets.map((b) => ({ x: b.tsStart, y: b.avgPowerW })),
        format: fmtWatts,
        baseline: 'zero',
        stats: [
          { label: 'energy', value: fmtEnergy(t.wh), hint: co2Hint(t.co2g, t.co2Sources) },
          {
            label: 'co₂e',
            value: fmtCo2(t.co2g),
            tone: TOKENS.warnSoftText,
            hint: co2Hint(t.co2g, t.co2Sources)
          },
          { label: 'avg draw', value: t.avgPowerW != null ? fmtWatts(t.avgPowerW) : '—' },
          { label: 'peak draw', value: t.peakPowerW != null ? fmtWatts(t.peakPowerW) : '—' },
          {
            label: 'per $',
            value: t.cost > 0 ? fmtEnergy(t.wh / t.cost) + '/$' : '—'
          }
        ],
        note: 'Fleet GPU draw, summed across nodes from their nvidia-smi readings.'
      }
    case 'fleet':
      return {
        kind: 'line',
        points: s.buckets.map((b) => ({ x: b.tsStart, y: b.nodeCount })),
        format: (v) => v.toFixed(v < 10 ? 1 : 0),
        baseline: 'zero',
        stats: [
          { label: 'node hours', value: fmtHours(t.nodeHours) },
          {
            label: 'avg gpu',
            value: (() => {
              const vals = s.buckets.map((b) => b.gpuUtil).filter((v): v is number => v != null)
              return vals.length ? fmtPct(vals.reduce((a, x) => a + x, 0) / vals.length) : '—'
            })()
          },
          // From the range, not max-of-buckets: each bucket is a MEAN, and a
          // mean can never show the peak.
          { label: 'peak nodes', value: String(t.peakNodes) },
          { label: '$ / node-hr', value: t.nodeHours > 0 ? fmtMoney(t.cost / t.nodeHours) : '—' }
        ],
        note:
          'Mean nodes billing concurrently, counted per minute. ' +
          'Time above zero with no spend on jobs is idle fleet.'
      }
  }
}

const COLS = { cost: 84, share: 96, energy: 84, hours: 74, perFrame: 92, state: 84 }

function JobRow({
  job,
  maxCost,
  onOpen
}: {
  job: JobCostRow
  maxCost: number
  onOpen: () => void
}): React.JSX.Element {
  return (
    <div style={tableRow({ clickable: true })} onClick={onOpen}>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: SCALE.textSm,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap'
        }}
      >
        {job.name ?? job.jobId}
      </span>
      {job.engine ? (
        <span
          style={{
            ...chip({ tone: 'accent' }),
            textTransform: 'uppercase',
            fontSize: SCALE.text2xs
          }}
        >
          {job.engine}
        </span>
      ) : null}
      <span style={{ ...mono, width: COLS.cost, fontSize: SCALE.textSm, textAlign: 'right' }}>
        {fmtMoney(job.cost)}
      </span>
      <span style={{ width: COLS.share }}>
        <Meter pct={maxCost > 0 ? (job.cost / maxCost) * 100 : 0} tone="normal" height={4} />
      </span>
      <Tooltip
        text={`${fmtEnergy(job.wh)} on this job.\n${fmtCo2(job.co2g)}\n${compareCo2(job.co2g) ?? ''}\n\n${HINTS.co2}`}
        style={{ width: COLS.energy, justifyContent: 'flex-end' }}
      >
        <span
          style={{
            ...mono,
            fontSize: SCALE.textXs,
            color: TOKENS.textMuted,
            textAlign: 'right',
            cursor: 'help'
          }}
        >
          {fmtEnergy(job.wh)}
        </span>
      </Tooltip>
      <span
        style={{
          ...mono,
          width: COLS.hours,
          fontSize: SCALE.textXs,
          color: TOKENS.textMuted,
          textAlign: 'right'
        }}
      >
        {fmtHours(job.gpuHours)}
      </span>
      <span
        style={{
          ...mono,
          width: COLS.perFrame,
          fontSize: SCALE.textXs,
          color: TOKENS.textMuted,
          textAlign: 'right'
        }}
      >
        {job.costPerFrame != null ? `${fmtMoney(job.costPerFrame)}/fr` : '—'}
      </span>
      <span style={{ width: COLS.state, fontSize: SCALE.textXs, color: TOKENS.textSecondary }}>
        {job.state ?? 'deleted'}
      </span>
    </div>
  )
}

const headerCell: CSSProperties = {
  ...sectionLabel(),
  textAlign: 'right'
}

export interface HistoryScreenProps {
  metric?: HistoryMetric
  range?: HistoryRange
}

export function HistoryScreen({
  metric = 'spend',
  range = '7d'
}: HistoryScreenProps): React.JSX.Element {
  const { navigate } = useNav()
  const { data, isLoading } = useHistorySummary(range)
  // The right edge of every chart is "now", so it has to tick.
  const now = useNow(60_000)

  const go = (patch: { metric?: HistoryMetric; range?: HistoryRange }): void =>
    navigate({ screen: 'history', metric, range, ...patch })

  const picker = (
    <div style={{ display: 'flex', alignItems: 'center', gap: SCALE.space3 }}>
      <span style={{ display: 'flex' }}>
        {METRICS.map((m, i) => (
          <button
            key={m.key}
            style={segmented({
              active: m.key === metric,
              position: i === 0 ? 'first' : i === METRICS.length - 1 ? 'last' : 'middle'
            })}
            onClick={() => go({ metric: m.key })}
          >
            {m.label}
          </button>
        ))}
      </span>
      <span style={{ display: 'flex' }}>
        {RANGES.map((r, i) => (
          <button
            key={r.key}
            style={segmented({
              active: r.key === range,
              position: i === 0 ? 'first' : i === RANGES.length - 1 ? 'last' : 'middle'
            })}
            onClick={() => go({ range: r.key })}
          >
            {r.label}
          </button>
        ))}
      </span>
    </div>
  )

  if (!data) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <AppToolbar left={picker} />
        <div style={{ padding: SCALE.space4, color: TOKENS.textMuted, fontSize: SCALE.textSm }}>
          {isLoading ? 'loading history…' : 'no usage recorded yet'}
        </div>
      </div>
    )
  }

  const view = viewFor(metric, data)
  const toMs = Math.max(data.fromMs + data.bucketMs, now)
  const maxCost = Math.max(0, ...data.topJobs.map((j) => j.cost))

  // The power chart plots average draw, but the bucket also knows the energy
  // that implies — which is the only figure CO2 can be derived from. Look the
  // bucket back up by its left edge rather than threading it through the point.
  const bucketAt = new Map(data.buckets.map((b) => [b.tsStart, b]))
  const bucketExtra = (p: { x: number }): string[] | null => {
    const b = bucketAt.get(p.x)
    if (!b || b.wh <= 0) return null
    const lines = [fmtEnergy(b.wh), fmtCo2(b.co2g)]
    const vs = compareCo2(b.co2g)
    if (vs) lines.push(vs)
    return lines
  }
  // Balance and energy only start accruing from the version that records them,
  // so say so rather than letting a short line read as a short history.
  const startsAt = data.earliestMs
  const shortSeries =
    view.points.length === 0 ||
    (metric === 'balance' && data.balancePoints.length < 2) ||
    (metric === 'power' && data.totals.wh === 0)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <AppToolbar left={picker} />
      <div style={{ flex: 1, overflow: 'auto', padding: SCALE.space4 }}>
        <div style={{ display: 'flex', gap: SCALE.space2, flexWrap: 'wrap' }}>
          {view.stats.map((s) => (
            <Stat key={s.label} label={s.label} value={s.value} tone={s.tone} hint={s.hint} />
          ))}
        </div>

        <div style={{ ...panel(), marginTop: SCALE.space3, padding: `${SCALE.space3} 0 0` }}>
          <Chart
            points={view.points}
            kind={view.kind}
            fromMs={data.fromMs}
            toMs={toMs}
            spanMs={data.bucketMs}
            color={view.color}
            format={view.format}
            formatX={xFormatter(range)}
            baseline={view.baseline}
            height={220}
            tooltipExtra={bucketExtra}
            emptyNote={
              metric === 'balance'
                ? 'no balance readings in this window'
                : 'nothing recorded in this window'
            }
          />
        </div>
        <div
          style={{
            marginTop: 6,
            fontSize: SCALE.textXs,
            color: TOKENS.textFaint,
            display: 'flex',
            gap: SCALE.space2,
            flexWrap: 'wrap'
          }}
        >
          <span>{view.note}</span>
          {shortSeries && startsAt != null ? (
            <span>Recording began {new Date(startsAt).toLocaleDateString()}.</span>
          ) : null}
        </div>

        <div style={{ marginTop: SCALE.space5 }}>
          <span style={sectionLabel()}>top jobs by cost</span>
          <div style={{ ...panel(), marginTop: 6 }}>
            <div
              style={{
                ...tableRow(),
                borderBottom: `1px solid ${TOKENS.borderStrong}`,
                paddingTop: 6,
                paddingBottom: 6
              }}
            >
              <span style={{ ...sectionLabel(), flex: 1 }}>job</span>
              <span style={{ ...headerCell, width: COLS.cost }}>cost</span>
              <span style={{ ...sectionLabel(), width: COLS.share }}>share</span>
              <span style={{ ...headerCell, width: COLS.energy }}>energy</span>
              <span style={{ ...headerCell, width: COLS.hours }}>node hrs</span>
              <span style={{ ...headerCell, width: COLS.perFrame }}>per frame</span>
              <span style={{ ...sectionLabel(), width: COLS.state }}>state</span>
            </div>
            {data.topJobs.length === 0 ? (
              <div
                style={{ padding: SCALE.space4, color: TOKENS.textMuted, fontSize: SCALE.textSm }}
              >
                no job-attributed spend in this window
              </div>
            ) : (
              data.topJobs.map((j) => (
                <JobRow
                  key={j.jobId}
                  job={j}
                  maxCost={maxCost}
                  onOpen={() => navigate({ screen: 'job', jobId: j.jobId })}
                />
              ))
            )}
            {data.unattributedCost > 0 ? (
              <div style={{ ...tableRow(), color: TOKENS.textMuted }}>
                <span style={{ flex: 1, fontSize: SCALE.textSm, fontStyle: 'italic' }}>
                  idle, provisioning &amp; unattributed
                </span>
                <span
                  style={{ ...mono, width: COLS.cost, fontSize: SCALE.textSm, textAlign: 'right' }}
                >
                  {fmtMoney(data.unattributedCost)}
                </span>
                <span style={{ width: COLS.share }}>
                  <Meter
                    pct={maxCost > 0 ? (data.unattributedCost / maxCost) * 100 : 0}
                    tone="idle"
                    height={4}
                  />
                </span>
                <Tooltip
                  text={`${fmtEnergy(data.unattributedWh)} drawn while no job was rendering.\n${fmtCo2(data.unattributedCo2g)}\n${compareCo2(data.unattributedCo2g) ?? ''}\n\n${HINTS.co2}`}
                  style={{ width: COLS.energy, justifyContent: 'flex-end' }}
                >
                  <span style={{ ...mono, fontSize: SCALE.textXs, cursor: 'help' }}>
                    {fmtEnergy(data.unattributedWh)}
                  </span>
                </Tooltip>
                <span style={{ width: COLS.hours + COLS.perFrame + COLS.state }} />
              </div>
            ) : null}
          </div>
        </div>

        <p style={{ marginTop: SCALE.space3, fontSize: SCALE.textXs, color: TOKENS.textFaint }}>
          All figures are what this app observed while running — it meters the quoted rate once a
          minute and never reads back vast.ai&rsquo;s billing, so totals read low for any time the
          app was closed.
          {range === 'all' && startsAt != null
            ? ` Records start ${new Date(startsAt).toLocaleDateString()}.`
            : ''}
        </p>
      </div>
    </div>
  )
}
