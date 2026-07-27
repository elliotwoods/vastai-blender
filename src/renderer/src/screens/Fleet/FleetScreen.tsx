import { useState, type CSSProperties } from 'react'
import { AppToolbar } from '../../components/AppToolbar'
import { Icon } from '../../components/Icon'
import { btn, mono, panel, sectionLabel, statusDot, tableRow } from '../../lib/controls'
import { fmtDuration, fmtEnergy, fmtMoney, fmtRate, fmtWatts } from '../../lib/format'
import { ipc } from '../../lib/ipc'
import { useNav } from '../../lib/nav'
import { NodeDetail } from './NodeDetail'
import { MeterPair, MiniMeter } from './meters'
import { pctOf, usageTone } from '../../lib/usage'
import { useNodes, useSettings, useUpdateSettings } from '../../lib/queries'
import { useNow } from '../../lib/useNow'
import { SCALE, TOKENS, type StatusTone } from '../../lib/theme'
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
  uptime: 72
} as const

const cellSm: CSSProperties = { fontSize: SCALE.textSm }

function MaxNodesStepper(): React.JSX.Element {
  const { data: settings } = useSettings()
  const update = useUpdateSettings()
  const value = settings?.maxActiveNodes ?? 0
  const set = (next: number): void => {
    const clamped = Math.max(0, Math.min(16, next))
    update.mutate({ maxActiveNodes: clamped })
    void ipc.invoke('fleet:setMaxNodes', clamped)
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
      <span style={{ ...h, width: COLS.rate }}>rate</span>
      <span style={{ ...h, width: COLS.cost }}>cost</span>
      <span style={{ ...h, width: COLS.power }}>power</span>
      <span style={{ ...h, width: COLS.uptime }}>uptime</span>
      <span style={{ ...h, flex: 1 }}>activity</span>
      <span style={{ width: 70 }} />
    </div>
  )
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
      <div
        style={{
          ...tableRow({ clickable: true }),
          ...(expanded ? { background: TOKENS.surface, borderBottomColor: 'transparent' } : {})
        }}
        onClick={() => setExpanded(!expanded)}
      >
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
          {node.currentChunkId ?? node.lastError ?? ''}
        </span>
        <span style={{ width: 70, display: 'inline-flex', justifyContent: 'flex-end' }}>
          <button
            style={btn({ variant: 'danger', size: 'sm' })}
            onClick={(e) => {
              e.stopPropagation()
              void ipc.invoke('node:destroy', node.id)
            }}
          >
            destroy
          </button>
        </span>
      </div>
      {expanded ? <NodeDetail node={node} /> : null}
    </>
  )
}

export function FleetScreen(): React.JSX.Element {
  const { data: nodes, isLoading } = useNodes()
  const { data: settings } = useSettings()
  const { navigate } = useNav()

  const visible = (nodes ?? []).filter((n) => n.state !== 'destroyed')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <AppToolbar
        left={<MaxNodesStepper />}
        right={
          <button style={btn({ size: 'sm' })} onClick={() => void ipc.invoke('fleet:requestNode')}>
            + request node
          </button>
        }
      />
      <div style={{ flex: 1, overflow: 'auto', padding: SCALE.space4 }}>
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
