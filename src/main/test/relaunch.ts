/**
 * Relaunching the app on the database the last launch left, for restart
 * scenarios that need a second process (a hold that must outlive a quit, say).
 *
 * A World's engine is a set of module singletons loaded once (boot()), and
 * setup() gives each world a fresh, empty database. A relaunch is both at
 * once: fresh modules, the rows the last process wrote. So:
 *
 *   const now = Date.now()                 // the fake clock, before dispose() puts the real one back
 *   const image = imageOf(w)               // every row, while the first world's database is open
 *   await w.dispose()                      // the first launch quits
 *   w = await setup({ settings, now })     // a new process
 *   restoreImage(w, image)                 // ...on the same database
 *   const app = await w.boot()             // init() and start() read what the last one left
 *
 * Only the database carries over. Fake Vast, its instances and the fake
 * machines are new and empty, and settings are what the new setup() gives:
 * a test that needs a fleet to outlive the restart builds it again.
 */

import type { World } from './harness'

/** One table's rows, as node:sqlite returns them. */
export interface TableImage {
  table: string
  rows: Array<Record<string, unknown>>
}

/**
 * The schema's own bookkeeping: applySchema writes these for the new world's
 * database, the same as the old one's, and schema_meta has no key to replace on.
 */
const SCHEMA_OWNED = new Set(['schema_meta'])

/** Every row of every table in the world's database. */
export function imageOf(w: World): TableImage[] {
  const tables = w.all<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
  )
  return tables
    .filter((t) => !SCHEMA_OWNED.has(t.name))
    .map((t) => ({ table: t.name, rows: w.all(`SELECT * FROM "${t.name}"`) }))
}

/**
 * Replace the rows of a freshly set-up world's database with an image's.
 * Call it before boot(), as the rows are what a launch starts from.
 */
export function restoreImage(w: World, image: TableImage[]): void {
  // Tables are written in name order, not in the order their references run.
  w.db.pragma('foreign_keys = OFF')
  try {
    for (const { table, rows } of image) {
      w.db.prepare(`DELETE FROM "${table}"`).run()
      for (const row of rows) {
        const cols = Object.keys(row)
        w.db
          .prepare(
            `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')})
             VALUES (${cols.map(() => '?').join(', ')})`
          )
          .run(...cols.map((c) => row[c]))
      }
    }
  } finally {
    w.db.pragma('foreign_keys = ON')
  }
}
