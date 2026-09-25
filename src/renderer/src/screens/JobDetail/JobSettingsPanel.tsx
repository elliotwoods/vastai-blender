/**
 * How the job was set up, and the one thing about it that can still change:
 * whether its chunks share nodes. That is a labelled switch with both of its
 * meanings spelled out (the current one bright) and when a change takes
 * effect, where it used to be a bare "share node" checkbox in the toolbar.
 * Under it, the job's engine, frames, chunk size, Blender version, add-ons,
 * scene and output folder, and its place in the render queue or its group,
 * which it can leave.
 */

import type { CSSProperties, ReactNode } from 'react'
import { Icon } from '../../components/Icon'
import { OpenInExplorerButton } from '../../components/OpenInExplorerButton'
import { btn, mono, panel } from '../../lib/controls'
import { basename } from '../../lib/format'
import { SCALE, TOKENS } from '../../lib/theme'
import type { AddonInfo, JobDetail, JobSummary, QueueEntry } from '../../../../shared/models'
import { chunkSizeOf, isLiveJobState, SHARE_COPY } from './jobDetailModel'

/** A labelled on/off switch: a real button with role="switch". */
export function ShareSwitch({
  checked,
  disabled,
  onChange
}: {
  checked: boolean
  disabled?: boolean
  onChange: (next: boolean) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={SHARE_COPY.label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={{
        position: 'relative',
        width: 32,
        height: 18,
        flexShrink: 0,
        borderRadius: 9,
        border: `1px solid ${checked ? TOKENS.accent : TOKENS.borderStrong}`,
        background: checked ? TOKENS.accent : TOKENS.surfaceOverlay,
        cursor: disabled ? 'wait' : 'pointer',
        padding: 0,
        transition: 'background 120ms, border-color 120ms'
      }}
    >
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          top: 2,
          left: checked ? 16 : 2,
          width: 12,
          height: 12,
          borderRadius: '50%',
          background: checked ? TOKENS.accentFg : TOKENS.textMuted,
          transition: 'left 120ms'
        }}
      />
    </button>
  )
}

const key: CSSProperties = {
  fontSize: SCALE.textXs,
  color: TOKENS.textFaint,
  whiteSpace: 'nowrap'
}
const val: CSSProperties = {
  fontSize: SCALE.textSm,
  color: TOKENS.textSecondary,
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  gap: SCALE.space2
}
const clip: CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

function Row({ k, children }: { k: string; children: ReactNode }): React.JSX.Element {
  return (
    <>
      <span style={key}>{k}</span>
      <span style={val}>{children}</span>
    </>
  )
}

export function JobSettingsPanel({
  job,
  onShareChange,
  sharePending = false,
  queue,
  jobs,
  addons,
  onUngroup,
  ungroupPending = false
}: {
  job: JobDetail
  onShareChange: (shareNode: boolean) => void
  sharePending?: boolean
  /** the render queue (useQueue), for the job's place in it */
  queue?: readonly QueueEntry[]
  /** every job (useJobs), to name a group's other members */
  jobs?: readonly JobSummary[]
  addons?: readonly AddonInfo[]
  onUngroup: () => void
  ungroupPending?: boolean
}): React.JSX.Element {
  const live = isLiveJobState(job.state)
  const entry = queue?.find((e) => e.jobIds.includes(job.id))
  const position = entry?.position ?? job.queuePos
  const others = job.groupId
    ? (jobs ?? []).filter((j) => j.groupId === job.groupId && j.id !== job.id)
    : []
  const chunkSize = chunkSizeOf(job.chunks, job.frameStep)
  const addonNames = job.addonIds.map((id) => addons?.find((a) => a.id === id)?.name ?? id)
  const frames = Math.floor((job.frameEnd - job.frameStart) / Math.max(1, job.frameStep)) + 1

  return (
    <div
      style={{
        ...panel(),
        padding: SCALE.space3,
        display: 'grid',
        // the switch and its wording beside the details when there is room
        gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))',
        gap: `${SCALE.space4} ${SCALE.space6}`,
        alignItems: 'start'
      }}
    >
      <div style={{ display: 'flex', gap: SCALE.space3, alignItems: 'flex-start' }}>
        <div style={{ paddingTop: 1 }}>
          <ShareSwitch checked={job.shareNode} disabled={sharePending} onChange={onShareChange} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
          <span style={{ fontSize: SCALE.textSm, color: TOKENS.text }}>
            {SHARE_COPY.label}{' '}
            <span
              style={{
                ...mono,
                fontSize: SCALE.textXs,
                color: job.shareNode ? TOKENS.accent : TOKENS.textMuted
              }}
            >
              {job.shareNode ? 'on' : 'off'}
            </span>
          </span>
          <span
            data-share-mode="off"
            style={{
              fontSize: SCALE.textXs,
              lineHeight: SCALE.leadingNormal,
              color: job.shareNode ? TOKENS.textFaint : TOKENS.textSecondary
            }}
          >
            {SHARE_COPY.off}
          </span>
          <span
            data-share-mode="on"
            style={{
              fontSize: SCALE.textXs,
              lineHeight: SCALE.leadingNormal,
              color: job.shareNode ? TOKENS.textSecondary : TOKENS.textFaint
            }}
          >
            {SHARE_COPY.on}
          </span>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              fontSize: SCALE.textXs,
              color: TOKENS.textMuted
            }}
          >
            <Icon name="info" size={12} />
            {SHARE_COPY.applies}
          </span>
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'max-content minmax(0, 1fr)',
          columnGap: SCALE.space4,
          rowGap: 6,
          alignItems: 'center'
        }}
      >
        <Row k="engine">
          <span style={mono}>{job.engine}</span>
        </Row>
        <Row k="frames">
          <span style={mono}>
            {job.frameStart}–{job.frameEnd}
            {job.frameStep > 1 ? ` step ${job.frameStep}` : ''}
          </span>
          <span style={{ color: TOKENS.textFaint }}>
            {frames} {frames === 1 ? 'frame' : 'frames'}
          </span>
        </Row>
        <Row k="chunk size">
          {chunkSize != null ? (
            <span style={mono}>
              {chunkSize} {chunkSize === 1 ? 'frame' : 'frames'}
            </span>
          ) : (
            <span style={{ color: TOKENS.textFaint }}>not cut yet</span>
          )}
          <span style={{ color: TOKENS.textFaint }}>
            {job.chunks.length} {job.chunks.length === 1 ? 'chunk' : 'chunks'}
          </span>
        </Row>
        <Row k="Blender">
          <span style={mono}>{job.blenderVersion ?? 'not read from the scene'}</span>
        </Row>
        <Row k="add-ons">
          {addonNames.length > 0 ? (
            <span style={clip} title={addonNames.join(', ')}>
              {addonNames.join(', ')}
            </span>
          ) : (
            <span style={{ color: TOKENS.textFaint }}>none</span>
          )}
        </Row>
        <Row k="scene">
          <span style={{ ...mono, ...clip }} title={job.blendPath}>
            {basename(job.blendPath)}
          </span>
          <OpenInExplorerButton path={job.blendPath} />
        </Row>
        <Row k="output">
          <span style={{ ...mono, ...clip }} title={job.outputDir}>
            {job.outputDir}
          </span>
          <OpenInExplorerButton path={job.outputDir} mode="open" />
        </Row>
        <Row k="queue">
          {!live ? (
            <span style={{ color: TOKENS.textFaint }}>finished, out of the queue</span>
          ) : (
            <>
              <span>
                {position != null ? (
                  <>
                    <span style={mono}>#{position}</span> in the render queue
                  </>
                ) : (
                  'in the render queue'
                )}
              </span>
              {others.length > 0 ? (
                <>
                  <span
                    style={{ color: TOKENS.textFaint, ...clip }}
                    title={others.map((j) => j.name).join(', ')}
                  >
                    grouped with {others.map((j) => j.name || basename(j.blendPath)).join(', ')}
                  </span>
                  <button
                    type="button"
                    title="Take this job out of its group: it keeps its place but no longer renders in step with the others."
                    disabled={ungroupPending}
                    onClick={onUngroup}
                    style={btn({ variant: 'ghost', size: 'sm', disabled: ungroupPending })}
                  >
                    <Icon name="unlink" size={12} />
                    ungroup
                  </button>
                </>
              ) : null}
            </>
          )}
        </Row>
      </div>
    </div>
  )
}
