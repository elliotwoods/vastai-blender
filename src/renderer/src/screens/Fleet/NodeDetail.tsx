/**
 * Expanded row for a fleet node — the "what is this machine actually doing"
 * panel. Five live gauges (%GPU, %VRAM, %CPU, %RAM, temp), the money strip,
 * what it is rendering right now, its capabilities, and the console tail.
 *
 * Everything here comes from the NodeSnapshot the row already has, except the
 * workload panel, which fetches the node→chunk→job join it needs (NodeWorkload).
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Icon, type IconName } from '../../components/Icon'
import { InfoHint } from '../../components/Tooltip'
import { btn, logLine, mono, sectionLabel } from '../../lib/controls'
import { HINTS } from '../../lib/hints'
import { compareCo2 } from '../../lib/co2'
import {
  fmtCo2,
  fmtDuration,
  fmtEnergy,
  fmtMoney,
  fmtRate,
  fmtTimeAgo,
  fmtWatts
} from '../../lib/format'
import { ipc } from '../../lib/ipc'
import { NO_LINES, useLogStore } from '../../lib/logStore'
import { SCALE, TOKENS } from '../../lib/theme'
import { useNow } from '../../lib/useNow'
import { TONE_COLOR, pctOf, usageTone, type Tone } from '../../lib/usage'
import { Meter } from './meters'
import { NodeWorkload } from './NodeWorkload'
import type { NodeSnapshot } from '../../../../shared/models'

const card: CSSProperties = {
  flex: '1 1 150px',
  minWidth: 142,
  background: TOKENS.surface,
  border: `1px solid ${TOKENS.border}`,
  borderRadius: SCALE.radiusSm,
  padding: `${SCALE.space2} ${SCALE.space3}`
}

const cardHead: CSSProperties = {
  ...sectionLabel(),
  display: 'flex',
  alignItems: 'center',
  gap: 5,
  marginBottom: 5
}

/** One gauge: icon + label, big mono value, secondary text, meter. */
function Gauge({
  icon,
  label,
  value,
  sub,
  pct,
  tone = 'normal'
}: {
  icon: IconName
  label: string
  value: string
  sub?: string
  pct: number | null
  tone?: Tone
}): React.JSX.Element {
  return (
    <div style={card}>
      <div style={cardHead}>
        <Icon name={icon} size={11} />
        {label}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 6 }}>
        <span
          style={{
            ...mono,
            fontSize: SCALE.textXl,
            lineHeight: 1,
            color: pct == null ? TOKENS.textDisabled : TONE_COLOR[tone]
          }}
        >
          {value}
        </span>
        {sub ? (
          <span style={{ ...mono, fontSize: SCALE.text2xs, color: TOKENS.textFaint }}>{sub}</span>
        ) : null}
      </div>
      <Meter pct={pct} tone={pct == null ? 'idle' : tone} />
    </div>
  )
}

/**
 * Icon + label + value, used for the identity and money strips. `hint` adds an
 * ⓘ after the label for figures that need explaining (see lib/hints.ts).
 */
function Fact({
  icon,
  label,
  children,
  color,
  hint
}: {
  icon: IconName
  label: string
  children: ReactNode
  color?: string
  hint?: string
}): React.JSX.Element {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
      <span style={{ color: color ?? TOKENS.textFaint, display: 'flex' }}>
        <Icon name={icon} size={13} />
      </span>
      <span style={{ ...sectionLabel(), fontSize: SCALE.text2xs }}>{label}</span>
      {hint ? <InfoHint text={hint} /> : null}
      <span
        style={{
          ...mono,
          fontSize: SCALE.textSm,
          color: color ?? TOKENS.textSecondary,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap'
        }}
      >
        {children}
      </span>
    </span>
  )
}

type CapState = 'ok' | 'no' | 'unknown' | 'warn'

const CAP_ICON: Record<CapState, IconName> = {
  ok: 'check',
  no: 'cross',
  unknown: 'question',
  warn: 'alert'
}

const CAP_COLOR: Record<CapState, string> = {
  ok: TOKENS.accent,
  no: TOKENS.textDisabled,
  unknown: TOKENS.textFaint,
  warn: TOKENS.warn
}

function Cap({ state, label }: { state: CapState; label: string }): React.JSX.Element {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 8px',
        borderRadius: SCALE.radiusPill,
        border: `1px solid ${state === 'no' ? TOKENS.border : CAP_COLOR[state]}`,
        color: CAP_COLOR[state],
        fontSize: SCALE.text2xs,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        fontWeight: SCALE.weightSemibold,
        whiteSpace: 'nowrap'
      }}
    >
      <Icon name={CAP_ICON[state]} size={10} />
      {label}
    </span>
  )
}

const separator: CSSProperties = { width: 1, alignSelf: 'stretch', background: TOKENS.border }

/** Percentage headline for a gauge ("—" until the first metrics sample). */
function pct(value: number | null): string {
  return value == null ? '—' : `${value.toFixed(0)}%`
}

export function NodeDetail({ node }: { node: NodeSnapshot }): React.JSX.Element {
  const lines = useLogStore((s) => s.byNode[node.id] ?? NO_LINES)
  const now = useNow(10_000)
  const [flash, setFlash] = useState<string | null>(null)
  const [consoleFlash, setConsoleFlash] = useState<string | null>(null)
  const [hasSelection, setHasSelection] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)

  // Keep the console pinned to the newest line while the panel is open — but
  // not while the user is holding a selection in it, or autoscroll would yank
  // the text out from under them mid-drag.
  useEffect(() => {
    const el = logRef.current
    if (el && !hasSelection) el.scrollTop = el.scrollHeight
  }, [lines.length, hasSelection])

  // `body` sets `user-select: none` app-wide, so the console opts back in (see
  // the panel style below). Track whether the live selection is inside THIS
  // node's console, to label the copy button and pause autoscroll.
  useEffect(() => {
    const onSelectionChange = (): void => {
      const sel = window.getSelection()
      const anchor = sel?.anchorNode ?? null
      setHasSelection(!!sel && !sel.isCollapsed && !!anchor && !!logRef.current?.contains(anchor))
    }
    document.addEventListener('selectionchange', onSelectionChange)
    return () => document.removeEventListener('selectionchange', onSelectionChange)
  }, [])

  const say = (msg: string): void => {
    setFlash(msg)
    setTimeout(() => setFlash(null), 2200)
  }

  /**
   * Console feedback goes beside the copy button, not through `say` — the
   * identity strip's flash is at the top of a tall panel, so a confirmation
   * for a control down at the console would land off-screen.
   */
  const sayConsole = (msg: string): void => {
    setConsoleFlash(msg)
    setTimeout(() => setConsoleFlash(null), 2200)
  }

  const copySsh = async (): Promise<void> => {
    const info = await ipc.invoke('node:sshCommand', node.id)
    if (!info) return say('no ssh endpoint yet')
    await ipc.invoke('clipboard:write', info.command)
    say('ssh command copied')
  }

  /**
   * With a highlighted range, copies just that; otherwise the whole retained
   * buffer (logStore keeps 5000/node), not merely the last 200 the panel
   * renders — the interesting line is usually scrolled off.
   */
  const copyConsole = async (): Promise<void> => {
    const picked = hasSelection ? (window.getSelection()?.toString() ?? '') : ''
    if (picked) {
      await ipc.invoke('clipboard:write', picked)
      return sayConsole('selection copied')
    }
    if (!lines.length) return sayConsole('nothing to copy yet')
    await ipc.invoke('clipboard:write', lines.map((l) => l.line).join('\n'))
    sayConsole(`${lines.length} lines copied`)
  }

  const openShell = async (): Promise<void> => {
    const res = await ipc.invoke('node:openSshTerminal', node.id)
    if (res.ok) return say(res.message)
    await copySsh()
    say(res.message)
  }

  const m = node.metrics
  const vramPct = m ? pctOf(m.vramUsedGb, m.vramTotalGb) : null
  const ramPct = m ? pctOf(m.ramUsedGb, m.ramTotalGb) : null
  const powerPct = m ? pctOf(m.powerW, m.powerLimitW) : null
  // Temperature reads on a 30–95 °C scale — the range that matters for a GPU.
  const tempPct = m ? ((m.gpuTemp - 30) / 65) * 100 : 0
  const tempTone: Tone = !m
    ? 'idle'
    : m.gpuTemp > 85
      ? 'danger'
      : m.gpuTemp > 75
        ? 'warn'
        : 'normal'
  const uptimeMs = node.startedAt ? now - node.startedAt : 0
  const burn = uptimeMs > 3 * 60_000 ? node.accumulatedCost / (uptimeMs / 3_600_000) : null

  return (
    <div
      style={{
        padding: `${SCALE.space3} ${SCALE.space4} ${SCALE.space3}`,
        background: TOKENS.surface,
        borderBottom: `1px solid ${TOKENS.border}`,
        display: 'flex',
        flexDirection: 'column',
        gap: SCALE.space3
      }}
    >
      {/* -- identity ------------------------------------------------------ */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: `6px ${SCALE.space4}`
        }}
      >
        <Fact icon="gpu" label="gpu" color={TOKENS.text}>
          {node.gpuName ?? 'unknown'}
          {node.numGpus > 1 ? ` ×${node.numGpus}` : ''}
        </Fact>
        <span style={separator} />
        <Fact icon="server" label="instance">
          {node.instanceId != null ? `#${node.instanceId}` : '—'}
        </Fact>
        {node.instanceId != null ? (
          <button
            title="Open the Vast.ai instances page"
            style={{ ...btn({ variant: 'ghost', size: 'sm' }), padding: '2px 5px' }}
            onClick={() =>
              void ipc.invoke('shell:openExternal', 'https://cloud.vast.ai/instances/')
            }
          >
            <Icon name="external" size={12} />
          </button>
        ) : null}
        <span style={separator} />
        <button
          title="Copy the full ssh command (key, port, user) to the clipboard"
          style={{
            ...btn({ variant: 'ghost', size: 'sm' }),
            padding: '2px 6px',
            color: TOKENS.textSecondary,
            cursor: node.sshHost ? 'pointer' : 'default'
          }}
          disabled={!node.sshHost}
          onClick={() => void copySsh()}
        >
          <Icon name="network" size={13} />
          <span style={{ ...mono, fontSize: SCALE.textSm }}>
            {node.sshHost ? `root@${node.sshHost}:${node.sshPort}` : 'no endpoint yet'}
          </span>
          {node.sshHost ? <Icon name="copy" size={11} /> : null}
        </button>
        <button
          title="Open an interactive ssh session in a terminal window"
          style={{ ...btn({ size: 'sm' }), opacity: node.sshHost ? 1 : 0.5 }}
          disabled={!node.sshHost}
          onClick={() => void openShell()}
        >
          <Icon name="terminal" size={12} />
          ssh
        </button>
        <span style={{ flex: 1 }} />
        {flash ? (
          <span style={{ fontSize: SCALE.textXs, color: TOKENS.accent }}>{flash}</span>
        ) : null}
        <span style={{ ...mono, fontSize: SCALE.text2xs, color: TOKENS.textDisabled }}>
          {node.id.slice(0, 8)}
        </span>
      </div>

      {/* -- gauges -------------------------------------------------------- */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: SCALE.space2 }}>
        <Gauge
          icon="gpu"
          label="gpu"
          value={pct(m ? m.gpuUtil : null)}
          sub={m && m.gpuUtil < 5 ? 'idle' : 'compute'}
          pct={m ? m.gpuUtil : null}
          tone={usageTone(m ? m.gpuUtil : null, { idleBelow: 5, compute: true })}
        />
        <Gauge
          icon="memory"
          label="vram"
          value={pct(vramPct)}
          sub={m ? `${m.vramUsedGb.toFixed(1)} / ${m.vramTotalGb.toFixed(0)} GB` : undefined}
          pct={vramPct}
          tone={usageTone(vramPct)}
        />
        <Gauge
          icon="cpu"
          label="cpu"
          value={pct(m ? m.cpuUtil : null)}
          sub={m ? `load ${m.cpuLoad1.toFixed(1)} / ${m.cpuCores}` : undefined}
          pct={m ? m.cpuUtil : null}
          tone={usageTone(m ? m.cpuUtil : null, { idleBelow: 5, compute: true })}
        />
        <Gauge
          icon="memory"
          label="ram"
          value={pct(ramPct)}
          sub={
            m && m.ramTotalGb > 0
              ? `${m.ramUsedGb.toFixed(1)} / ${m.ramTotalGb.toFixed(0)} GB`
              : undefined
          }
          pct={ramPct}
          tone={usageTone(ramPct)}
        />
        <Gauge
          icon="power"
          label="gpu power"
          value={m && m.powerW > 0 ? fmtWatts(m.powerW) : '—'}
          sub={m && m.powerLimitW > 0 ? `/ ${fmtWatts(m.powerLimitW)} cap` : undefined}
          pct={powerPct}
          tone={usageTone(powerPct)}
        />
        <Gauge
          icon="temp"
          label="gpu temp"
          value={m ? `${m.gpuTemp.toFixed(0)}°` : '—'}
          sub={m ? 'celsius' : undefined}
          pct={m ? tempPct : null}
          tone={tempTone}
        />
      </div>

      {/* -- money + workload ---------------------------------------------- */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: `6px ${SCALE.space4}`
        }}
      >
        <Fact icon="dollar" label="rate" hint={HINTS.rate}>
          {node.dphTotal != null ? fmtRate(node.dphTotal) : '—'}
        </Fact>
        <Fact icon="cost" label="spent" color={TOKENS.text} hint={HINTS.spent}>
          {fmtMoney(node.accumulatedCost)}
        </Fact>
        <Fact
          icon="battery"
          label="energy"
          color={node.energyWh > 0 ? TOKENS.text : undefined}
          hint={
            node.co2g > 0
              ? `${HINTS.energy}\n\n${fmtCo2(node.co2g)} — ${compareCo2(node.co2g)}\nGrid: ${node.geolocation ?? 'location not recorded, world average used'}.\n\n${HINTS.co2}`
              : HINTS.energy
          }
        >
          {fmtEnergy(node.energyWh)}
        </Fact>
        {burn != null ? (
          <Fact icon="activity" label="actual" hint={HINTS.actual}>
            {fmtRate(burn)}
          </Fact>
        ) : null}
        <Fact icon="clock" label="uptime" hint={HINTS.uptime}>
          {node.startedAt ? fmtDuration(uptimeMs) : '—'}
        </Fact>
      </div>

      {/* -- workload ------------------------------------------------------- */}
      <NodeWorkload node={node} />

      {/* -- capabilities --------------------------------------------------- */}
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: SCALE.space2 }}>
        <span style={{ ...sectionLabel(), display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <Icon name="cube" size={11} />
          blender
        </span>
        {node.blenderVersions.length ? (
          node.blenderVersions.map((v) => <Cap key={v} state="ok" label={v} />)
        ) : (
          <Cap state="unknown" label="none installed" />
        )}
        <Cap
          state={node.eeveeCapable == null ? 'unknown' : node.eeveeCapable ? 'ok' : 'no'}
          label={node.eeveeCapable == null ? 'eevee unprobed' : 'eevee'}
        />
        <Cap
          state={node.octaneReady ? 'ok' : node.octaneNeedsManualLogin ? 'warn' : 'no'}
          label={node.octaneNeedsManualLogin ? 'octane login needed' : 'octane'}
        />
        <span style={{ flex: 1 }} />
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            fontSize: SCALE.text2xs,
            color: m && now - m.updatedAt > 90_000 ? TOKENS.warn : TOKENS.textFaint
          }}
        >
          <Icon name="activity" size={11} />
          {m ? `metrics ${fmtTimeAgo(m.updatedAt)}` : 'no metrics yet'}
        </span>
      </div>

      {/* -- last error ------------------------------------------------------ */}
      {node.lastError ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: SCALE.space2,
            padding: `${SCALE.space2} ${SCALE.space3}`,
            borderRadius: SCALE.radiusSm,
            border: `1px solid ${TOKENS.dangerBorder}`,
            background: 'rgba(248, 113, 113, 0.08)',
            color: TOKENS.danger,
            fontSize: SCALE.textXs
          }}
        >
          <Icon name="alert" size={13} style={{ marginTop: 1 }} />
          <span style={{ ...mono, wordBreak: 'break-word' }}>{node.lastError}</span>
        </div>
      ) : null}

      {/* -- console --------------------------------------------------------- */}
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
          <Icon name="terminal" size={11} />
          console
          <span style={{ ...mono, color: TOKENS.textDisabled }}>
            {lines.length ? `${lines.length} lines` : ''}
          </span>
          <span style={{ flex: 1 }} />
          {consoleFlash ? (
            <span style={{ fontSize: SCALE.text2xs, color: TOKENS.accent }}>{consoleFlash}</span>
          ) : null}
          {lines.length ? (
            <button
              title={
                hasSelection
                  ? 'Copy the highlighted text (Ctrl+C works too)'
                  : `Copy all ${lines.length} captured lines to the clipboard (the panel only shows the last 200). Select text to copy just part of it.`
              }
              style={{
                ...btn({ variant: hasSelection ? 'default' : 'ghost', size: 'sm' }),
                padding: '2px 6px'
              }}
              onClick={() => void copyConsole()}
            >
              <Icon name="copy" size={11} />
              {hasSelection ? 'copy selection' : 'copy'}
            </button>
          ) : null}
        </div>
        <div
          ref={logRef}
          style={{
            background: TOKENS.surfaceRaised,
            border: `1px solid ${TOKENS.border}`,
            borderRadius: SCALE.radiusSm,
            padding: SCALE.space2,
            maxHeight: 180,
            overflow: 'auto',
            // Opt out of the app-wide `user-select: none` (base.css): log text
            // is the one thing here people genuinely need to lift out.
            userSelect: 'text',
            cursor: 'text'
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
    </div>
  )
}
