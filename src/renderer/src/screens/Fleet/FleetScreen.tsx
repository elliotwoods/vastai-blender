import { useEffect, useState, type CSSProperties } from 'react'
import { AppToolbar } from '../../components/AppToolbar'
import { btn, logLine, mono, panel, sectionLabel, statusDot, tableRow } from '../../lib/controls'
import { fmtDuration, fmtMoney, fmtRate, fmtTimeAgo } from '../../lib/format'
import { ipc } from '../../lib/ipc'
import { useLogStore } from '../../lib/logStore'
import { useNav } from '../../lib/nav'
import { useNodes, useSettings, useUpdateSettings } from '../../lib/queries'
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

// Column widths shared by the header and rows.
const COLS = {
  dot: 18,
  state: 92,
  gpu: 150,
  util: 120,
  cpu: 86,
  rate: 82,
  cost: 70,
  uptime: 72
} as const

const cellSm: CSSProperties = { fontSize: SCALE.textSm }

function UtilBar({ pct, label }: { pct: number; label: string }): React.JSX.Element {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, width: '100%' }}>
      <span style={{ flex: 1, height: 4, background: TOKENS.border, borderRadius: 2 }}>
        <span
          style={{
            display: 'block',
            height: '100%',
            width: `${Math.min(100, pct)}%`,
            background: pct > 90 ? TOKENS.warn : TOKENS.accent,
            borderRadius: 2,
            transition: 'width 400ms'
          }}
        />
      </span>
      <span style={{ ...mono, fontSize: 'var(--text-2xs)', color: TOKENS.textMuted, minWidth: 52 }}>
        {label}
      </span>
    </span>
  )
}

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
      <span style={{ width: COLS.dot }} />
      <span style={{ ...h, width: COLS.state }}>state</span>
      <span style={{ ...h, width: COLS.gpu }}>gpu</span>
      <span style={{ ...h, width: COLS.util }}>gpu util · vram</span>
      <span style={{ ...h, width: COLS.cpu }}>cpu load</span>
      <span style={{ ...h, width: COLS.rate }}>rate</span>
      <span style={{ ...h, width: COLS.cost }}>cost</span>
      <span style={{ ...h, width: COLS.uptime }}>uptime</span>
      <span style={{ ...h, flex: 1 }}>activity</span>
      <span style={{ width: 70 }} />
    </div>
  )
}

function NodeDetail({ node }: { node: NodeSnapshot }): React.JSX.Element {
  const lines = useLogStore((s) => s.byNode[node.id] ?? [])
  const kv: Array<[string, string]> = [
    ['instance', node.instanceId != null ? String(node.instanceId) : '—'],
    ['ssh', node.sshHost ? `${node.sshHost}:${node.sshPort}` : '—'],
    ['blender', node.blenderVersions.join(', ') || '—'],
    [
      'eevee',
      node.eeveeCapable == null ? 'unprobed' : node.eeveeCapable ? 'capable' : 'not capable'
    ],
    ['octane', node.octaneReady ? 'ready' : '—'],
    [
      'vram',
      node.metrics
        ? `${node.metrics.vramUsedGb.toFixed(1)} / ${node.metrics.vramTotalGb.toFixed(0)} GB`
        : '—'
    ],
    ['gpu temp', node.metrics ? `${node.metrics.gpuTemp.toFixed(0)}°C` : '—'],
    [
      'cpu',
      node.metrics
        ? `load ${node.metrics.cpuLoad1.toFixed(1)} / ${node.metrics.cpuCores} cores`
        : '—'
    ],
    ['metrics age', node.metrics ? fmtTimeAgo(node.metrics.updatedAt) : '—'],
    ['last error', node.lastError ?? '—']
  ]
  return (
    <div
      style={{
        padding: `${SCALE.space2} ${SCALE.space4} ${SCALE.space3}`,
        borderBottom: `1px solid ${TOKENS.border}`
      }}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: `${SCALE.space1} ${SCALE.space5}`,
          marginBottom: SCALE.space2
        }}
      >
        {kv.map(([k, v]) => (
          <span key={k} style={{ fontSize: SCALE.textXs }}>
            <span style={{ color: TOKENS.textFaint }}>{k} </span>
            <span style={{ ...mono, color: TOKENS.textSecondary }}>{v}</span>
          </span>
        ))}
      </div>
      <div
        style={{
          background: TOKENS.surface,
          border: `1px solid ${TOKENS.border}`,
          borderRadius: SCALE.radiusSm,
          padding: SCALE.space2,
          maxHeight: 180,
          overflow: 'auto'
        }}
      >
        {lines.length === 0 ? (
          <span style={{ fontSize: SCALE.textXs, color: TOKENS.textFaint }}>
            No console output captured yet.
          </span>
        ) : (
          lines.slice(-200).map((l, i) => (
            <div key={i} style={logLine()}>
              {l.line}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

/** Ticking clock so uptime/age readouts stay fresh (and render stays pure). */
function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}

function NodeRow({ node }: { node: NodeSnapshot }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const now = useNow()
  const uptime = node.startedAt ? fmtDuration(now - node.startedAt) : '—'
  const m = node.metrics
  return (
    <>
      <div style={tableRow({ clickable: true })} onClick={() => setExpanded(!expanded)}>
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
        <span style={{ width: COLS.util, display: 'inline-flex' }}>
          {m ? (
            <UtilBar
              pct={m.gpuUtil}
              label={`${m.gpuUtil.toFixed(0)}% ${m.vramUsedGb.toFixed(0)}G`}
            />
          ) : (
            <span style={{ color: TOKENS.textFaint, fontSize: SCALE.textXs }}>—</span>
          )}
        </span>
        <span style={{ width: COLS.cpu, display: 'inline-flex' }}>
          {m && m.cpuCores > 0 ? (
            <UtilBar pct={(m.cpuLoad1 / m.cpuCores) * 100} label={m.cpuLoad1.toFixed(1)} />
          ) : (
            <span style={{ color: TOKENS.textFaint, fontSize: SCALE.textXs }}>—</span>
          )}
        </span>
        <span style={{ ...mono, ...cellSm, width: COLS.rate }}>
          {node.dphTotal != null ? fmtRate(node.dphTotal) : '—'}
        </span>
        <span style={{ ...mono, ...cellSm, width: COLS.cost }}>
          {fmtMoney(node.accumulatedCost)}
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
