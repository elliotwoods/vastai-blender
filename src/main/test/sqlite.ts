/**
 * An in-memory database the main-process modules can use in place of getDb().
 *
 * better-sqlite3's native binary is built against Electron's ABI and will not
 * load under plain node, so tests run on node's own SQLite (`node:sqlite`),
 * the swap history.test.ts made first. The two share the prepare/run/get/all
 * surface almost exactly; this adds the two better-sqlite3 methods the app
 * also calls, `transaction()` and `pragma()`, and applies the production
 * schema through db.ts's own `applySchema`, migrations included.
 *
 * Known gaps, none of which the app relies on: better-sqlite3 throws when
 * `.get()`/`.all()` is called on a statement that returns no rows' worth of
 * columns (an UPDATE); node:sqlite returns undefined/[] instead.
 */

import { DatabaseSync } from 'node:sqlite'
import type { Db } from '../db/db'

/** better-sqlite3's `db.transaction(fn)`: BEGIN/COMMIT, ROLLBACK on throw, savepoints when nested. */
function transactionOf(raw: DatabaseSync): Db['transaction'] {
  let depth = 0
  return (<A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R => {
      const savepoint = `vr_tx_${depth}`
      raw.exec(depth === 0 ? 'BEGIN' : `SAVEPOINT ${savepoint}`)
      depth++
      try {
        const result = fn(...args)
        depth--
        raw.exec(depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`)
        return result
      } catch (e) {
        depth--
        raw.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`)
        throw e
      }
    }) as unknown as Db['transaction']
}

/**
 * A fresh in-memory database with the production schema, typed as the app's
 * `Db` so it can be handed straight to the modules under test.
 *
 * `applySchema` is passed in rather than imported: this file is loaded before
 * the test's vi.mock('../db/db') is registered, and a static import would bind
 * the harness to a second, unmocked copy of db.ts.
 */
export function openTestDb(applySchema: (db: Db) => void): Db {
  const raw = new DatabaseSync(':memory:')
  const db = {
    prepare: (sql: string) => raw.prepare(sql),
    exec(sql: string) {
      raw.exec(sql)
      return db
    },
    pragma: (source: string) => raw.prepare(`PRAGMA ${source}`).all(),
    transaction: transactionOf(raw),
    close() {
      raw.close()
      return db
    },
    get open() {
      return raw.isOpen
    },
    get inTransaction() {
      return raw.isTransaction
    }
  } as unknown as Db
  // Production turns foreign keys on for every connection (getDb); a test DB
  // that did not would accept rows the app itself could never write.
  db.pragma('foreign_keys = ON')
  applySchema(db)
  return db
}
