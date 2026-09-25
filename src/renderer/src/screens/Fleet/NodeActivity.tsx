/**
 * The collapsed Fleet row's "activity" cell: what the node is working on, as
 * the job's latest frame and its name, so a glance down the list says which
 * render each machine is on without expanding it. The name goes to the job;
 * the rest of the row still expands the node. A node on several jobs names
 * the one holding most of its slots and counts the others; the per-slot
 * detail is in the expanded panel.
 *
 * A node's last error takes the cell over: it is the thing to read.
 */

import type { CSSProperties } from 'react'
import { Thumb } from '../../media/Thumb'
import { mono } from '../../lib/controls'
import { useNav } from '../../lib/nav'
import { SCALE, TOKENS } from '../../lib/theme'
import type { NodeSnapshot } from '../../../../shared/models'
import { ACTIVITY_MIN_W, activityLead } from './activity'

const cell: CSSProperties = {
  flex: 1,
  minWidth: ACTIVITY_MIN_W,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: SCALE.textXs,
  color: TOKENS.textFaint,
  whiteSpace: 'nowrap'
}

const link: CSSProperties = {
  // A link that is a button: no box, the accent colour.
  appearance: 'none',
  background: 'none',
  border: 'none',
  padding: 0,
  font: 'inherit',
  fontSize: SCALE.textSm,
  color: TOKENS.accent,
  cursor: 'pointer',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  textAlign: 'left'
}

export function NodeActivity({ node }: { node: NodeSnapshot }): React.JSX.Element {
  const navigate = useNav((s) => s.navigate)

  if (node.lastError) {
    return (
      <span style={{ ...cell, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {node.lastError}
      </span>
    )
  }

  const lead = activityLead(node.currentWork)
  if (!lead) return <span style={cell} />

  return (
    <span style={cell}>
      <span
        style={{ ...mono, flex: 'none', color: TOKENS.textMuted }}
        title={`${node.currentWork.length} of ${node.slotTarget} render slots in use`}
      >
        {node.currentWork.length}/{node.slotTarget}
      </span>
      <Thumb
        url={lead.thumbUrl}
        width={32}
        height={18}
        state="rendering"
        title={lead.thumbUrl ? `${lead.jobName}: latest frame` : 'no frame yet'}
      />
      <button
        type="button"
        style={link}
        title={`Open ${lead.jobName}`}
        // The row expands on click; the name opens the job instead.
        onClick={(e) => {
          e.stopPropagation()
          navigate({ screen: 'job', jobId: lead.jobId })
        }}
      >
        {lead.jobName}
      </button>
      {lead.otherJobs > 0 ? (
        <span style={{ flex: 'none' }}>
          +{lead.otherJobs} job{lead.otherJobs === 1 ? '' : 's'}
        </span>
      ) : null}
    </span>
  )
}
