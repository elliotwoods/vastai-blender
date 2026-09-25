import { useState, type CSSProperties } from 'react'
import { AppToolbar } from '../../components/AppToolbar'
import { NumberField } from '../../components/NumberField'
import { OpenInExplorerButton } from '../../components/OpenInExplorerButton'
import { InfoHint } from '../../components/Tooltip'
import { btn, chip, input, menuItem, mono, panel, sectionLabel } from '../../lib/controls'
import { HINTS } from '../../lib/hints'
import { ipc } from '../../lib/ipc'
import { useNav, type SettingsSection } from '../../lib/nav'
import { qk, useAddons, useSettings, useUpdateSettings } from '../../lib/queries'
import { SCALE, TOKENS } from '../../lib/theme'
import { useQueryClient } from '@tanstack/react-query'
import type {
  EngineId,
  OfferFilters,
  SettingsFieldError,
  SettingsPatch,
  SettingsPublic,
  VastKeyTest,
  VastPermission
} from '../../../../shared/models'
import {
  blenderVersionPatch,
  blenderVersionProblem,
  dockerImagePatch,
  dockerImageProblem,
  limitsOf,
  mergeFieldErrors,
  noSpendCapPatch,
  spendCapMode
} from './settingsForm'

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

/**
 * The permission groups to tick when creating the app's key on Vast, as the
 * JSON Vast's "create API key" takes (docs.vast.ai/api-reference/permissions).
 */
const VAST_KEY_PERMISSIONS = JSON.stringify({
  api: { misc: {}, user_read: {}, instance_read: {}, instance_write: {} }
})

const PERMISSION_USE: Record<VastPermission, string> = {
  user_read: 'account and credit',
  instance_read: 'list nodes and SSH keys',
  misc: 'search offers',
  instance_write: 'rent and destroy nodes, register the SSH key'
}

function ApiSection(): React.JSX.Element {
  const { data: settings } = useSettings()
  const qc = useQueryClient()
  const [key, setKey] = useState('')
  const [test, setTest] = useState<VastKeyTest | 'testing' | null>(null)
  const [copied, setCopied] = useState(false)

  const runTest = (): void => {
    setTest('testing')
    void ipc.invoke('vast:testKey').then(setTest)
  }

  return (
    <div>
      <div style={{ ...sectionLabel(), marginBottom: SCALE.space3 }}>Vast.ai API</div>
      <div style={formRow}>
        <FieldLabel text="API key" hint={HINTS.vastApiKey} />
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
            void ipc.invoke('settings:setSecret', 'vastApiKey', key.trim()).then(() => {
              setKey('')
              void qc.invalidateQueries({ queryKey: qk.settings })
              runTest()
            })
          }}
        >
          save
        </button>
        <button
          style={btn({ size: 'sm', disabled: !settings?.hasVastApiKey })}
          disabled={!settings?.hasVastApiKey}
          onClick={runTest}
        >
          test
        </button>
      </div>
      <div style={{ ...formRow, alignItems: 'flex-start' }}>
        <span style={label} />
        <div style={{ ...hintText, maxWidth: 520, lineHeight: 1.5 }}>
          Create a key just for this app on Vast&apos;s keys page, restricted to the permissions it
          needs: <span style={mono}>misc, user_read, instance_read, instance_write</span>. Paste the
          permissions JSON into Vast&apos;s key dialog, or tick the same groups.
          <div style={{ display: 'flex', gap: SCALE.space2, marginTop: SCALE.space2 }}>
            <button
              style={btn({ size: 'sm' })}
              onClick={() =>
                void ipc.invoke('shell:openExternal', 'https://cloud.vast.ai/manage-keys/')
              }
            >
              open Vast keys page…
            </button>
            <button
              style={btn({ size: 'sm' })}
              onClick={() => {
                void ipc.invoke('clipboard:write', VAST_KEY_PERMISSIONS).then(() => {
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                })
              }}
            >
              {copied ? 'copied' : 'copy permissions JSON'}
            </button>
          </div>
        </div>
      </div>
      {test === 'testing' ? (
        <div style={{ ...mono, fontSize: SCALE.textXs, color: TOKENS.textMuted }}>testing…</div>
      ) : test ? (
        <div style={{ ...mono, fontSize: SCALE.textXs, color: TOKENS.textMuted }}>
          <div style={{ color: test.ok ? TOKENS.textMuted : TOKENS.danger }}>
            {test.ok ? 'OK — ' : ''}
            {test.message}
          </div>
          {test.checks.map((c) => (
            <div key={c.perm} style={{ color: c.ok === false ? TOKENS.danger : TOKENS.textMuted }}>
              {c.ok === true ? '✓' : c.ok === false ? '✗' : '–'} {c.perm.padEnd(15)}{' '}
              {PERMISSION_USE[c.perm]}
              {c.ok === true ? '' : ` — ${c.detail}`}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

const hintText: CSSProperties = { fontSize: SCALE.textXs, color: TOKENS.textFaint }

/**
 * Saving settings from a section: every change through settings:update
 * (plan 1.14), with what main refused or clamped kept per field until that
 * field is saved again, and a save that failed outright said once.
 */
function useSettingsSave(): {
  save: (patch: SettingsPatch) => void
  errorFor: (field: string) => SettingsFieldError | undefined
  failure: string | null
} {
  const update = useUpdateSettings()
  const [errors, setErrors] = useState<SettingsFieldError[]>([])
  const [failure, setFailure] = useState<string | null>(null)
  return {
    save: (patch) =>
      update.mutate(patch, {
        onSuccess: (result) => {
          setErrors((shown) => mergeFieldErrors(shown, patch, result.errors))
          setFailure(null)
        },
        onError: (e) => setFailure(e.message)
      }),
    errorFor: (field) => errors.find((e) => e.field === field),
    failure
  }
}

/** What main made of a field's last save, under the field: refused, or saved at its limit. */
function FieldNote({ error }: { error?: SettingsFieldError }): React.JSX.Element | null {
  if (!error) return null
  return (
    <div
      role={error.outcome === 'rejected' ? 'alert' : 'status'}
      style={{
        fontSize: SCALE.textXs,
        color: error.outcome === 'rejected' ? TOKENS.danger : TOKENS.warn,
        margin: `-${SCALE.space2} 0 ${SCALE.space3} 170px`,
        paddingLeft: SCALE.space3
      }}
    >
      {error.outcome === 'rejected' ? 'not saved: ' : ''}
      {error.message}
    </div>
  )
}

/** A save that never reached settings.json (a disk that refused it). */
function SaveFailure({ failure }: { failure: string | null }): React.JSX.Element | null {
  if (!failure) return null
  return (
    <div
      role="alert"
      style={{ fontSize: SCALE.textXs, color: TOKENS.danger, marginBottom: SCALE.space3 }}
    >
      Could not save the settings: {failure}
    </div>
  )
}

/**
 * The spend cap: a figure, or "no spend cap" ticked on purpose. Never a
 * blank field that means "uncapped" (#99 #112): the figure has no blank,
 * so clearing it to retype puts the old cap back until a new one is typed.
 */
export function SpendCapRow({
  settings,
  save,
  error
}: {
  settings: SettingsPublic
  save: (patch: SettingsPatch) => void
  error?: SettingsFieldError
}): React.JSX.Element {
  const mode = spendCapMode(settings)
  // Unticked while no cap is in force: the field waits for the figure to
  // turn the cap back on at, and until then there is still no cap.
  const [wantsCap, setWantsCap] = useState(false)
  const uncapped = mode === 'noCap' && !wantsCap
  const lim = limitsOf('spendCapPerHour')
  return (
    <>
      <div style={formRow}>
        <FieldLabel text="Spend cap ($/hr)" hint={HINTS.spendCap} />
        <NumberField
          aria-label="Spend cap in dollars per hour"
          value={mode === 'cap' ? settings.spendCapPerHour : null}
          onCommit={(v) => {
            if (v == null) return
            save({ spendCapPerHour: v })
            setWantsCap(false)
          }}
          min={lim.min}
          max={lim.max}
          step={0.1}
          allowBlank={uncapped ? 'no cap' : undefined}
          commitOnWindowBlur
          disabled={uncapped}
        />
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
            checked={uncapped}
            onChange={(e) => {
              const patch = noSpendCapPatch(e.target.checked)
              setWantsCap(!e.target.checked)
              if (patch) save(patch)
            }}
          />
          no spend cap
        </label>
      </div>
      {mode === 'noCap' && wantsCap ? (
        <div style={{ ...hintText, margin: `-${SCALE.space2} 0 ${SCALE.space3} 182px` }}>
          Still no cap: type a figure to turn it back on.
        </div>
      ) : null}
      {mode === 'blank' ? (
        <div
          role="alert"
          style={{
            fontSize: SCALE.textXs,
            color: TOKENS.warn,
            margin: `-${SCALE.space2} 0 ${SCALE.space3} 182px`
          }}
        >
          No spend cap is set, so scale-up rents nothing. Type a figure, or tick &ldquo;no spend
          cap&rdquo; to rent without one.
        </div>
      ) : null}
      <FieldNote error={error} />
    </>
  )
}

/**
 * The Blender version override: sent when the user is done (Enter or
 * leaving the field), never per keystroke, and only as a version. It goes
 * unquoted into a command on the node (#159); main refuses anything else
 * too.
 */
function BlenderVersionField({
  value,
  save
}: {
  value: string | null
  save: (patch: SettingsPatch) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const text = draft ?? value ?? ''
  const problem = draft == null ? null : blenderVersionProblem(draft)
  const commit = (): void => {
    if (draft == null) return
    if (!problem && (draft.trim() || null) !== value) save(blenderVersionPatch(draft))
    if (!problem) setDraft(null)
  }
  return (
    <>
      <input
        type="text"
        aria-label="Blender version override"
        aria-invalid={problem != null || undefined}
        title={problem ?? undefined}
        placeholder="auto (match .blend)"
        value={text}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape' && draft != null) {
            e.stopPropagation()
            setDraft(null)
          }
        }}
        style={{ ...input({ size: 'sm', invalid: problem != null }), ...mono, width: 160 }}
      />
      {problem ? (
        <span style={{ fontSize: SCALE.textXs, color: TOKENS.danger }}>{problem}</span>
      ) : null}
    </>
  )
}

function GeneralSection(): React.JSX.Element {
  const { data: settings } = useSettings()
  const { save, errorFor, failure } = useSettingsSave()
  if (!settings) return <div />
  return (
    <div>
      <div style={{ ...sectionLabel(), marginBottom: SCALE.space3 }}>General</div>
      <SaveFailure failure={failure} />
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
              if (dir) save({ projectRoot: dir })
            })
          }}
        >
          choose…
        </button>
      </div>
      <FieldNote error={errorFor('projectRoot')} />
      <div style={formRow}>
        <span style={label}>Max active nodes</span>
        <NumberField
          aria-label="Max active nodes"
          value={settings.maxActiveNodes}
          onCommit={(v) => v != null && save({ maxActiveNodes: v })}
          {...limitsOf('maxActiveNodes')}
          commitOnWindowBlur
        />
      </div>
      <FieldNote error={errorFor('maxActiveNodes')} />
      <SpendCapRow
        settings={settings}
        save={save}
        error={errorFor('spendCapPerHour') ?? errorFor('noSpendCap')}
      />
      <div style={formRow}>
        <span style={label}>Buy-ahead fleet</span>
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
            checked={settings.eagerFleet === true}
            onChange={(e) => save({ eagerFleet: e.target.checked })}
          />
          rent up to max nodes while any chunk is unfinished
        </label>
        <span style={hintText}>
          Off: rent only for work waiting. On: keep the fleet at max nodes until the queue is done,
          so a long drain is not left on too few machines. Either way the spend cap holds.
        </span>
      </div>
      <FieldNote error={errorFor('eagerFleet')} />
      <div style={formRow}>
        <span style={label}>Max render slots per node</span>
        <NumberField
          aria-label="Max render slots per node"
          value={settings.maxNodeSlots || null}
          onCommit={(v) => save({ maxNodeSlots: v ?? 0 })}
          {...limitsOf('maxNodeSlots')}
          allowBlank="auto"
        />
        <span style={hintText}>
          blank = auto: each node&apos;s concurrency is measured and tuned on the fly. Set a number
          to cap it. Only jobs marked &ldquo;share node&rdquo; ever run more than one at a time on a
          GPU.
        </span>
      </div>
      <FieldNote error={errorFor('maxNodeSlots')} />
      <div style={formRow}>
        <span style={label}>Render slots per GPU</span>
        <select
          value={String(settings.slotsPerGpu ?? 1)}
          onChange={(e) => save({ slotsPerGpu: Number(e.target.value) })}
          style={{ ...input({ size: 'sm' }), width: 180 }}
        >
          <option value="1">1 — one render per GPU</option>
          <option value="2">2 — two renders per GPU</option>
          <option value="0">off — one render, all GPUs</option>
        </select>
        <span style={hintText}>
          On a multi-GPU node, each GPU renders its own chunk (pinned with CUDA_VISIBLE_DEVICES), so
          per-frame CPU work such as scene sync overlaps other GPUs&apos; sampling instead of idling
          all of them. Two per GPU also overlaps it on the same GPU, at the cost of a second copy of
          the scene in VRAM and RAM.
        </span>
      </div>
      <FieldNote error={errorFor('slotsPerGpu')} />
      <div style={formRow}>
        <FieldLabel text="CO₂ overhead factor" hint={HINTS.co2Overhead} />
        <NumberField
          aria-label="CO2 overhead factor"
          value={settings.co2OverheadFactor}
          onCommit={(v) => v != null && save({ co2OverheadFactor: v })}
          {...limitsOf('co2OverheadFactor')}
          step={0.1}
        />
        <span style={hintText}>
          Scales measured GPU watts up to a whole-machine estimate for the CO₂ figures only — host
          CPU, PSU losses and datacentre cooling. 1 = count the GPU alone. Energy readouts are never
          scaled by this.
        </span>
      </div>
      <FieldNote error={errorFor('co2OverheadFactor')} />
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
            onChange={(e) => save({ thumbnails: e.target.checked })}
          />
          stream a small JPEG per frame as it renders
        </label>
        <span style={hintText}>
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
            save({
              livePreview: e.target.value as SettingsPublic['livePreview']
            })
          }
          style={{ ...input({ size: 'sm' }), width: 130 }}
        >
          <option value="off">off</option>
          <option value="onDemand">while watching</option>
          <option value="always">always</option>
        </select>
        <NumberField
          aria-label="Live preview width in pixels"
          value={settings.livePreviewWidth}
          onCommit={(v) => v != null && save({ livePreviewWidth: v })}
          {...limitsOf('livePreviewWidth')}
          step={64}
        />
        <span style={hintText}>
          A video assembled on the node one frame at a time, so you can watch a chunk render.
          &ldquo;While watching&rdquo; only encodes for a chunk whose preview is open — an always-on
          encoder competes with the render on a many-slot node.
        </span>
      </div>
      <FieldNote error={errorFor('livePreviewWidth')} />
      <div style={formRow}>
        <span style={label}>Idle timeout (minutes)</span>
        <NumberField
          aria-label="Idle timeout in minutes"
          value={settings.idleTimeoutMinutes}
          onCommit={(v) => v != null && save({ idleTimeoutMinutes: v })}
          {...limitsOf('idleTimeoutMinutes')}
        />
      </div>
      <FieldNote error={errorFor('idleTimeoutMinutes')} />
      <div style={formRow}>
        <span style={label}>Proxy codec</span>
        <select
          value={settings.proxyCodec}
          onChange={(e) => save({ proxyCodec: e.target.value as 'hevc' | 'av1' })}
          style={{ ...input({ size: 'sm' }), width: 120 }}
        >
          <option value="hevc">HEVC (H.265)</option>
          <option value="av1">AV1</option>
        </select>
      </div>
      <div style={formRow}>
        <span style={label}>Blender version override</span>
        <BlenderVersionField value={settings.blenderVersionOverride} save={save} />
      </div>
      <FieldNote error={errorFor('blenderVersionOverride')} />
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

/** One engine's docker image: saved when the field is left or Enter pressed, blank = built-in. */
function DockerImageField({
  engine,
  value,
  save,
  required
}: {
  engine: EngineId
  value: string | undefined
  save: (patch: SettingsPatch) => void
  /** Octane's: the built-in image has no OctaneBlender */
  required?: boolean
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const text = draft ?? value ?? ''
  const problem = draft == null ? null : dockerImageProblem(draft)
  const commit = (): void => {
    if (draft == null) return
    if (!problem && (draft.trim() || undefined) !== value) save(dockerImagePatch(engine, draft))
    if (!problem) setDraft(null)
  }
  return (
    <>
      <input
        type="text"
        aria-label={`Docker image for ${engine} nodes`}
        aria-invalid={problem != null || undefined}
        title={problem ?? undefined}
        placeholder={required ? 'required: an image with OctaneBlender' : 'built-in'}
        value={text}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape' && draft != null) {
            e.stopPropagation()
            setDraft(null)
          }
        }}
        style={{ ...input({ size: 'sm', invalid: problem != null }), ...mono, width: 320 }}
      />
      {problem ? (
        <span style={{ fontSize: SCALE.textXs, color: TOKENS.danger }}>{problem}</span>
      ) : null}
    </>
  )
}

const ENGINE_LABEL: Record<EngineId, string> = {
  octane: 'Octane',
  cycles: 'Cycles',
  eevee: 'EEVEE'
}

/**
 * How Octane nodes are rented and signed in (plan 1.18). Exported for its
 * test. By hand over VNC is the default: a credential used on a rented
 * machine is disclosed to its owner whatever route it takes, so scripting
 * the sign-in is an opt-in that says so.
 */
export function OctaneOptions({
  settings,
  save,
  errorFor
}: {
  settings: SettingsPublic
  save: (patch: SettingsPatch) => void
  errorFor: (field: string) => SettingsFieldError | undefined
}): React.JSX.Element {
  const o = settings.octane
  const images = settings.dockerImageByEngine ?? {}
  const box: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: SCALE.textSm,
    color: TOKENS.text,
    cursor: 'pointer'
  }
  return (
    <div>
      <div style={{ ...sectionLabel(), marginBottom: SCALE.space3 }}>Octane sign-in</div>
      <div style={formRow}>
        <label style={box}>
          <input
            type="checkbox"
            checked={o?.scriptedSignIn === true}
            onChange={(e) => save({ octane: { scriptedSignIn: e.target.checked } })}
          />
          sign in by script, with the saved OTOY account
        </label>
      </div>
      <div style={{ ...hintText, margin: `-${SCALE.space2} 0 ${SCALE.space3} 22px` }}>
        Off: each Octane node waits for you to sign in on its desktop (Fleet › the node › Open VNC
        login), and your OTOY password never leaves this computer. On: the saved account is sent to
        each Octane node&apos;s OctaneServer on its standard input. Root on that machine can still
        read it, so its owner has it: use this only with hosts you trust
        {o?.secureCloudOnly === true
          ? '. With datacenter hosts only on, it goes to no other host.'
          : ', or with datacenter hosts only below.'}
      </div>
      <FieldNote error={errorFor('octane.scriptedSignIn')} />
      <div style={formRow}>
        <label style={box}>
          <input
            type="checkbox"
            checked={o?.secureCloudOnly === true}
            onChange={(e) => save({ octane: { secureCloudOnly: e.target.checked } })}
          />
          Octane on datacenter (secure cloud) hosts only
        </label>
      </div>
      <div style={{ ...hintText, margin: `-${SCALE.space2} 0 ${SCALE.space3} 22px` }}>
        Rent Octane nodes only from Vast.ai&apos;s datacenter hosts, and ask for no sign-in, by hand
        or by script, on a node rented any other way. Fewer, dearer offers.
      </div>
      <FieldNote error={errorFor('octane.secureCloudOnly')} />

      <div style={{ ...sectionLabel(), margin: `${SCALE.space4} 0 ${SCALE.space3}` }}>
        Docker images
      </div>
      {(['octane', 'cycles', 'eevee'] as const).map((engine) => (
        <div key={engine}>
          <div style={formRow}>
            <span style={label}>{ENGINE_LABEL[engine]} nodes</span>
            <DockerImageField
              engine={engine}
              value={images[engine]}
              save={save}
              required={engine === 'octane'}
            />
          </div>
          {engine === 'octane' && !images.octane ? (
            <div
              style={{
                ...hintText,
                color: TOKENS.warn,
                margin: `-${SCALE.space2} 0 ${SCALE.space3} 182px`
              }}
            >
              No Octane image is set, so Octane jobs rent nothing: the built-in image has no
              OctaneBlender.
            </div>
          ) : null}
          <FieldNote error={errorFor(`dockerImageByEngine.${engine}`)} />
        </div>
      ))}
    </div>
  )
}

function OctaneSection(): React.JSX.Element {
  const { data: settings } = useSettings()
  const { save, errorFor, failure } = useSettingsSave()
  const qc = useQueryClient()
  const [user, setUser] = useState('')
  const [pass, setPass] = useState('')
  if (!settings) return <div />
  return (
    <div>
      <SaveFailure failure={failure} />
      <OctaneOptions settings={settings} save={save} errorFor={errorFor} />
      <div style={{ ...sectionLabel(), margin: `${SCALE.space4} 0 ${SCALE.space3}` }}>
        OTOY account
      </div>
      <div style={{ fontSize: SCALE.textXs, color: TOKENS.textFaint, marginBottom: SCALE.space3 }}>
        Used only when &quot;sign in by script&quot; is on. Stored encrypted on this computer, and
        sent to a node on OctaneServer&apos;s standard input, never in a command line, the
        environment or a file there: treat it as disclosed to the owner of every machine it is sent
        to.
      </div>
      <div style={formRow}>
        <span style={label}>OTOY account</span>
        <input
          placeholder={settings.hasOtoyCredentials ? '(saved)' : 'email'}
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
  const { save, errorFor, failure } = useSettingsSave()
  const [gpuInput, setGpuInput] = useState('')
  if (!settings) return <div />
  const f = settings.offerFilters
  // Only the filters that changed: main merges them one by one. Sending the
  // whole set back would save every filter as shown, and what is shown can
  // be a headless run's session-only filters (plan 1.14).
  const setFilters = (patch: Partial<OfferFilters>): void => {
    save({ offerFilters: patch })
  }
  const note = (filter: keyof OfferFilters): React.JSX.Element => (
    <FieldNote error={errorFor(`offerFilters.${filter}`)} />
  )
  return (
    <div>
      <div style={{ ...sectionLabel(), marginBottom: SCALE.space3 }}>Offer search filters</div>
      <SaveFailure failure={failure} />
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
      {note('gpuNames')}
      <div style={formRow}>
        <FieldLabel text="Max $/hr" hint={HINTS.maxDph} />
        <NumberField
          aria-label="Max dollars per hour per offer"
          value={f.maxDphTotal}
          onCommit={(v) => setFilters({ maxDphTotal: v })}
          {...limitsOf('maxDphTotal')}
          step={0.05}
          allowBlank="any"
          commitOnWindowBlur
          width={90}
        />
      </div>
      {note('maxDphTotal')}
      <div style={formRow}>
        <span style={label}>Min GPU RAM (GB)</span>
        <NumberField
          aria-label="Min GPU RAM in GB"
          value={f.minGpuRamGb}
          onCommit={(v) => v != null && setFilters({ minGpuRamGb: v })}
          {...limitsOf('minGpuRamGb')}
          width={90}
        />
      </div>
      {note('minGpuRamGb')}
      <div style={formRow}>
        <span style={label}>Min download (Mbps)</span>
        <NumberField
          aria-label="Min download in Mbps"
          value={f.minInetDownMbps}
          onCommit={(v) => v != null && setFilters({ minInetDownMbps: v })}
          {...limitsOf('minInetDownMbps')}
          step={50}
          width={90}
        />
      </div>
      {note('minInetDownMbps')}
      <div style={formRow}>
        <span style={label}>Min GPUs per node</span>
        <NumberField
          aria-label="Min GPUs per node"
          value={f.minNumGpus ?? null}
          onCommit={(v) => setFilters({ minNumGpus: v })}
          {...limitsOf('minNumGpus')}
          allowBlank="any"
          width={90}
        />
        <span style={hintText}>
          blank = any. Each GPU renders its own chunk, so a 4-GPU node is four render slots on one
          rental; ranking is per GPU either way.
        </span>
      </div>
      {note('minNumGpus')}
      <div style={formRow}>
        <span style={label}>Min CPU cores</span>
        <NumberField
          aria-label="Min CPU cores"
          value={f.minCpuCores ?? null}
          onCommit={(v) => setFilters({ minCpuCores: v })}
          {...limitsOf('minCpuCores')}
          allowBlank="any"
          width={90}
        />
      </div>
      {note('minCpuCores')}
      <div style={formRow}>
        <span style={label}>Min disk (GB)</span>
        <NumberField
          aria-label="Min disk in GB"
          value={f.minDiskGb}
          onCommit={(v) => v != null && setFilters({ minDiskGb: v })}
          {...limitsOf('minDiskGb')}
          width={90}
        />
      </div>
      {note('minDiskGb')}
      <div style={formRow}>
        <span style={label}>CPU-bound</span>
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
            checked={f.cpuBound === true}
            onChange={(e) => setFilters({ cpuBound: e.target.checked })}
          />
          rank unmeasured machines by CPU per dollar, not GPU benchmark
        </label>
      </div>
      {note('cpuBound')}
      <div style={formRow}>
        <span style={label}>Min reliability</span>
        <NumberField
          aria-label="Min reliability, 0 to 1"
          value={f.minReliability}
          onCommit={(v) => v != null && setFilters({ minReliability: v })}
          {...limitsOf('minReliability')}
          step={0.01}
          width={90}
        />
      </div>
      {note('minReliability')}
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
