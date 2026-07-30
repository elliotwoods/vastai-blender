import { useState, type CSSProperties } from 'react'
import { AppToolbar } from '../../components/AppToolbar'
import { OpenInExplorerButton } from '../../components/OpenInExplorerButton'
import { InfoHint } from '../../components/Tooltip'
import { btn, chip, input, menuItem, mono, panel, sectionLabel } from '../../lib/controls'
import { HINTS } from '../../lib/hints'
import { ipc } from '../../lib/ipc'
import { useNav, type SettingsSection } from '../../lib/nav'
import { qk, useAddons, useSettings, useUpdateSettings } from '../../lib/queries'
import { SCALE, TOKENS } from '../../lib/theme'
import { useQueryClient } from '@tanstack/react-query'
import type { SettingsPublic } from '../../../../shared/models'

const SECTIONS: Array<{ key: SettingsSection; label: string }> = [
  { key: 'api', label: 'Vast.ai API' },
  { key: 'general', label: 'General' },
  { key: 'ssh', label: 'SSH' },
  { key: 'addons', label: 'Extensions' },
  { key: 'octane', label: 'Octane' },
  { key: 'offers', label: 'Offer filters' }
]

const formRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: SCALE.space3,
  marginBottom: SCALE.space3
}

const label: CSSProperties = { width: 170, fontSize: SCALE.textSm, color: TOKENS.textMuted }

/** Form label with an ⓘ, for settings whose effect isn't obvious from the name. */
function FieldLabel({ text, hint }: { text: string; hint: string }): React.JSX.Element {
  return (
    <span style={{ ...label, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span>{text}</span>
      <InfoHint text={hint} size={10} />
    </span>
  )
}

function ApiSection(): React.JSX.Element {
  const { data: settings } = useSettings()
  const qc = useQueryClient()
  const [key, setKey] = useState('')
  const [testResult, setTestResult] = useState<string | null>(null)

  return (
    <div>
      <div style={{ ...sectionLabel(), marginBottom: SCALE.space3 }}>Vast.ai API</div>
      <div style={formRow}>
        <span style={label}>API key</span>
        <input
          type="password"
          placeholder={settings?.hasVastApiKey ? '••••••••  (saved)' : 'paste your Vast.ai API key'}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          style={{ ...input({ size: 'sm' }), width: 340 }}
        />
        <button
          style={btn({ variant: 'primary', size: 'sm', disabled: !key })}
          disabled={!key}
          onClick={() => {
            void ipc.invoke('settings:setSecret', 'vastApiKey', key).then(() => {
              setKey('')
              setTestResult(null)
              void qc.invalidateQueries({ queryKey: qk.settings })
            })
          }}
        >
          save
        </button>
        <button
          style={btn({ size: 'sm', disabled: !settings?.hasVastApiKey })}
          disabled={!settings?.hasVastApiKey}
          onClick={() => {
            setTestResult('testing…')
            void ipc.invoke('vast:testKey').then((r) => setTestResult(r.message))
          }}
        >
          test
        </button>
      </div>
      {testResult ? (
        <div style={{ ...mono, fontSize: SCALE.textXs, color: TOKENS.textMuted }}>{testResult}</div>
      ) : null}
    </div>
  )
}

function GeneralSection(): React.JSX.Element {
  const { data: settings } = useSettings()
  const update = useUpdateSettings()
  if (!settings) return <div />
  return (
    <div>
      <div style={{ ...sectionLabel(), marginBottom: SCALE.space3 }}>General</div>
      <div style={formRow}>
        <span style={label}>Project root</span>
        <span style={{ ...mono, fontSize: SCALE.textSm, color: TOKENS.textSecondary }}>
          {settings.projectRoot || '(not set)'}
        </span>
        {settings.projectRoot ? (
          <OpenInExplorerButton path={settings.projectRoot} mode="open" />
        ) : null}
        <button
          style={btn({ size: 'sm' })}
          onClick={() => {
            void ipc.invoke('dialog:pickFolder').then((dir) => {
              if (dir) update.mutate({ projectRoot: dir })
            })
          }}
        >
          choose…
        </button>
      </div>
      <div style={formRow}>
        <span style={label}>Max active nodes</span>
        <input
          type="number"
          min={0}
          max={16}
          value={settings.maxActiveNodes}
          onChange={(e) => update.mutate({ maxActiveNodes: Number(e.target.value) })}
          style={{ ...input({ size: 'sm' }), ...mono, width: 80 }}
        />
      </div>
      <div style={formRow}>
        <FieldLabel text="Spend cap ($/hr, blank = off)" hint={HINTS.spendCap} />
        <input
          type="number"
          min={0}
          step={0.1}
          value={settings.spendCapPerHour ?? ''}
          onChange={(e) =>
            update.mutate({
              spendCapPerHour: e.target.value === '' ? null : Number(e.target.value)
            })
          }
          style={{ ...input({ size: 'sm' }), ...mono, width: 80 }}
        />
      </div>
      <div style={formRow}>
        <span style={label}>Max render slots per node</span>
        <input
          type="number"
          min={0}
          max={24}
          placeholder="auto"
          value={settings.maxNodeSlots || ''}
          onChange={(e) =>
            update.mutate({
              maxNodeSlots: Math.max(0, Math.min(24, Number(e.target.value) || 0))
            })
          }
          style={{ ...input({ size: 'sm' }), ...mono, width: 80 }}
        />
        <span style={{ fontSize: SCALE.textXs, color: TOKENS.textFaint }}>
          blank = auto: each node&apos;s concurrency is measured and tuned on the fly. Set a number
          to cap it. Only jobs marked &ldquo;share node&rdquo; ever run more than one at a time.
        </span>
      </div>
      <div style={formRow}>
        <FieldLabel text="CO₂ overhead factor" hint={HINTS.co2Overhead} />
        <input
          type="number"
          min={1}
          max={3}
          step={0.1}
          value={settings.co2OverheadFactor}
          onChange={(e) =>
            update.mutate({
              co2OverheadFactor: Math.max(1, Math.min(3, Number(e.target.value) || 1))
            })
          }
          style={{ ...input({ size: 'sm' }), ...mono, width: 80 }}
        />
        <span style={{ fontSize: SCALE.textXs, color: TOKENS.textFaint }}>
          Scales measured GPU watts up to a whole-machine estimate for the CO₂ figures only — host
          CPU, PSU losses and datacentre cooling. 1 = count the GPU alone. Energy readouts are never
          scaled by this.
        </span>
      </div>
      <div style={formRow}>
        <span style={label}>Frame thumbnails</span>
        <label
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: SCALE.textXs,
            color: TOKENS.textMuted
          }}
        >
          <input
            type="checkbox"
            checked={settings.thumbnails}
            onChange={(e) => update.mutate({ thumbnails: e.target.checked })}
          />
          stream a small JPEG per frame as it renders
        </label>
        <span style={{ fontSize: SCALE.textXs, color: TOKENS.textFaint }}>
          Render output is usually EXR, which browsers can&apos;t display — without these the UI has
          no image until a chunk finishes encoding. Costs one small ffmpeg run per frame on the
          node.
        </span>
      </div>
      <div style={formRow}>
        <span style={label}>Live preview clip</span>
        <select
          value={settings.livePreview}
          onChange={(e) =>
            update.mutate({
              livePreview: e.target.value as SettingsPublic['livePreview']
            })
          }
          style={{ ...input({ size: 'sm' }), width: 130 }}
        >
          <option value="off">off</option>
          <option value="onDemand">while watching</option>
          <option value="always">always</option>
        </select>
        <input
          type="number"
          min={256}
          max={3840}
          step={64}
          value={settings.livePreviewWidth}
          onChange={(e) =>
            update.mutate({
              livePreviewWidth: Math.max(256, Math.min(3840, Number(e.target.value) || 960))
            })
          }
          style={{ ...input({ size: 'sm' }), ...mono, width: 80 }}
        />
        <span style={{ fontSize: SCALE.textXs, color: TOKENS.textFaint }}>
          A video assembled on the node one frame at a time, so you can watch a chunk render.
          &ldquo;While watching&rdquo; only encodes for a chunk whose preview is open — an always-on
          encoder competes with the render on a many-slot node.
        </span>
      </div>
      <div style={formRow}>
        <span style={label}>Idle timeout (minutes)</span>
        <input
          type="number"
          min={1}
          value={settings.idleTimeoutMinutes}
          onChange={(e) => update.mutate({ idleTimeoutMinutes: Number(e.target.value) })}
          style={{ ...input({ size: 'sm' }), ...mono, width: 80 }}
        />
      </div>
      <div style={formRow}>
        <span style={label}>Proxy codec</span>
        <select
          value={settings.proxyCodec}
          onChange={(e) => update.mutate({ proxyCodec: e.target.value as 'hevc' | 'av1' })}
          style={{ ...input({ size: 'sm' }), width: 120 }}
        >
          <option value="hevc">HEVC (H.265)</option>
          <option value="av1">AV1</option>
        </select>
      </div>
      <div style={formRow}>
        <span style={label}>Blender version override</span>
        <input
          type="text"
          placeholder="auto (match .blend)"
          value={settings.blenderVersionOverride ?? ''}
          onChange={(e) =>
            update.mutate({ blenderVersionOverride: e.target.value === '' ? null : e.target.value })
          }
          style={{ ...input({ size: 'sm' }), ...mono, width: 160 }}
        />
      </div>
    </div>
  )
}

function SshSection(): React.JSX.Element {
  const { data: settings } = useSettings()
  return (
    <div>
      <div style={{ ...sectionLabel(), marginBottom: SCALE.space3 }}>SSH</div>
      <div style={formRow}>
        <span style={label}>Keypair</span>
        <span style={{ ...mono, fontSize: SCALE.textSm, color: TOKENS.textSecondary }}>
          {settings?.sshKeyPath || '(generated on first fleet start)'}
        </span>
        {settings?.sshKeyPath ? <OpenInExplorerButton path={settings.sshKeyPath} /> : null}
      </div>
    </div>
  )
}

function AddonsSection(): React.JSX.Element {
  const { data: addons } = useAddons()
  const qc = useQueryClient()
  return (
    <div>
      <div style={{ ...sectionLabel(), marginBottom: SCALE.space3 }}>
        Blender extensions (user-provided zips)
      </div>
      {(addons ?? []).map((a) => (
        <div key={a.id} style={{ ...formRow, gap: SCALE.space2 }}>
          <span style={{ fontSize: SCALE.textSm, width: 160 }}>{a.name}</span>
          <span style={{ ...mono, fontSize: SCALE.textXs, color: TOKENS.textFaint }}>
            {a.version}
          </span>
          <span style={chip({ tone: 'neutral' })}>{a.mechanism}</span>
          <OpenInExplorerButton path={a.zipPath} />
          <button
            style={btn({ variant: 'danger', size: 'sm' })}
            onClick={() =>
              void ipc
                .invoke('addon:remove', a.id)
                .then(() => qc.invalidateQueries({ queryKey: qk.addons }))
            }
          >
            remove
          </button>
        </div>
      ))}
      <button
        style={btn({ size: 'sm' })}
        onClick={() => {
          void ipc.invoke('dialog:pickZipFile').then((zip) => {
            if (zip)
              void ipc
                .invoke('addon:register', zip)
                .then(() => qc.invalidateQueries({ queryKey: qk.addons }))
          })
        }}
      >
        + register extension zip
      </button>
    </div>
  )
}

function OctaneSection(): React.JSX.Element {
  const { data: settings } = useSettings()
  const qc = useQueryClient()
  const [user, setUser] = useState('')
  const [pass, setPass] = useState('')
  return (
    <div>
      <div style={{ ...sectionLabel(), marginBottom: SCALE.space3 }}>Octane license</div>
      <div style={{ fontSize: SCALE.textXs, color: TOKENS.textFaint, marginBottom: SCALE.space3 }}>
        Credentials are stored encrypted locally and only injected into the render node&apos;s
        OctaneServer process environment — never written to node disk.
      </div>
      <div style={formRow}>
        <span style={label}>OTOY account</span>
        <input
          placeholder={settings?.hasOtoyCredentials ? '(saved)' : 'email'}
          value={user}
          onChange={(e) => setUser(e.target.value)}
          style={{ ...input({ size: 'sm' }), width: 240 }}
        />
      </div>
      <div style={formRow}>
        <span style={label}>Password</span>
        <input
          type="password"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          style={{ ...input({ size: 'sm' }), width: 240 }}
        />
        <button
          style={btn({ variant: 'primary', size: 'sm', disabled: !user || !pass })}
          disabled={!user || !pass}
          onClick={() => {
            void Promise.all([
              ipc.invoke('settings:setSecret', 'otoyUsername', user),
              ipc.invoke('settings:setSecret', 'otoyPassword', pass)
            ]).then(() => {
              setUser('')
              setPass('')
              void qc.invalidateQueries({ queryKey: qk.settings })
            })
          }}
        >
          save
        </button>
      </div>
    </div>
  )
}

function OffersSection(): React.JSX.Element {
  const { data: settings } = useSettings()
  const update = useUpdateSettings()
  const [gpuInput, setGpuInput] = useState('')
  if (!settings) return <div />
  const f = settings.offerFilters
  const setFilters = (patch: Partial<typeof f>): void => {
    update.mutate({ offerFilters: { ...f, ...patch } })
  }
  return (
    <div>
      <div style={{ ...sectionLabel(), marginBottom: SCALE.space3 }}>Offer search filters</div>
      <div style={formRow}>
        <span style={label}>GPU allowlist</span>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          {f.gpuNames.map((g) => (
            <span key={g} style={chip({ tone: 'accent' })}>
              {g}
              <button
                style={{ cursor: 'pointer', color: TOKENS.textMuted, marginLeft: 4 }}
                onClick={() => setFilters({ gpuNames: f.gpuNames.filter((x) => x !== g) })}
              >
                ×
              </button>
            </span>
          ))}
          <input
            placeholder="e.g. RTX 4090 (blank = any)"
            value={gpuInput}
            onChange={(e) => setGpuInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && gpuInput.trim()) {
                setFilters({ gpuNames: [...f.gpuNames, gpuInput.trim()] })
                setGpuInput('')
              }
            }}
            style={{ ...input({ size: 'sm' }), width: 200 }}
          />
        </div>
      </div>
      <div style={formRow}>
        <FieldLabel text="Max $/hr" hint={HINTS.maxDph} />
        <input
          type="number"
          min={0}
          step={0.05}
          value={f.maxDphTotal ?? ''}
          onChange={(e) =>
            setFilters({ maxDphTotal: e.target.value === '' ? null : Number(e.target.value) })
          }
          style={{ ...input({ size: 'sm' }), ...mono, width: 90 }}
        />
      </div>
      <div style={formRow}>
        <span style={label}>Min GPU RAM (GB)</span>
        <input
          type="number"
          min={0}
          value={f.minGpuRamGb}
          onChange={(e) => setFilters({ minGpuRamGb: Number(e.target.value) })}
          style={{ ...input({ size: 'sm' }), ...mono, width: 90 }}
        />
      </div>
      <div style={formRow}>
        <span style={label}>Min download (Mbps)</span>
        <input
          type="number"
          min={0}
          value={f.minInetDownMbps}
          onChange={(e) => setFilters({ minInetDownMbps: Number(e.target.value) })}
          style={{ ...input({ size: 'sm' }), ...mono, width: 90 }}
        />
      </div>
      <div style={formRow}>
        <span style={label}>Min reliability</span>
        <input
          type="number"
          min={0}
          max={1}
          step={0.01}
          value={f.minReliability}
          onChange={(e) => setFilters({ minReliability: Number(e.target.value) })}
          style={{ ...input({ size: 'sm' }), ...mono, width: 90 }}
        />
      </div>
    </div>
  )
}

export function SettingsScreen({ section }: { section?: SettingsSection }): React.JSX.Element {
  const { navigate } = useNav()
  const active = section ?? 'api'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <AppToolbar />
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <div
          style={{
            width: 180,
            flexShrink: 0,
            padding: SCALE.space3,
            borderRight: `1px solid ${TOKENS.border}`
          }}
        >
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              style={{
                ...menuItem({ accent: s.key === active }),
                background: s.key === active ? TOKENS.accentSoftBg : 'transparent'
              }}
              onClick={() => navigate({ screen: 'settings', section: s.key })}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: SCALE.space5 }}>
          <div style={{ ...panel(), padding: SCALE.space5, maxWidth: 720 }}>
            {active === 'api' ? (
              <ApiSection />
            ) : active === 'general' ? (
              <GeneralSection />
            ) : active === 'ssh' ? (
              <SshSection />
            ) : active === 'addons' ? (
              <AddonsSection />
            ) : active === 'octane' ? (
              <OctaneSection />
            ) : (
              <OffersSection />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
