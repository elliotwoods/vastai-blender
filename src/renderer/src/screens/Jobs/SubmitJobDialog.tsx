import { useState, type CSSProperties } from 'react'
import { btn, chip, input, mono, panel, sectionLabel, segmented } from '../../lib/controls'
import { basename } from '../../lib/format'
import { ipc } from '../../lib/ipc'
import { useAddons, useSettings, useSubmitJob } from '../../lib/queries'
import { useNav } from '../../lib/nav'
import { SCALE, TOKENS } from '../../lib/theme'
import type { EngineId } from '../../../../shared/models'

const overlay: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0, 0, 0, 0.55)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000
}

const row: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: SCALE.space3,
  marginBottom: SCALE.space3
}

const label: CSSProperties = { width: 110, fontSize: SCALE.textSm, color: TOKENS.textMuted }

const ENGINES: EngineId[] = ['eevee', 'cycles', 'octane']

export function SubmitJobDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { data: settings } = useSettings()
  const { data: addons } = useAddons()
  const submit = useSubmitJob()
  const { navigate } = useNav()

  const [files, setFiles] = useState<string[]>([])
  const [engine, setEngine] = useState<EngineId>('cycles')
  const [frameStart, setFrameStart] = useState(1)
  const [frameEnd, setFrameEnd] = useState(250)
  const [frameStep, setFrameStep] = useState(1)
  const [chunkSize, setChunkSize] = useState<number | ''>('')
  const [shareNode, setShareNode] = useState(false)
  const [selectedAddons, setSelectedAddons] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)

  const octaneWarning = engine === 'octane' && settings && !settings.hasOtoyCredentials

  const doSubmit = async (): Promise<void> => {
    setError(null)
    try {
      for (const blendPath of files) {
        await submit.mutateAsync({
          blendPath,
          engine,
          frameStart,
          frameEnd,
          frameStep,
          addonIds: [...selectedAddons],
          chunkSize: chunkSize === '' ? null : chunkSize,
          shareNode
        })
      }
      onClose()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div
        style={{ ...panel({ elevated: true }), padding: SCALE.space5, width: 520 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ ...sectionLabel(), marginBottom: SCALE.space4 }}>New render</div>

        <div style={row}>
          <span style={label}>Scenes</span>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', flex: 1 }}>
            {files.map((f) => (
              <span key={f} style={chip({ tone: 'accent' })} title={f}>
                {basename(f)}
                <button
                  style={{ cursor: 'pointer', color: TOKENS.textMuted, marginLeft: 4 }}
                  onClick={() => setFiles(files.filter((x) => x !== f))}
                >
                  ×
                </button>
              </span>
            ))}
            <button
              style={btn({ size: 'sm' })}
              onClick={() => {
                void ipc.invoke('dialog:pickBlendFiles').then((picked) => {
                  if (picked.length) setFiles([...new Set([...files, ...picked])])
                })
              }}
            >
              + choose…
            </button>
          </div>
        </div>

        <div style={row}>
          <span style={label}>Engine</span>
          <span>
            {ENGINES.map((e, i) => (
              <button
                key={e}
                style={segmented({
                  active: engine === e,
                  position: i === 0 ? 'first' : i === ENGINES.length - 1 ? 'last' : 'middle'
                })}
                onClick={() => setEngine(e)}
              >
                {e.toUpperCase()}
              </button>
            ))}
          </span>
        </div>
        {octaneWarning ? (
          <div style={{ ...row, marginTop: -6 }}>
            <span style={label} />
            <button
              style={{ ...chip({ tone: 'warn' }), cursor: 'pointer' }}
              onClick={() => navigate({ screen: 'settings', section: 'octane' })}
            >
              No Octane license configured — click to set up
            </button>
          </div>
        ) : null}

        <div style={row}>
          <span style={label}>Frames</span>
          <input
            type="number"
            value={frameStart}
            onChange={(e) => setFrameStart(Number(e.target.value))}
            style={{ ...input({ size: 'sm' }), ...mono, width: 80 }}
          />
          <span style={{ color: TOKENS.textFaint }}>–</span>
          <input
            type="number"
            value={frameEnd}
            onChange={(e) => setFrameEnd(Number(e.target.value))}
            style={{ ...input({ size: 'sm' }), ...mono, width: 80 }}
          />
          <span style={{ fontSize: SCALE.textXs, color: TOKENS.textFaint }}>step</span>
          <input
            type="number"
            min={1}
            value={frameStep}
            onChange={(e) => setFrameStep(Math.max(1, Number(e.target.value)))}
            style={{ ...input({ size: 'sm' }), ...mono, width: 56 }}
          />
        </div>

        <div style={row}>
          <span style={label}>Chunk size</span>
          <input
            type="number"
            min={1}
            placeholder="auto"
            value={chunkSize}
            onChange={(e) => setChunkSize(e.target.value === '' ? '' : Number(e.target.value))}
            style={{ ...input({ size: 'sm' }), ...mono, width: 80 }}
          />
          <span style={{ fontSize: SCALE.textXs, color: TOKENS.textFaint }}>
            frames per node chunk (auto recommended)
          </span>
        </div>

        <div style={{ ...row, alignItems: 'flex-start' }}>
          <span style={label}>Share node</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <label
              style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: SCALE.textSm }}
            >
              <input
                type="checkbox"
                checked={shareNode}
                onChange={(e) => setShareNode(e.target.checked)}
              />
              run alongside other renders
            </label>
            <span style={{ fontSize: SCALE.textXs, color: TOKENS.textFaint }}>
              For scenes that leave the node under-used — a long CPU step before each frame, say.
              Off means one chunk per node. How many actually share is judged per node.
            </span>
          </div>
        </div>

        {(addons ?? []).length > 0 ? (
          <div style={{ ...row, alignItems: 'flex-start' }}>
            <span style={label}>Extensions</span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {(addons ?? []).map((a) => (
                <label
                  key={a.id}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: SCALE.textSm }}
                >
                  <input
                    type="checkbox"
                    checked={selectedAddons.has(a.id)}
                    onChange={(e) => {
                      const next = new Set(selectedAddons)
                      if (e.target.checked) next.add(a.id)
                      else next.delete(a.id)
                      setSelectedAddons(next)
                    }}
                  />
                  {a.name}{' '}
                  <span style={{ ...mono, fontSize: SCALE.text2xs, color: TOKENS.textFaint }}>
                    {a.version}
                  </span>
                </label>
              ))}
            </div>
          </div>
        ) : null}

        {error ? (
          <div style={{ color: TOKENS.danger, fontSize: SCALE.textSm, marginBottom: SCALE.space3 }}>
            {error}
          </div>
        ) : null}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: SCALE.space2 }}>
          <button style={btn({ variant: 'ghost' })} onClick={onClose}>
            cancel
          </button>
          <button
            style={btn({
              variant: 'primary',
              disabled: files.length === 0 || submit.isPending || frameEnd < frameStart
            })}
            disabled={files.length === 0 || submit.isPending || frameEnd < frameStart}
            onClick={() => void doSubmit()}
          >
            {submit.isPending
              ? 'submitting…'
              : `render ${files.length || ''} scene${files.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  )
}
