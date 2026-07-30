/**
 * better-sqlite3 open + migrate. Synchronous API is fine in main — every
 * statement here is trivial. WAL mode for crash-safety.
 */

import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import schemaSql from './schema.sql?raw'

export type Db = Database.Database

let db: Db | null = null

export function getDb(): Db {
  if (db) return db
  const file = join(app.getPath('userData'), 'vastai-blender.db')
  db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(schemaSql)
  const row = db.prepare('SELECT version FROM schema_meta').get() as { version: number } | undefined
  if (!row) {
    db.prepare('INSERT INTO schema_meta (version) VALUES (?)').run(SCHEMA_VERSION)
  }
  migrate(db)
  backfillUsageLog(db)
  return db
}

const SCHEMA_VERSION = 4

/**
 * Column additions, which `CREATE TABLE IF NOT EXISTS` in schema.sql cannot
 * apply to an existing database. Each step is guarded by the column's actual
 * presence rather than the recorded version, so a DB that predates the version
 * bookkeeping (or one already patched by hand) converges either way.
 */
function migrate(db: Db): void {
  if (!hasColumn(db, 'jobs', 'share_node')) {
    // v2: per-job node sharing. Existing jobs default to 0 = exclusive, which
    // is exactly how they behaved before the column existed.
    db.exec('ALTER TABLE jobs ADD COLUMN share_node INTEGER NOT NULL DEFAULT 0')
  }
  if (!hasColumn(db, 'chunks', 'assigned_at')) {
    // v3: dispatch time, for the node panel's elapsed/ETA readouts. No
    // backfill is possible — existing rows read as "—" rather than lying.
    db.exec('ALTER TABLE chunks ADD COLUMN assigned_at INTEGER')
  }
  if (!hasColumn(db, 'frames', 'thumb_path')) {
    // v3: per-frame preview image, streamed off the node as frames land.
    db.exec('ALTER TABLE frames ADD COLUMN thumb_path TEXT')
  }
  if (!hasColumn(db, 'nodes', 'geolocation')) {
    // v4: where the machine is, for grid carbon intensity. No backfill is
    // possible — vast.ai does not report an instance's location after the fact
    // and nothing here recorded the offer. Existing rows stay null and their
    // energy is costed at the world-average intensity.
    db.exec('ALTER TABLE nodes ADD COLUMN geolocation TEXT')
  }
  db.prepare('UPDATE schema_meta SET version = ?').run(SCHEMA_VERSION)
}

function hasColumn(db: Db, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return cols.some((c) => c.name === column)
}

/**
 * Seed usage_log from cost_log so the History screen isn't blank on the first
 * launch after upgrading — cost_log has recorded per-node spend every minute
 * since this app's first run and is never pruned.
 *
 * Imported rows carry no job attribution and no energy (neither was recorded
 * back then); they land in the "unattributed" bucket, which is honest. Guarded
 * by a history_meta marker so it runs exactly once.
 */
function backfillUsageLog(db: Db): void {
  const done = db.prepare("SELECT value FROM history_meta WHERE key = 'backfill_v1'").get()
  if (done) return
  db.transaction(() => {
    db.prepare(
      `INSERT INTO usage_log (ts, node_id, job_id, chunk_id, delta_cost, delta_wh, power_w, gpu_util)
       SELECT ts, node_id, NULL, NULL, delta_cost, 0, NULL, NULL FROM cost_log`
    ).run()
    db.prepare("INSERT INTO history_meta (key, value) VALUES ('backfill_v1', ?)").run(
      String(Date.now())
    )
  })()
}

export function closeDb(): void {
  db?.close()
  db = null
}
