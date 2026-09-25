/**
 * better-sqlite3 open + migrate. Synchronous API is fine in main — every
 * statement here is trivial. WAL mode for crash-safety.
 */

import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { MAX_INFRA_RETRIES, MAX_RETRIES } from '../scheduler/admission'
import schemaSql from './schema.sql?raw'

export type Db = Database.Database

let db: Db | null = null

export function getDb(): Db {
  if (db) return db
  const file = join(app.getPath('userData'), 'vastai-blender.db')
  db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  applySchema(db)
  return db
}

/**
 * Bring an open database up to the current schema: create what is missing,
 * run the column migrations and the one-shot data migrations (each behind a
 * history_meta marker). Idempotent.
 *
 * Separate from getDb (which owns the file, WAL and foreign keys) so the test
 * harness builds its in-memory database through this same path, migrations
 * and backfills included, rather than from schema.sql alone — which a
 * migration that forgot to update it would silently diverge from.
 */
export function applySchema(db: Db): void {
  db.exec(schemaSql)
  const row = db.prepare('SELECT version FROM schema_meta').get() as { version: number } | undefined
  if (!row) {
    db.prepare('INSERT INTO schema_meta (version) VALUES (?)').run(SCHEMA_VERSION)
  }
  migrate(db)
  backfillUsageLog(db)
  resetGpuLearning(db)
  markCancelledChunks(db)
}

const SCHEMA_VERSION = 7

/**
 * Column additions, which `CREATE TABLE IF NOT EXISTS` in schema.sql cannot
 * apply to an existing database. Each step is guarded by the column's actual
 * presence rather than the recorded version, so a DB that predates the version
 * bookkeeping (or one already patched by hand) converges either way.
 *
 * A new column goes at the end of its table in schema.sql too, in the order
 * added here; db.test.ts checks that the original schema, migrated, matches a
 * fresh database column for column.
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
  if (!hasColumn(db, 'assets', 'segments')) {
    // v5: stitched job clips (chunk_id NULL) record which job frames they
    // hold, as a JSON array of {start,end}. Chunk clips leave it null.
    db.exec('ALTER TABLE assets ADD COLUMN segments TEXT')
  }

  // v6: what Phase 1 of the 2026-09 audit plan stores. schema.sql says what
  // each column means; the notes here are about existing rows.

  // Plan 1.2. Rows already 'destroyed' are stamped, or the billing predicate
  // (an instance_id and no destroyed_at) would count every node this profile
  // ever destroyed as billing still. When each went was never recorded: the
  // stamp is its last metered minute, else started_at, else now. 'failed'
  // rows stay null: that state already says "may still be billing", and only
  // Vast can say otherwise.
  addColumn(db, 'nodes', 'destroyed_at', 'INTEGER', () => {
    db.prepare(
      `UPDATE nodes SET destroyed_at = metered.last
       FROM (SELECT node_id, MAX(ts) AS last FROM cost_log GROUP BY node_id) AS metered
       WHERE nodes.id = metered.node_id AND nodes.state = 'destroyed'`
    ).run()
    db.prepare(
      "UPDATE nodes SET destroyed_at = COALESCE(started_at, ?) WHERE state = 'destroyed' AND destroyed_at IS NULL"
    ).run(Date.now())
  })
  // Plans 1.3, 1.4. Every build so far has labelled an instance
  // `vastai-blender <first 8 of the node id>`, so existing rows are exact.
  addColumn(db, 'nodes', 'label', 'TEXT', () => {
    db.prepare("UPDATE nodes SET label = 'vastai-blender ' || substr(id, 1, 8)").run()
  })
  // Plan 1.18. Every existing row starts at 'none', octane_ready = 1 or not:
  // the check that set it (#85) tested for success before failure, so
  // 'Failed to acquire license' set it too, and a node carried across the
  // upgrade as 'licensed' would never have its license checked again. 1.18
  // reads the state off the node instead: setupOctane skips a server that is
  // already up, and the corrected check says licensed or needsLogin.
  addColumn(db, 'nodes', 'octane_state', "TEXT NOT NULL DEFAULT 'none'")
  // Plan 1.17. Existing chunks may be dispatched at once, as now, and start
  // with no infrastructure retries: what they already lost to machines is in
  // `retries` and cannot be told apart after the fact.
  addColumn(db, 'chunks', 'not_before', 'INTEGER')
  addColumn(db, 'chunks', 'infra_retries', 'INTEGER NOT NULL DEFAULT 0')
  addColumn(db, 'chunks', 'error_kind', 'TEXT')
  // Plan 1.12. No existing job has a snapshot; they keep rendering blend_path.
  addColumn(db, 'jobs', 'blend_sha256', 'TEXT')
  addColumn(db, 'jobs', 'scene_path', 'TEXT')
  // Plan 1.17's job breaker.
  addColumn(db, 'jobs', 'attention', 'TEXT')
  // Plan 1.11 (#226, #238). The rows themselves are wiped by resetGpuLearning.
  addColumn(db, 'gpu_perf', 'num_gpus', 'INTEGER')
  addColumn(db, 'gpu_slots', 'num_gpus', 'INTEGER')
  // Plans 1.2, 1.4 (Phase 0 review). A row with no instance id whose create
  // may have gone through, which the billing predicate must count: the caps
  // and the meter would skip that instance otherwise. Existing rows say so
  // in two ways:
  //  - 'requested' or 'destroying': the create was in flight when the app
  //    stopped (the row is written before PUT /asks);
  //  - 'failed' by a create that threw after Vast may have acted, in
  //    vastClient's words: a lost or cut reply (network error), a 5xx, a
  //    reply that was not JSON; and every cancelledCreateUnknown row.
  // A create Vast refused (a 4xx, a 200 without a contract) or that was
  // never sent (no API key) made nothing, and stays null. So do 'destroyed'
  // rows: setState cleared their message, and 1.3's reconcile shows a
  // labelled instance that no row holds as unclaimed. When the create was
  // sent was never recorded, so the stamp is now: later than the truth,
  // which only makes 1.4's lookup wait longer before it calls the instance
  // absent.
  addColumn(db, 'nodes', 'create_unknown_since', 'INTEGER', () => {
    db.prepare(
      `UPDATE nodes SET create_unknown_since = ?
       WHERE instance_id IS NULL
         AND (state IN ('requested', 'destroying')
           OR (state = 'failed'
             AND (last_error LIKE 'cancelled while creating; the create''s outcome is unknown%'
               OR last_error LIKE 'network error:%'
               OR last_error LIKE 'vast.ai PUT /asks/%/ → 5__: %'
               OR last_error LIKE 'vast.ai PUT /asks/%/: non-JSON response%')))`
    ).run(Date.now())
  })

  db.prepare('UPDATE schema_meta SET version = ?').run(SCHEMA_VERSION)
}

/**
 * One migration step: add `column` unless it is there, then run `backfill`,
 * in one transaction. `backfill` is also where an index on the column goes,
 * which cannot live in schema.sql (see there). The step is guarded by the
 * column alone, so a backfill that threw after its ALTER had committed would
 * never run again; in one transaction, a failure takes the column with it
 * and the whole step runs again at the next launch.
 */
function addColumn(
  db: Db,
  table: string,
  column: string,
  definition: string,
  backfill?: () => void
): void {
  if (hasColumn(db, table, column)) return
  db.transaction(() => {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    backfill?.()
  })()
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

/**
 * Throw away what gpu_perf and gpu_slots learned before they were per GPU
 * (#226, #238). 93cbad4 switched both from per-node to per-GPU figures and
 * converted nothing, so a total a 4-GPU node recorded is now read as one
 * GPU's and multiplied by four again: offers of that model score 4x too
 * high, and gpu_slots, which only ever keeps its best, seeds every node of
 * the model at its hardware ceiling for good. Which rows hold node totals
 * cannot be told — nothing recorded the GPU count behind a row, and
 * updated_at moves with every sample — so both tables start again, once,
 * behind a history_meta marker. Each re-learns from its next few chunks.
 */
function resetGpuLearning(db: Db): void {
  const done = db.prepare("SELECT value FROM history_meta WHERE key = 'gpu_units_v1'").get()
  if (done) return
  db.transaction(() => {
    db.prepare('DELETE FROM gpu_perf').run()
    db.prepare('DELETE FROM gpu_slots').run()
    db.prepare("INSERT INTO history_meta (key, value) VALUES ('gpu_units_v1', ?)").run(
      String(Date.now())
    )
  })()
}

/**
 * Give cancelled jobs' chunks the 'cancelled' state (v7). Until then a cancel
 * marked every open chunk 'failed', so a job's screen could not tell the
 * chunks the user stopped from those that failed for good. A failed chunk of
 * a cancelled job whose retries are spent (either budget) failed before the
 * cancel, and keeps its verdict; the rest were open when it came. Guarded by
 * a history_meta marker so it runs exactly once: after it, 'failed' is only
 * ever written for a real failure.
 */
function markCancelledChunks(db: Db): void {
  const done = db.prepare("SELECT value FROM history_meta WHERE key = 'cancelled_chunks_v1'").get()
  if (done) return
  db.transaction(() => {
    db.prepare(
      `UPDATE chunks SET state = 'cancelled'
        WHERE state = 'failed' AND retries < ? AND infra_retries < ?
          AND job_id IN (SELECT id FROM jobs WHERE state = 'cancelled')`
    ).run(MAX_RETRIES, MAX_INFRA_RETRIES)
    db.prepare("INSERT INTO history_meta (key, value) VALUES ('cancelled_chunks_v1', ?)").run(
      String(Date.now())
    )
  })()
}

/**
 * The app_state keys known so far; schema.sql says what each holds. The
 * functions below take any string too, so a later item can add a key
 * without editing this file (it should document it in schema.sql).
 */
export type AppStateKey = 'install_id' | 'recovery_hold' | 'account_hold' | 'local_sink_hold'

/** An AppStateKey, or a key a later item added (`string & {}` keeps the hints). */
type AnyAppStateKey = AppStateKey | (string & {})

/**
 * An app_state value, or null when the key was never written or was cleared.
 * Takes the database rather than calling getDb(), so it works on whichever
 * handle the caller has, the test harness's included.
 */
export function readAppState(db: Db, key: AnyAppStateKey): string | null {
  const row = db.prepare('SELECT value FROM app_state WHERE key = ?').get(key) as
    { value: string } | undefined
  return row?.value ?? null
}

/** Set an app_state key, stamping updated_at; null deletes it. */
export function writeAppState(db: Db, key: AnyAppStateKey, value: string | null): void {
  if (value == null) {
    db.prepare('DELETE FROM app_state WHERE key = ?').run(key)
    return
  }
  db.prepare(
    `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, value, Date.now())
}

export function closeDb(): void {
  db?.close()
  db = null
}
