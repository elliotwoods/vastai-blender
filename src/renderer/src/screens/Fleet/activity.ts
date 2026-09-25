/** Which job a collapsed Fleet row names (NodeActivity), worked out without a DOM. */

import type { NodeWorkRef } from '../../../../shared/models'

/**
 * The activity column's least width: slots, thumbnail and the start of a job
 * name. A narrow window squeezes the fixed columns before it hides the name.
 */
export const ACTIVITY_MIN_W = 160

export interface ActivityLead {
  jobId: string
  jobName: string
  thumbUrl: string | null
  /** other jobs the node is also working on */
  otherJobs: number
}

/**
 * The job a row names: the one with most of the node's slots (the first to
 * appear on a tie), its name (or id, before main has one), and the newest
 * preview any of its slots carries. null when the node is working on nothing.
 */
export function activityLead(work: readonly NodeWorkRef[]): ActivityLead | null {
  if (work.length === 0) return null
  const byJob = new Map<string, NodeWorkRef[]>()
  for (const w of work) {
    const list = byJob.get(w.jobId)
    if (list) list.push(w)
    else byJob.set(w.jobId, [w])
  }
  let lead: NodeWorkRef[] = []
  for (const refs of byJob.values()) if (refs.length > lead.length) lead = refs
  const first = lead[0]
  return {
    jobId: first.jobId,
    jobName: lead.find((w) => w.jobName)?.jobName ?? first.jobId,
    thumbUrl: lead.find((w) => w.thumbUrl)?.thumbUrl ?? null,
    otherJobs: byJob.size - 1
  }
}
