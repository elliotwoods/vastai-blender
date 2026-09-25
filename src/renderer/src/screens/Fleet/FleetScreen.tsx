import { useState, type CSSProperties } from 'react'
import { AppToolbar } from '../../components/AppToolbar'
import { Icon } from '../../components/Icon'
import { InfoHint } from '../../components/Tooltip'
import { btn, mono, panel, sectionLabel, statusDot, tableRow } from '../../lib/controls'
import { fmtDuration, fmtEnergy, fmtMoney, fmtRate, fmtWatts } from '../../lib/format'
import { HINTS } from '../../lib/hints'
import { ipc } from '../../lib/ipc'
import { useNav } from '../../lib/nav'
import { DestroyNodeButton } from './NodeActions'
import { NodeDetail } from './NodeDetail'
import { UnclaimedPanel } from './UnclaimedPanel'
import { MeterPair, MiniMeter } from './meters'
import { pctOf, usageTone } from '../../lib/usage'
import { useNodes, useSettings, useUpdateSettings } from '../../lib/queries'
import { useNow } from '../../lib/useNow'
import { SCALE, TOKENS, type StatusTone } from '../../lib/theme'
import { holdsInstance } from '../../../../shared/nodeState'
import type { NodeSnapshot, NodeState } from '../../../../shared/models'

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
  cpuUse: 132,
  rate: 82,
  cost: 70,
  power: 76,
  uptime: 72,
  // Room for the destroy button's armed "confirm destroy?".
  actions: 116
} as const

const cellSm: CSSProperties = { fontSize: SCALE.textSm }

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
      <button style={btn({ size: 'sm' })} onClick={() => set(value - 1)}>
        −
      </button>
      <span style={{ ...mono, minWidth: 18, textAlign: 'center' }}>{value}</span>
      <button style={btn({ size: 'sm' })} onClick={() => set(value + 1)}>
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
    <span style={{ ...h, width, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      {label}
      <InfoHint text={hint} size={10} />
    </span>
  )
}

function HeaderRow(): React.JSX.Element {
  const h: CSSProperties = { ...sectionLabel(), fontSize: 'var(--text-2xs)' }
  return (
    <div
      style={{
        ...tableRow(),
        borderBottom: `1px solid ${TOKENS.borderStrong}`,
        padding: '6px 12px'
      }}
    >
      <span style={{ width: COLS.caret }} />
      <span style={{ width: COLS.dot }} />
      <span style={{ ...h, width: COLS.state }}>state</span>
      <span style={{ ...h, width: COLS.gpu }}>gpu</span>
      <span style={{ ...h, width: COLS.gpuUse }}>gpu % · vram %</span>
      <span style={{ ...h, width: COLS.cpuUse }}>cpu % · ram %</span>
      <HeaderCell h={h} width={COLS.rate} label="rate" hint={HINTS.rate} />
      <HeaderCell h={h} width={COLS.cost} label="cost" hint={HINTS.spent} />
      <HeaderCell h={h} width={COLS.power} label="power" hint={HINTS.power} />
      <span style={{ ...h, width: COLS.uptime }}>uptime</span>
      <span style={{ ...h, flex: 1 }}>activity</span>
      <span style={{ width: COLS.actions }} />
    </div>
  )
}

/**
 * Collapsed-row activity text. Built from `currentWork` rather than a
 * pre-joined string so a multi-slot node reads as a count plus one job name
 * instead of a wall of chunk ids; expand the row for the per-slot detail.
 */
function activitySummary(node: NodeSnapshot): string {
  const work = node.currentWork
  if (work.length === 0) return ''
  const jobs = new Set(work.map((w) => w.jobId))
  const slots = `${work.length}/${node.slotTarget}`
  return jobs.size === 1 ? `${slots} · ${work[0].chunkId}` : `${slots} · ${jobs.size} jobs`
}

function NodeRow({ node }: { node: NodeSnapshot }): React.JSX.Element {
  const [expanded, setExpanded] = useState(EXPAND_ALL)
  const now = useNow()
  const uptime = node.startedAt ? fmtDuration(now - node.startedAt) : '—'
  const m = node.metrics
  const vramPct = m ? pctOf(m.vramUsedGb, m.vramTotalGb) : null
  const ramPct = m ? pctOf(m.ramUsedGb, m.ramTotalGb) : null
  return (
    <>
      <div style={tableRow({ clickable: true, expanded })} onClick={() => setExpanded(!expanded)}>
        <span
          style={{
            width: COLS.caret,
            display: 'inline-flex',
            color: expanded ? TOKENS.accent : TOKENS.textFaint,
            transform: expanded ? 'rotate(90deg)' : 'none',
            transition: 'transform 140ms'
          }}
        >
          <Icon name="chevron" size={12} />
        </span>
        <span style={{ width: COLS.dot, display: 'inline-flex' }}>
          <span style={statusDot(STATE_TONE[node.state])} />
        </span>
        <span style={{ ...cellSm, width: COLS.state, color: TOKENS.textSecondary }}>
          {node.state}
        </span>
        <span style={{ ...mono, ...cellSm, width: COLS.gpu }}>
          {node.gpuName ?? '…'}
          {node.numGpus > 1 ? ` ×${node.numGpus}` : ''}
        </span>
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
              title={
                m ? `VRAM ${m.vramUsedGb.toFixed(1)} / ${m.vramTotalGb.toFixed(0)} GB` : undefined
              }
            />
          }
        />
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
        <span style={{ ...mono, ...cellSm, width: COLS.rate }}>
          {node.dphTotal != null ? fmtRate(node.dphTotal) : '—'}
        </span>
        <span style={{ ...mono, ...cellSm, width: COLS.cost }}>
          {fmtMoney(node.accumulatedCost)}
        </span>
        <span
          style={{
            ...cellSm,
            width: COLS.power,
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
        <span style={{ ...mono, ...cellSm, width: COLS.uptime }}>{uptime}</span>
        <span
          style={{
            flex: 1,
            fontSize: SCALE.textXs,
            color: TOKENS.textFaint,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {node.lastError ?? activitySummary(node)}
        </span>
        <span style={{ width: COLS.actions, display: 'inline-flex', justifyContent: 'flex-end' }}>
          <DestroyNodeButton node={node} onDestroy={() => ipc.invoke('node:destroy', node.id)} />
        </span>
      </div>
      {expanded ? <NodeDetail node={node} /> : null}
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
            <button
              style={btn({ size: 'sm' })}
              onClick={() => void ipc.invoke('fleet:requestNode')}
            >
              + request node
            </button>
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
        {/* Billing with no node here to show for it: above everything. */}
        {settings && !settings.hasVastApiKey ? null : <UnclaimedPanel />}
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
          <div style={panel()}>
            <HeaderRow />
            {visible.map((n) => (
              <NodeRow key={n.id} node={n} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
