import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { AppToolbar } from '../../components/AppToolbar'
import { ConfirmButton } from '../../components/ConfirmButton'
import { Sparkline } from '../../components/charts/Sparkline'
import { Icon } from '../../components/Icon'
import { InfoHint } from '../../components/Tooltip'
import { btn, mono, panel, sectionLabel, statusDot, tableRow } from '../../lib/controls'
import { fitColumns, useMeasuredWidth, type FitColumn } from '../../lib/layout'
import { fmtDuration, fmtEnergy, fmtMoney, fmtRate, fmtWatts } from '../../lib/format'
import { HINTS } from '../../lib/hints'
import { ipc } from '../../lib/ipc'
import { useNav } from '../../lib/nav'
import { ipcErrorText } from '../../lib/recovery'
import { DestroyNodeButton } from './NodeActions'
import { ACTIVITY_MIN_W } from './activity'
import { NodeActivity } from './NodeActivity'
import { NodeDetail } from './NodeDetail'
import { FleetGpuStrip } from './FleetGpuStrip'
import { overCapBound, overCapRequest } from './requestNode'
import { ScaleStatusLine } from './ScaleStatusLine'
import { UnclaimedPanel } from './UnclaimedPanel'
import { MeterPair, MiniMeter } from './meters'
import { SPARK_MS, clockFormatter, liveWindow, sparkPoints } from './usageCharts'
import { pctOf, usageTone } from '../../lib/usage'
import {
  useNodeReadings,
  useNodes,
  useRequestNode,
  useSettings,
  useUpdateSettings
} from '../../lib/queries'
import { useNow } from '../../lib/useNow'
import { SCALE, TOKENS, type StatusTone } from '../../lib/theme'
import { capacityBudget, holdsInstance } from '../../../../shared/nodeState'
import type { NodeSnapshot, NodeState, SettingsPublic } from '../../../../shared/models'

const STATE_TONE: Record<NodeState, StatusTone> = {
  requested: 'queued',
  provisioning: 'queued',
  ready: 'done',
  rendering: 'running',
  encoding: 'running',
  idle: 'done',
  unreachable: 'error',
  draining: 'queued',
  failed: 'error',
  destroying: 'dead',
  destroyed: 'dead'
}

/**
 * Dev aid (mirrors `?screen=` in nav.ts): `?expand=1` on the dev-server URL
 * opens every node's detail panel on load, so VR_SHOT screenshots capture it.
 */
const EXPAND_ALL = ((): boolean => {
  try {
    return new URLSearchParams(window.location.search).get('expand') === '1'
  } catch {
    return false
  }
})()

// Column widths shared by the header and rows.
const COLS = {
  caret: 12,
  dot: 18,
  state: 92,
  gpu: 150,
  gpuUse: 132,
  gpuTrend: 64,
  cpuUse: 132,
  rate: 82,
  cost: 70,
  power: 76,
  uptime: 72,
  // Room for the destroy button's armed "confirm destroy?".
  actions: 116
} as const

const cellSm: CSSProperties = { fontSize: SCALE.textSm }

type Col = keyof typeof COLS | 'activity'
const GAP = 12
const w = (col: keyof typeof COLS): number => COLS[col] + GAP

/**
 * The order a tight table sheds its columns in: the trend first, the GPU
 * meters never. Below the undroppable columns' width the rows stack instead
 * (StackedNodeRow), since a table that narrow has nothing left to drop.
 */
const FIT: readonly FitColumn<Col>[] = [
  { key: 'caret', width: w('caret') },
  { key: 'dot', width: w('dot') },
  { key: 'state', width: w('state') },
  { key: 'gpu', width: w('gpu') },
  { key: 'gpuUse', width: w('gpuUse') },
  { key: 'gpuTrend', width: w('gpuTrend'), drop: 1 },
  { key: 'cpuUse', width: w('cpuUse'), drop: 5 },
  { key: 'rate', width: w('rate') },
  { key: 'cost', width: w('cost'), drop: 4 },
  { key: 'power', width: w('power'), drop: 2 },
  { key: 'uptime', width: w('uptime'), drop: 3 },
  { key: 'activity', width: ACTIVITY_MIN_W + GAP, drop: 6 },
  { key: 'actions', width: COLS.actions }
]
const ALL_COLS: ReadonlySet<Col> = new Set(FIT.map((c) => c.key))
/** Row padding, left and right. */
const ROW_PAD = 24
const TABLE_MIN = FIT.filter((c) => c.drop == null).reduce((sum, c) => sum + c.width, 0) + ROW_PAD

/** A cell that keeps its column's width rather than wrapping its text. */
const fixed = (col: keyof typeof COLS): CSSProperties => ({
  width: COLS[col],
  flexShrink: 0,
  whiteSpace: 'nowrap'
})

const MAX_NODES_UI = 64

function MaxNodesStepper(): React.JSX.Element {
  const { data: settings } = useSettings()
  const update = useUpdateSettings()
  const value = settings?.maxActiveNodes ?? 0
  const set = (next: number): void => {
    // 64, not 16: a headless spec can set 30+, and clamping at 16 meant a
    // single click on "−" silently shrank such a fleet to 16.
    const clamped = Math.max(0, Math.min(MAX_NODES_UI, next))
    // One save, through main's sanitizer (plan 1.14). It used to be sent
    // twice, the second time through fleet:setMaxNodes with nothing
    // listening for its failure.
    update.mutate({ maxActiveNodes: clamped })
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={sectionLabel()}>max nodes</span>
      <button
        aria-label="Fewer max nodes"
        style={btn({ size: 'sm' })}
        onClick={() => set(value - 1)}
      >
        −
      </button>
      <span style={{ ...mono, minWidth: 18, textAlign: 'center' }}>{value}</span>
      <button
        aria-label="More max nodes"
        style={btn({ size: 'sm' })}
        onClick={() => set(value + 1)}
      >
        +
      </button>
    </span>
  )
}

/**
 * Column header that carries an explanation. The ⓘ lives on the header rather
 * than on every row: the rows are dense and click-to-expand, so a marker in
 * each one would be noise.
 */
function HeaderCell({
  h,
  width,
  label,
  hint
}: {
  h: CSSProperties
  width: number
  label: string
  hint: string
}): React.JSX.Element {
  return (
    <span
      style={{
        ...h,
        width,
        flexShrink: 0,
        whiteSpace: 'nowrap',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4
      }}
    >
      {label}
      <InfoHint text={hint} size={10} />
    </span>
  )
}

function HeaderRow({ show }: { show: ReadonlySet<Col> }): React.JSX.Element {
  const h: CSSProperties = { ...sectionLabel(), fontSize: 'var(--text-2xs)' }
  return (
    <div
      style={{
        ...tableRow(),
        borderBottom: `1px solid ${TOKENS.borderStrong}`,
        padding: '6px 12px'
      }}
    >
      <span style={fixed('caret')} />
      <span style={fixed('dot')} />
      <span style={{ ...h, ...fixed('state') }}>state</span>
      <span style={{ ...h, ...fixed('gpu') }}>gpu</span>
      <span style={{ ...h, ...fixed('gpuUse') }}>gpu % · vram %</span>
      {show.has('gpuTrend') ? (
        <HeaderCell h={h} width={COLS.gpuTrend} label="30 min" hint={HINTS.gpuTrend} />
      ) : null}
      {show.has('cpuUse') ? <span style={{ ...h, ...fixed('cpuUse') }}>cpu % · ram %</span> : null}
      <HeaderCell h={h} width={COLS.rate} label="rate" hint={HINTS.rate} />
      {show.has('cost') ? (
        <HeaderCell h={h} width={COLS.cost} label="cost" hint={HINTS.spent} />
      ) : null}
      {show.has('power') ? (
        <HeaderCell h={h} width={COLS.power} label="power" hint={HINTS.power} />
      ) : null}
      {show.has('uptime') ? <span style={{ ...h, ...fixed('uptime') }}>uptime</span> : null}
      {show.has('activity') ? (
        <span style={{ ...h, flex: 1, minWidth: ACTIVITY_MIN_W }}>activity</span>
      ) : (
        <span style={{ flex: 1 }} />
      )}
      <span style={fixed('actions')} />
    </div>
  )
}

const pct = (v: number): string => `${v.toFixed(0)}%`
const clock = clockFormatter(SPARK_MS)

/**
 * The row's last 30 minutes of GPU use (Feature G): the mean across the
 * node's GPUs, over the spread from its least to its most busy card. Its own
 * component, so a sample re-renders this cell and not the whole row.
 */
function GpuTrend({ nodeId }: { nodeId: string }): React.JSX.Element {
  const readings = useNodeReadings(nodeId)
  const now = useNow(15_000)
  const { fromMs, toMs } = liveWindow(readings, now, SPARK_MS)
  const points = useMemo(() => sparkPoints(readings, fromMs, toMs), [readings, fromMs, toMs])
  return (
    <span style={{ ...fixed('gpuTrend'), display: 'inline-flex', alignItems: 'center' }}>
      <Sparkline
        points={points}
        fromMs={fromMs}
        toMs={toMs}
        yMax={100}
        width={COLS.gpuTrend}
        height={18}
        label="GPU util, 30 min"
        format={pct}
        formatX={clock}
      />
    </span>
  )
}

/**
 * One node, collapsed: a table row of the columns that fit (`show`), or, in a
 * panel too narrow for even the undroppable ones, three stacked lines —
 * who it is and what it costs, how busy it is, what it is working on.
 */
function NodeRow({
  node,
  show = ALL_COLS,
  stacked = false
}: {
  node: NodeSnapshot
  show?: ReadonlySet<Col>
  stacked?: boolean
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(EXPAND_ALL)
  const now = useNow()
  const uptime = node.startedAt ? fmtDuration(now - node.startedAt) : '—'
  const m = node.metrics
  const vramPct = m ? pctOf(m.vramUsedGb, m.vramTotalGb) : null
  const ramPct = m ? pctOf(m.ramUsedGb, m.ramTotalGb) : null

  const caret = (
    <span
      style={{
        ...fixed('caret'),
        display: 'inline-flex',
        color: expanded ? TOKENS.accent : TOKENS.textFaint,
        transform: expanded ? 'rotate(90deg)' : 'none',
        transition: 'transform 140ms'
      }}
    >
      <Icon name="chevron" size={12} />
    </span>
  )
  const dot = (
    <span style={{ ...fixed('dot'), display: 'inline-flex' }}>
      <span style={statusDot(STATE_TONE[node.state])} />
    </span>
  )
  const state = (
    <span style={{ ...cellSm, ...fixed('state'), color: TOKENS.textSecondary }}>{node.state}</span>
  )
  const gpuName = `${node.gpuName ?? '…'}${node.numGpus > 1 ? ` ×${node.numGpus}` : ''}`
  const gpu = (
    <span
      title={gpuName}
      style={{
        ...mono,
        ...cellSm,
        ...(stacked ? { flex: 1, minWidth: 0, whiteSpace: 'nowrap' } : fixed('gpu')),
        overflow: 'hidden',
        textOverflow: 'ellipsis'
      }}
    >
      {gpuName}
    </span>
  )
  const gpuUse = (
    <MeterPair
      width={COLS.gpuUse}
      top={
        <MiniMeter
          icon="gpu"
          pct={m ? m.gpuUtil : null}
          tone={usageTone(m ? m.gpuUtil : null, { idleBelow: 5, compute: true })}
          title={m ? `GPU compute ${m.gpuUtil.toFixed(0)}%` : 'no metrics yet'}
        />
      }
      bottom={
        <MiniMeter
          icon="memory"
          pct={vramPct}
          tone={usageTone(vramPct)}
          title={m ? `VRAM ${m.vramUsedGb.toFixed(1)} / ${m.vramTotalGb.toFixed(0)} GB` : undefined}
        />
      }
    />
  )
  const cpuUse = (
    <MeterPair
      width={COLS.cpuUse}
      top={
        <MiniMeter
          icon="cpu"
          pct={m ? m.cpuUtil : null}
          tone={usageTone(m ? m.cpuUtil : null, { idleBelow: 5, compute: true })}
          title={
            m
              ? `CPU ${m.cpuUtil.toFixed(0)}% · load ${m.cpuLoad1.toFixed(1)} / ${m.cpuCores} cores`
              : undefined
          }
        />
      }
      bottom={
        <MiniMeter
          icon="memory"
          pct={ramPct}
          tone={usageTone(ramPct)}
          title={
            m && m.ramTotalGb > 0
              ? `RAM ${m.ramUsedGb.toFixed(1)} / ${m.ramTotalGb.toFixed(0)} GB`
              : undefined
          }
        />
      }
    />
  )
  const rate = (
    <span style={{ ...mono, ...cellSm, ...fixed('rate') }}>
      {node.dphTotal != null ? fmtRate(node.dphTotal) : '—'}
    </span>
  )
  const cost = (
    <span style={{ ...mono, ...cellSm, ...fixed('cost') }}>{fmtMoney(node.accumulatedCost)}</span>
  )
  const power = (
    <span
      style={{
        ...cellSm,
        ...fixed('power'),
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5
      }}
      title={
        m && m.powerW > 0
          ? `GPU draw ${fmtWatts(m.powerW)}${m.powerLimitW > 0 ? ` of ${fmtWatts(m.powerLimitW)} limit` : ''} · ${fmtEnergy(node.energyWh)} this session`
          : undefined
      }
    >
      <span
        style={{
          display: 'flex',
          color: m && m.powerW > 0 ? TOKENS.warn : TOKENS.textDisabled
        }}
      >
        <Icon name="power" size={11} />
      </span>
      <span style={{ ...mono, color: m && m.powerW > 0 ? TOKENS.text : TOKENS.textDisabled }}>
        {m && m.powerW > 0 ? fmtWatts(m.powerW) : '—'}
      </span>
    </span>
  )
  const up = <span style={{ ...mono, ...cellSm, ...fixed('uptime') }}>{uptime}</span>
  const actions = (
    <span style={{ ...fixed('actions'), display: 'inline-flex', justifyContent: 'flex-end' }}>
      <DestroyNodeButton node={node} onDestroy={() => ipc.invoke('node:destroy', node.id)} />
    </span>
  )

  const toggle = (): void => setExpanded(!expanded)
  if (stacked) {
    // Lines two and three start under the state, past the caret and the dot.
    const indent = COLS.caret + COLS.dot + 2 * GAP
    const line: CSSProperties = { display: 'flex', alignItems: 'center', gap: GAP, minWidth: 0 }
    return (
      <>
        <div
          style={{
            ...tableRow({ clickable: true, expanded }),
            flexDirection: 'column',
            alignItems: 'stretch',
            gap: 8
          }}
          onClick={toggle}
        >
          <div style={line}>
            {caret}
            {dot}
            {state}
            {gpu}
            {rate}
          </div>
          <div style={{ ...line, flexWrap: 'wrap', paddingLeft: indent }}>
            {gpuUse}
            {cpuUse}
            {up}
          </div>
          <div style={{ ...line, paddingLeft: indent }}>
            <NodeActivity node={node} />
            {actions}
          </div>
        </div>
        {expanded ? <NodeDetail node={node} /> : null}
      </>
    )
  }
  return (
    <>
      <div style={tableRow({ clickable: true, expanded })} onClick={toggle}>
        {caret}
        {dot}
        {state}
        {gpu}
        {gpuUse}
        {show.has('gpuTrend') ? <GpuTrend nodeId={node.id} /> : null}
        {show.has('cpuUse') ? cpuUse : null}
        {rate}
        {show.has('cost') ? cost : null}
        {show.has('power') ? power : null}
        {show.has('uptime') ? up : null}
        {show.has('activity') ? <NodeActivity node={node} /> : <span style={{ flex: 1 }} />}
        {actions}
      </div>
      {expanded ? <NodeDetail node={node} /> : null}
    </>
  )
}

/**
 * "+ request node": one rental now, by hand. At the spend cap (or with no
 * cap set) main refuses it unless the user says to go past the cap (plan
 * 1.5), so the button asks first there, naming the cap. It stays disabled
 * while a request is out, so a double-click rents one node, not two (#94),
 * and main's refusal is shown beside it rather than dropped.
 */
function RequestNodeButton({
  nodes,
  settings
}: {
  nodes: readonly NodeSnapshot[]
  settings: SettingsPublic | undefined
}): React.JSX.Element {
  const req = useRequestNode()
  const { error, reset } = req
  // A refusal stays up long enough to read, not for the rest of the session.
  useEffect(() => {
    if (!error) return
    const t = window.setTimeout(reset, 20_000)
    return () => window.clearTimeout(t)
  }, [error, reset])

  const budget = settings ? capacityBudget(nodes, settings) : null
  const message = error ? ipcErrorText(error) : null
  // The renderer's view of the cap can trail main's by a push; main's own
  // refusal says the same, so either one turns the button into the question.
  const overCap =
    (budget?.headroomPerHour != null && budget.headroomPerHour <= 0) ||
    (message != null && /spend cap/i.test(message))
  const noCap = settings?.spendCapPerHour == null
  const past = overCapRequest(settings)
  const bound = overCapBound(settings)
  const request = (overSpendCap: boolean): Promise<unknown> =>
    // The refusal is shown from the mutation's error; nothing to rethrow.
    req.mutateAsync(overSpendCap ? past : undefined).catch(() => undefined)
  const price = bound != null ? `at most ${fmtRate(bound.perHour)}` : 'at any price'

  return (
    <>
      {message ? (
        <span
          role="status"
          title={message}
          style={{
            maxWidth: 320,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: SCALE.textXs,
            color: TOKENS.danger
          }}
        >
          {message}
        </span>
      ) : null}
      {overCap ? (
        <ConfirmButton
          label="+ request node"
          variant="default"
          confirmLabel={
            noCap
              ? `no spend cap set: rent one, ${price}?`
              : `past the ${fmtRate(budget?.spendCap ?? settings?.spendCapPerHour ?? 0)} cap, ${price}?`
          }
          title={
            (noCap
              ? 'No spend cap is set, so scale-up rents nothing. Click twice to rent one node anyway, '
              : `The fleet bills ${fmtRate(budget?.perHour ?? 0)} of its ${fmtRate(budget?.spendCap ?? 0)} spend cap. ` +
                'A node rented now takes it past the cap: click twice to rent one anyway, ') +
            (bound == null
              ? 'at whatever the offer filters allow: they set no price.'
              : bound.from === 'offerFilter'
                ? `at no more than ${fmtRate(bound.perHour)} (the offer filter's price).`
                : `at no more than ${fmtRate(bound.perHour)}, the cap itself: the offer filters set no price.`)
          }
          onConfirm={() => request(true)}
        />
      ) : (
        <button
          style={btn({ size: 'sm', disabled: req.isPending })}
          disabled={req.isPending}
          onClick={() => void request(false)}
        >
          {req.isPending ? 'requesting…' : '+ request node'}
        </button>
      )}
    </>
  )
}

// Renderer-only view preference, like the grade in media/useGrade.ts.
const LS_SHOW_FAILED = 'vr:fleet:showFailed'

function readShowFailed(): boolean {
  try {
    return localStorage.getItem(LS_SHOW_FAILED) !== '0'
  } catch {
    return true
  }
}

export function FleetScreen(): React.JSX.Element {
  const { data: nodes, isLoading } = useNodes()
  const { data: settings } = useSettings()
  const { navigate } = useNav()
  const [showFailed, setShowFailedState] = useState(readShowFailed)
  const [clearing, setClearing] = useState(false)
  // The node table's own width, less its border and row padding.
  const [tableRef, tableWidth] = useMeasuredWidth<HTMLDivElement>()
  const inner = tableWidth && tableWidth - 2 - ROW_PAD
  const show = useMemo(() => fitColumns(inner, FIT), [inner])
  const stacked = tableWidth > 0 && tableWidth - 2 < TABLE_MIN

  const setShowFailed = (on: boolean): void => {
    setShowFailedState(on)
    try {
      localStorage.setItem(LS_SHOW_FAILED, on ? '1' : '0')
    } catch {
      // best-effort persistence
    }
  }

  const clearFailed = async (): Promise<void> => {
    setClearing(true)
    try {
      await ipc.invoke('fleet:clearFailed')
    } finally {
      setClearing(false)
    }
  }

  // A 'destroyed' row whose destroy Vast has not confirmed may still be
  // billing (nodeState.holdsInstance), so it stays listed; and a failed row
  // that may be billing is never one "show failed" can hide (#64, #194).
  const listed = (nodes ?? []).filter((n) => n.state !== 'destroyed' || holdsInstance(n))
  const hideable = (n: NodeSnapshot): boolean => n.state === 'failed' && !holdsInstance(n)
  const failedCount = listed.filter((n) => n.state === 'failed').length
  const hideableCount = listed.filter(hideable).length
  const hiddenCount = showFailed ? 0 : hideableCount
  const visible = showFailed ? listed : listed.filter((n) => !hideable(n))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <AppToolbar
        left={<MaxNodesStepper />}
        right={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: SCALE.space3 }}>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                fontSize: SCALE.textXs,
                color: TOKENS.textMuted,
                cursor: 'pointer'
              }}
            >
              <input
                type="checkbox"
                checked={showFailed}
                onChange={(e) => setShowFailed(e.target.checked)}
              />
              show failed ({hideableCount})
            </label>
            <button
              style={btn({ size: 'sm', disabled: failedCount === 0 || clearing })}
              disabled={failedCount === 0 || clearing}
              title="Destroy any instance a failed node still holds, then remove it from the list"
              onClick={() => void clearFailed()}
            >
              {clearing ? 'clearing…' : 'clear failed'}
            </button>
            <RequestNodeButton nodes={nodes ?? []} settings={settings} />
          </span>
        }
      />
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          padding: SCALE.space4,
          display: 'flex',
          flexDirection: 'column',
          gap: SCALE.space3
        }}
      >
        {settings && !settings.hasVastApiKey ? null : (
          <>
            {/* Billing with no node here to show for it: above everything. */}
            <UnclaimedPanel />
            <ScaleStatusLine />
            <FleetGpuStrip hasNodes={listed.length > 0} />
          </>
        )}
        {settings && !settings.hasVastApiKey ? (
          <div
            style={{
              ...panel(),
              padding: SCALE.space6,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: SCALE.space3
            }}
          >
            <span style={{ color: TOKENS.textFaint }}>
              No Vast.ai API key configured — the fleet can&apos;t start.
            </span>
            <button
              style={btn({ variant: 'primary' })}
              onClick={() => navigate({ screen: 'settings', section: 'api' })}
            >
              Configure API key
            </button>
          </div>
        ) : visible.length === 0 ? (
          <div style={{ ...panel(), padding: SCALE.space6, textAlign: 'center' }}>
            <span style={{ color: TOKENS.textFaint }}>
              {isLoading
                ? 'Loading…'
                : hiddenCount > 0
                  ? `${hiddenCount} failed node${hiddenCount === 1 ? '' : 's'} hidden.`
                  : 'No active nodes. Nodes start automatically when jobs are queued.'}
            </span>
          </div>
        ) : (
          <div ref={tableRef} style={panel()}>
            {stacked ? null : <HeaderRow show={show} />}
            {visible.map((n) => (
              <NodeRow key={n.id} node={n} show={show} stacked={stacked} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
