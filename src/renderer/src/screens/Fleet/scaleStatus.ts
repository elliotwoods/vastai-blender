/**
 * Why scale-up is or is not renting, as the Fleet says it (#200): the
 * scheduler's last decision (scheduler:scaleStatus), in one line. Queued
 * work with no node coming looked like "working, please wait" whether the
 * fleet was at max nodes, at the spend cap, or had nodes enough already.
 */

import type { ScaleStatusInfo } from '../../../../shared/models'

export interface ScaleLine {
  /** 'warn' where the user's own limit is what stops it */
  tone: 'warn' | 'muted'
  text: string
  /** offer the Settings section that holds the spend cap */
  spendCap: boolean
}

/**
 * The line for a scale status, or null when there is nothing to add: a
 * hold says it itself, in HoldsBanner, with the button that lifts it.
 */
export function scaleLine(s: ScaleStatusInfo | null | undefined): ScaleLine | null {
  if (!s || s.status === 'held') return null
  switch (s.status) {
    case 'max-nodes':
      return {
        tone: 'warn',
        text: `Not renting: ${s.reason}. Raise max nodes to rent more.`,
        spendCap: false
      }
    case 'spend-cap':
      return { tone: 'warn', text: `Not renting: ${s.reason}.`, spendCap: true }
    case 'rent':
      return { tone: 'muted', text: `Renting: ${s.reason}.`, spendCap: false }
    default:
      // 'covered' and 'tail': work there is, and the nodes up take it.
      return { tone: 'muted', text: `Not renting: ${s.reason}.`, spendCap: false }
  }
}
