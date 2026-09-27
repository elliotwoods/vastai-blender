/**
 * The Jobs row's columns for fitColumns: what each costs the row (its width
 * and gap) and the order a narrow list sheds them in.
 */

import type { FitColumn } from '../../lib/layout'

export const THUMB_W = 64
export const THUMB_H = 36
/** a smaller thumbnail once state and frames stack under the name */
export const COMPACT_THUMB_W = 48
export const COMPACT_THUMB_H = 27
/** the grip's column, kept on finished rows too so the thumbnails line up */
export const GRIP_W = 18
export const ICON_W = 26

export type JobCol = 'fixed' | 'name' | 'meta' | 'time' | 'cost' | 'ago'

/** the time and cost columns' widths: room for "so far / in all" */
export const TIME_W = 132
export const COST_W = 124

/**
 * `fixed` is the grip, the compact thumbnail, the actions and the padding;
 * `name` the least the middle column needs to show a name beside its chips;
 * `meta` the state and frames pair, plus what the full-size thumbnail adds,
 * since the two go together.
 */
export const JOB_COLS: readonly FitColumn<JobCol>[] = [
  { key: 'fixed', width: GRIP_W + COMPACT_THUMB_W + 3 * ICON_W + 8 + 3 * 12 + 18 },
  { key: 'name', width: 240 },
  { key: 'meta', width: 96 + 96 + 2 * 12 + (THUMB_W - COMPACT_THUMB_W), drop: 4 },
  { key: 'time', width: TIME_W + 12, drop: 2 },
  { key: 'cost', width: COST_W + 12, drop: 3 },
  { key: 'ago', width: 72 + 12, drop: 1 }
]
export const ALL_JOB_COLS: ReadonlySet<JobCol> = new Set(JOB_COLS.map((c) => c.key))
