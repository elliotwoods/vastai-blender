/**
 * The schema and its migrations, on node's own SQLite (better-sqlite3 is built
 * for Electron's ABI; see test/sqlite.ts).
 *
 * The upgrade path is the one that bricks every existing install if it is
 * wrong, and no fresh test database ever takes it. So these tests build the
 * database an earlier build left behind, from that build's own schema.sql,
 * committed under fixtures/ exactly as `git show <commit>:src/main/db/schema.sql`
 * prints it:
 *
 *   schema-08937c1.sql   the first Electron build; schema version 1, no migrations yet
 *   schema-9d4a64c.sql   schema version 5, the last before Phase 1
 *
 * and check that applySchema brings each to exactly what a fresh database
 * gets, keeps its rows, and does nothing more on the next launch.
 */

import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openTestDb } from '../test/sqlite'
import { applySchema, readAppState, writeAppState, type Db } from './db'

// db.ts imports electron for getDb's userData path. Nothing here may get that
// far: every database in this file is in memory.
vi.mock('electron', () => ({
  app: {
    getPath: () => {
      throw new Error('db.test: getDb() must not run; these databases are in memory')
    }
  }
}))

/** db.ts's SCHEMA_VERSION: what applySchema records. */
const SCHEMA_VERSION = 7
const NOW = 1_700_000_000_000
const MINUTE = 60_000
const T0 = NOW - 30 * 24 * 60 * MINUTE

const V1 = fixture('schema-08937c1.sql')
const V5 = fixture('schema-9d4a64c.sql')

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.useRealTimers()
})

type Row = Record<string, unknown>

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8')
}

function all(db: Db, sql: string, ...params: unknown[]): Row[] {
  return (db.prepare(sql).all(...params) as Row[]).map((r) => ({ ...r }))
}

function get(db: Db, sql: string, ...params: unknown[]): Row | undefined {
  const r = db.prepare(sql).get(...params) as Row | undefined
  return r && { ...r }
}

function freshDb(): Db {
  return openTestDb(applySchema)
}

/**
 * A database as a build of that schema left it: its schema.sql, the version
 * row it wrote, then whatever rows `seed` adds. applySchema has not run.
 */
function legacyDb(schemaSql: string, version: number, seed: (db: Db) => void = () => {}): Db {
  return openTestDb((db) => {
    db.exec(schemaSql)
    db.prepare('INSERT INTO schema_meta (version) VALUES (?)').run(version)
    seed(db)
  })
}

function tableNames(db: Db): string[] {
  return all(
    db,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).map((r) => String(r.name))
}

/**
 * Everything about the schema that a query can depend on, comparably: every
 * object by name, and per table its columns in order (type, NOT NULL,
 * default, key), its indexes and the columns they cover, its foreign keys.
 */
function shape(db: Db): Row {
  const tables: Row = {}
  for (const t of tableNames(db)) {
    tables[t] = {
      columns: all(db, `PRAGMA table_info(${t})`),
      indexes: all(db, `PRAGMA index_list(${t})`)
        .map((i) => ({
          name: i.name,
          unique: i.unique,
          origin: i.origin,
          partial: i.partial,
          columns: all(db, `PRAGMA index_info(${String(i.name)})`).map((c) => c.name)
        }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name))),
      foreignKeys: all(db, `PRAGMA foreign_key_list(${t})`)
    }
  }
  const objects = all(
    db,
    "SELECT type, name, tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
  )
  return { objects, tables }
}

/** Every row of every table, in insertion order. */
function dump(db: Db): Record<string, Row[]> {
  const out: Record<string, Row[]> = {}
  for (const t of tableNames(db)) out[t] = all(db, `SELECT * FROM ${t} ORDER BY rowid`)
  return out
}

function column(db: Db, table: string, name: string): Row | undefined {
  const c = all(db, `PRAGMA table_info(${table})`).find((col) => col.name === name)
  return c && { type: c.type, notnull: c.notnull, dflt: c.dflt_value }
}

function columnNames(db: Db, table: string): string[] {
  return all(db, `PRAGMA table_info(${table})`).map((c) => String(c.name))
}

function indexedColumns(db: Db, table: string): string[][] {
  return all(db, `PRAGMA index_list(${table})`)
    .map((i) => all(db, `PRAGMA index_info(${String(i.name)})`).map((c) => String(c.name)))
    .sort((a, b) => a.join().localeCompare(b.join()))
}

const nodeId = (prefix: string): string => `${prefix}-1111-4222-8333-444444444444`
const DESTROYED_METERED = nodeId('d1d1d1d1')
const DESTROYED_UNMETERED = nodeId('d2d2d2d2')
const DESTROYED_NEVER_UP = nodeId('d3d3d3d3')
const FAILED_WITH_INSTANCE = nodeId('f1f1f1f1')
const LIVE_OCTANE = nodeId('a1a1a1a1')

// Rentals that never learned their instance id, each with the last_error
// rentOffer's catch left: vastClient's words, the same in every build since
// the first. The c rows may have created an instance; the e rows cannot.
const MID_CREATE = nodeId('c1c1c1c1')
const DESTROYED_MID_CREATE = nodeId('c2c2c2c2')
const CREATE_REPLY_LOST = nodeId('c3c3c3c3')
const CREATE_5XX = nodeId('c4c4c4c4')
const CREATE_NOT_JSON = nodeId('c5c5c5c5')
const CANCELLED_CREATE_UNKNOWN = nodeId('c6c6c6c6')
const CREATE_REFUSED = nodeId('e1e1e1e1')
const CREATE_NO_CONTRACT = nodeId('e2e2e2e2')
const CREATE_NO_KEY = nodeId('e3e3e3e3')

/**
 * Rows a user of the first release could have, in columns every schema since
 * has: a job mid-render, and nodes in each state the migration treats apart.
 */
function seedV1Rows(db: Db): void {
  db.prepare(
    `INSERT INTO jobs (id, name, blend_path, engine, frame_start, frame_end, frame_step, state,
       blender_version, addon_ids, chunk_size, output_dir, cost_so_far, submitted_at)
     VALUES ('job1', 'shot 10', '/scenes/shot10.blend', 'cycles', 1, 20, 1, 'running',
       '4.2.3', '[]', 10, '/renders/job1', 1.25, ?)`
  ).run(T0)
  db.prepare(
    `INSERT INTO chunks (id, job_id, frame_start, frame_end, state, node_id, frames_done, retries)
     VALUES ('job1-1-10', 'job1', 1, 10, 'complete', ?, 10, 0),
            ('job1-11-20', 'job1', 11, 20, 'rendering', ?, 3, 2)`
  ).run(DESTROYED_METERED, LIVE_OCTANE)
  db.prepare(
    `INSERT INTO frames (job_id, frame, chunk_id, state, local_path, size_bytes)
     VALUES ('job1', 1, 'job1-1-10', 'downloaded', '/renders/job1/0001.exr', 1000)`
  ).run()
  const node = db.prepare(
    `INSERT INTO nodes (id, instance_id, state, gpu_name, num_gpus, dph_total, started_at, octane_ready)
     VALUES (?, ?, ?, 'RTX 4090', 4, 1.6, ?, ?)`
  )
  node.run(DESTROYED_METERED, 101, 'destroyed', T0, 0)
  node.run(DESTROYED_UNMETERED, 102, 'destroyed', T0 + 5 * MINUTE, 0)
  node.run(DESTROYED_NEVER_UP, null, 'destroyed', null, 0)
  node.run(FAILED_WITH_INSTANCE, 104, 'failed', T0, 0)
  node.run(LIVE_OCTANE, 105, 'ready', T0, 1)
  const rental = db.prepare(
    `INSERT INTO nodes (id, instance_id, state, gpu_name, num_gpus, dph_total, last_error)
     VALUES (?, NULL, ?, 'RTX 4090', 1, 0.4, ?)`
  )
  // The app stopped while the create was out, before and after a destroy.
  rental.run(MID_CREATE, 'requested', null)
  rental.run(DESTROYED_MID_CREATE, 'destroying', null)
  // Threw after Vast may have acted.
  rental.run(CREATE_REPLY_LOST, 'failed', 'network error: fetch failed')
  rental.run(CREATE_5XX, 'failed', 'vast.ai PUT /asks/9001/ → 502: <html>Bad Gateway</html>')
  rental.run(CREATE_NOT_JSON, 'failed', 'vast.ai PUT /asks/9001/: non-JSON response: <html>')
  // Refused, or never sent.
  rental.run(
    CREATE_REFUSED,
    'failed',
    'vast.ai PUT /asks/9001/ → 400: {"success": false, "error": "no_such_ask"}'
  )
  rental.run(CREATE_NO_CONTRACT, 'failed', 'create instance failed: offer unavailable')
  rental.run(CREATE_NO_KEY, 'failed', 'No Vast.ai API key configured')
  const cost = db.prepare(
    'INSERT INTO cost_log (node_id, ts, dph_total, delta_cost) VALUES (?, ?, 1.6, 0.0267)'
  )
  cost.run(DESTROYED_METERED, T0 + MINUTE)
  cost.run(DESTROYED_METERED, T0 + 7 * MINUTE)
  cost.run(DESTROYED_METERED, T0 + 3 * MINUTE)
  cost.run(FAILED_WITH_INSTANCE, T0 + MINUTE)
  cost.run(LIVE_OCTANE, T0 + MINUTE)
  // Learned before 93cbad4 made it per GPU: a 4-GPU node's total.
  db.prepare(
    "INSERT INTO gpu_perf (gpu_name, frames_per_hour, samples, updated_at) VALUES ('RTX 4090', 400, 9, ?)"
  ).run(T0)
}

/** As seedV1Rows, plus what a version 5 build had written by then. */
function seedV5Rows(db: Db): void {
  seedV1Rows(db)
  // A v5 build ran the usage_log backfill and marked it done.
  db.prepare(
    `INSERT INTO usage_log (ts, node_id, job_id, chunk_id, delta_cost, delta_wh, power_w, gpu_util)
     SELECT ts, node_id, NULL, NULL, delta_cost, 0, NULL, NULL FROM cost_log`
  ).run()
  db.prepare("INSERT INTO history_meta (key, value) VALUES ('backfill_v1', ?)").run(String(T0))
  // Its per-node slot count for the same model: 12 slots on 4 GPUs.
  db.prepare(
    "INSERT INTO gpu_slots (gpu_name, best_slots, frames_per_hour, samples, updated_at) VALUES ('RTX 4090', 12, 400, 5, ?)"
  ).run(T0)
  db.prepare("UPDATE nodes SET geolocation = 'Poland, PL' WHERE id = ?").run(LIVE_OCTANE)
  // Phase 0's cancelledCreateUnknown, which ran on this schema.
  db.prepare(
    `INSERT INTO nodes (id, instance_id, state, gpu_name, num_gpus, dph_total, last_error)
     VALUES (?, NULL, 'failed', 'RTX 4090', 1, 0.4, ?)`
  ).run(
    CANCELLED_CREATE_UNKNOWN,
    "cancelled while creating; the create's outcome is unknown: network error: fetch failed"
  )
}

/** Rows seedV1Rows leaves whose create may have made an instance. */
const UNKNOWN_V1 = [
  MID_CREATE,
  DESTROYED_MID_CREATE,
  CREATE_REPLY_LOST,
  CREATE_5XX,
  CREATE_NOT_JSON
]
const UNKNOWN_V5 = [...UNKNOWN_V1, CANCELLED_CREATE_UNKNOWN]

/**
 * schema.sql's billing predicate, as written there (plan 1.2's holdsInstance
 * in SQL): the rows that count against the caps and are metered.
 */
const HOLDS_INSTANCE = `(instance_id IS NOT NULL AND destroyed_at IS NULL)
  OR (instance_id IS NULL AND (create_unknown_since IS NOT NULL OR state = 'requested'))`

const ids = (rows: Row[]): string[] => rows.map((r) => String(r.id)).sort()

describe('a fresh database', () => {
  it('has every column and table Phase 1 stores', () => {
    const db = freshDb()
    const int = { type: 'INTEGER', notnull: 0, dflt: null }
    const text = { type: 'TEXT', notnull: 0, dflt: null }

    // 1.2 billing predicate, 1.3/1.4 labels, 1.18 Octane, 1.4 unknown creates
    expect(column(db, 'nodes', 'destroyed_at')).toEqual(int)
    expect(column(db, 'nodes', 'label')).toEqual(text)
    expect(column(db, 'nodes', 'octane_state')).toEqual({
      type: 'TEXT',
      notnull: 1,
      dflt: "'none'"
    })
    expect(column(db, 'nodes', 'create_unknown_since')).toEqual(int)
    // 1.17 retry policy, 1.16 scene errors
    expect(column(db, 'chunks', 'not_before')).toEqual(int)
    expect(column(db, 'chunks', 'infra_retries')).toEqual({
      type: 'INTEGER',
      notnull: 1,
      dflt: '0'
    })
    expect(column(db, 'chunks', 'error_kind')).toEqual(text)
    // 1.12 scene snapshot, 1.17 job breaker
    expect(column(db, 'jobs', 'blend_sha256')).toEqual(text)
    expect(column(db, 'jobs', 'scene_path')).toEqual(text)
    expect(column(db, 'jobs', 'attention')).toEqual(text)
    // 1.11 (#226, #238)
    expect(column(db, 'gpu_perf', 'num_gpus')).toEqual(int)
    expect(column(db, 'gpu_slots', 'num_gpus')).toEqual(int)
    // Feature G
    expect(columnNames(db, 'node_metrics')).toEqual([
      'ts',
      'node_id',
      'gpu_index',
      'util',
      'vram_used_gb',
      'vram_total_gb',
      'power_w',
      'runs'
    ])
    expect(indexedColumns(db, 'node_metrics')).toEqual([['node_id', 'ts'], ['ts']])
    // 1.3 install id, 1.9 recovery hold, 1.20 account hold
    expect(columnNames(db, 'app_state')).toEqual(['key', 'value', 'updated_at'])

    expect(get(db, 'SELECT version FROM schema_meta')).toEqual({ version: SCHEMA_VERSION })
    expect(all(db, 'SELECT key FROM history_meta ORDER BY key')).toEqual([
      { key: 'backfill_v1' },
      { key: 'cancelled_chunks_v1' },
      { key: 'gpu_units_v1' }
    ])
  })

  it('keeps what gpu_perf and gpu_slots learn after its first launch', () => {
    const db = freshDb()
    db.prepare(
      "INSERT INTO gpu_perf (gpu_name, frames_per_hour, samples, updated_at, num_gpus) VALUES ('RTX 4090', 100, 1, ?, 4)"
    ).run(NOW)
    db.prepare(
      "INSERT INTO gpu_slots (gpu_name, best_slots, frames_per_hour, samples, updated_at, num_gpus) VALUES ('RTX 4090', 3, 100, 1, ?, 4)"
    ).run(NOW)
    applySchema(db)
    expect(all(db, 'SELECT gpu_name, num_gpus FROM gpu_perf')).toEqual([
      { gpu_name: 'RTX 4090', num_gpus: 4 }
    ])
    expect(all(db, 'SELECT gpu_name, best_slots FROM gpu_slots')).toEqual([
      { gpu_name: 'RTX 4090', best_slots: 3 }
    ])
  })
})

describe.each([
  {
    name: 'the original schema (08937c1, v1)',
    sql: V1,
    version: 1,
    seed: seedV1Rows,
    unknownCreates: UNKNOWN_V1
  },
  {
    name: 'the 9d4a64c schema (v5)',
    sql: V5,
    version: 5,
    seed: seedV5Rows,
    unknownCreates: UNKNOWN_V5
  }
])('upgrading $name', ({ sql, version, seed, unknownCreates }) => {
  it('migrates to exactly the shape of a fresh database, empty or not', () => {
    const fresh = shape(freshDb())
    const empty = legacyDb(sql, version)
    applySchema(empty)
    expect(shape(empty)).toEqual(fresh)
    const used = legacyDb(sql, version, seed)
    applySchema(used)
    expect(shape(used)).toEqual(fresh)
    expect(get(used, 'SELECT version FROM schema_meta')).toEqual({ version: SCHEMA_VERSION })
  })

  it('changes nothing more at the next launch', () => {
    const db = legacyDb(sql, version, seed)
    applySchema(db)
    const before = { shape: shape(db), rows: dump(db) }
    vi.setSystemTime(NOW + 60 * MINUTE)
    applySchema(db)
    expect({ shape: shape(db), rows: dump(db) }).toEqual(before)
  })

  it('keeps every row, the new columns at their "nothing yet" values', () => {
    const db = legacyDb(sql, version, seed)
    applySchema(db)
    expect(get(db, 'SELECT * FROM jobs')).toMatchObject({
      id: 'job1',
      blend_path: '/scenes/shot10.blend',
      state: 'running',
      cost_so_far: 1.25,
      share_node: 0,
      blend_sha256: null,
      scene_path: null,
      attention: null
    })
    expect(
      all(
        db,
        'SELECT id, state, retries, infra_retries, not_before, error_kind FROM chunks ORDER BY id'
      )
    ).toEqual([
      {
        id: 'job1-1-10',
        state: 'complete',
        retries: 0,
        infra_retries: 0,
        not_before: null,
        error_kind: null
      },
      {
        id: 'job1-11-20',
        state: 'rendering',
        retries: 2,
        infra_retries: 0,
        not_before: null,
        error_kind: null
      }
    ])
    expect(all(db, 'SELECT frame, state, local_path FROM frames')).toEqual([
      { frame: 1, state: 'downloaded', local_path: '/renders/job1/0001.exr' }
    ])
    expect(get(db, 'SELECT COUNT(*) AS n FROM cost_log')).toEqual({ n: 5 })
    // Seeded from cost_log once, by whichever build first had usage_log.
    expect(get(db, 'SELECT COUNT(*) AS n FROM usage_log')).toEqual({ n: 5 })
    expect(all(db, 'SELECT * FROM node_metrics')).toEqual([])
    expect(all(db, 'SELECT * FROM app_state')).toEqual([])
  })

  it('stamps destroyed_at on destroyed nodes only, at their last metered minute (plan 1.2)', () => {
    const db = legacyDb(sql, version, seed)
    applySchema(db)
    const stamps = Object.fromEntries(
      all(db, 'SELECT id, destroyed_at FROM nodes').map((r) => [r.id, r.destroyed_at])
    )
    const noInstanceId = [...unknownCreates, CREATE_REFUSED, CREATE_NO_CONTRACT, CREATE_NO_KEY].map(
      (id) => [id, null]
    )
    expect(stamps).toEqual({
      [DESTROYED_METERED]: T0 + 7 * MINUTE,
      // Never metered: when it came up is the nearest thing known.
      [DESTROYED_UNMETERED]: T0 + 5 * MINUTE,
      // Never came up: gone by the time of the migration, at least.
      [DESTROYED_NEVER_UP]: NOW,
      // 'failed' with an instance is the node that may be billing still.
      // Nothing but Vast can clear it; the migration must not.
      [FAILED_WITH_INSTANCE]: null,
      [LIVE_OCTANE]: null,
      // No instance id and not 'destroyed': nothing was destroyed.
      ...Object.fromEntries(noInstanceId)
    })
  })

  it('counts a create whose result never came as possibly billing (plans 1.2, 1.4; Phase 0 review)', () => {
    // cancelledCreateUnknown's row, and every create that threw after Vast
    // may have acted, has instance_id NULL. A predicate of "an instance id
    // and no destroyed_at" skips them all, so an instance billing under the
    // node's label would be neither capped nor metered.
    const db = legacyDb(sql, version, seed)
    applySchema(db)
    expect(ids(all(db, 'SELECT id FROM nodes WHERE create_unknown_since IS NOT NULL'))).toEqual(
      [...unknownCreates].sort()
    )
    // The send time was never recorded; the migration's stands in for it.
    expect(
      all(
        db,
        'SELECT DISTINCT create_unknown_since FROM nodes WHERE create_unknown_since IS NOT NULL'
      )
    ).toEqual([{ create_unknown_since: NOW }])

    expect(ids(all(db, `SELECT id FROM nodes WHERE ${HOLDS_INSTANCE}`))).toEqual(
      [FAILED_WITH_INSTANCE, LIVE_OCTANE, ...unknownCreates].sort()
    )
  })

  it('records the label each node was rented under (plans 1.3, 1.4)', () => {
    const db = legacyDb(sql, version, seed)
    applySchema(db)
    const labels = all(db, 'SELECT id, label FROM nodes')
    expect(labels.length).toBeGreaterThan(0)
    for (const { id, label } of labels) {
      expect(label).toBe(`vastai-blender ${String(id).slice(0, 8)}`)
    }
  })

  it('does not carry octane_ready into octane_state: #85 set it on a failed license (plan 1.18)', () => {
    // octaneLicense tested /acquir|success/ before /fail/, so "Failed to
    // acquire license" read as licensed. As 'licensed', the node would never
    // be checked again; as 'none', 1.18 checks the node itself.
    const db = legacyDb(sql, version, seed)
    applySchema(db)
    expect(
      get(db, 'SELECT octane_ready, octane_state FROM nodes WHERE id = ?', LIVE_OCTANE)
    ).toEqual({ octane_ready: 1, octane_state: 'none' })
    expect(all(db, 'SELECT DISTINCT octane_state FROM nodes')).toEqual([{ octane_state: 'none' }])
  })

  it('forgets what gpu_perf and gpu_slots learned per node, exactly once (plan 1.11, #226, #238)', () => {
    const db = legacyDb(sql, version, seed)
    expect(get(db, 'SELECT COUNT(*) AS n FROM gpu_perf')).toEqual({ n: 1 })
    applySchema(db)
    expect(all(db, 'SELECT * FROM gpu_perf')).toEqual([])
    expect(all(db, 'SELECT * FROM gpu_slots')).toEqual([])
    expect(get(db, "SELECT value FROM history_meta WHERE key = 'gpu_units_v1'")).toEqual({
      value: String(NOW)
    })

    // Relearned per GPU by this build; the next launch must keep it.
    db.prepare(
      "INSERT INTO gpu_perf (gpu_name, frames_per_hour, samples, updated_at, num_gpus) VALUES ('RTX 4090', 100, 1, ?, 4)"
    ).run(NOW)
    db.prepare(
      "INSERT INTO gpu_slots (gpu_name, best_slots, frames_per_hour, samples, updated_at, num_gpus) VALUES ('RTX 4090', 3, 100, 1, ?, 4)"
    ).run(NOW)
    vi.setSystemTime(NOW + 60 * MINUTE)
    applySchema(db)
    expect(all(db, 'SELECT frames_per_hour, num_gpus FROM gpu_perf')).toEqual([
      { frames_per_hour: 100, num_gpus: 4 }
    ])
    expect(all(db, 'SELECT best_slots, num_gpus FROM gpu_slots')).toEqual([
      { best_slots: 3, num_gpus: 4 }
    ])
    expect(get(db, "SELECT value FROM history_meta WHERE key = 'gpu_units_v1'")).toEqual({
      value: String(NOW)
    })
  })

  it("marks a cancelled job's open chunks cancelled, once, keeping real failures (v7)", () => {
    const db = legacyDb(sql, version, (d) => {
      seed(d)
      const job = d.prepare(
        `INSERT INTO jobs (id, name, blend_path, engine, frame_start, frame_end, frame_step, state,
           blender_version, addon_ids, chunk_size, output_dir, cost_so_far, submitted_at)
         VALUES (?, ?, '/scenes/a.blend', 'cycles', 1, 40, 1, ?, '4.2.3', '[]', 10, ?, 0, ?)`
      )
      job.run('job-c', 'cancelled job', 'cancelled', '/renders/job-c', T0)
      job.run('job-p', 'partial job', 'partial', '/renders/job-p', T0)
      const chunk = d.prepare(
        `INSERT INTO chunks (id, job_id, frame_start, frame_end, state, frames_done, retries)
         VALUES (?, ?, ?, ?, ?, 0, ?)`
      )
      // A cancel before v7 wrote 'failed' over every open chunk.
      chunk.run('c-1-10', 'job-c', 1, 10, 'complete', 0)
      chunk.run('c-11-20', 'job-c', 11, 20, 'failed', 1)
      chunk.run('c-21-30', 'job-c', 21, 30, 'failed', 0)
      // Out of render retries before the cancel came: a real failure.
      chunk.run('c-31-40', 'job-c', 31, 40, 'failed', 4)
      // Not a cancelled job's: failed for good, whatever its retries.
      chunk.run('p-1-10', 'job-p', 1, 10, 'failed', 0)
    })
    applySchema(db)
    const states = (): Row[] =>
      all(db, "SELECT id, state FROM chunks WHERE job_id IN ('job-c', 'job-p') ORDER BY id")
    expect(states()).toEqual([
      { id: 'c-1-10', state: 'complete' },
      { id: 'c-11-20', state: 'cancelled' },
      { id: 'c-21-30', state: 'cancelled' },
      { id: 'c-31-40', state: 'failed' },
      { id: 'p-1-10', state: 'failed' }
    ])
    expect(get(db, "SELECT value FROM history_meta WHERE key = 'cancelled_chunks_v1'")).toEqual({
      value: String(NOW)
    })

    // A chunk this build fails after a cancel (none does; a hand edit might)
    // is not touched by the next launch.
    db.prepare("UPDATE chunks SET state = 'failed' WHERE id = 'c-21-30'").run()
    applySchema(db)
    expect(get(db, "SELECT state FROM chunks WHERE id = 'c-21-30'")).toEqual({ state: 'failed' })
  })
})

describe('a migration step that fails', () => {
  it('leaves no column without its backfill, and runs whole at the next launch', () => {
    // A column step is guarded by the column alone. Had the ALTER committed
    // and the backfill then thrown, the next launch would see the column,
    // skip the step, and every destroyed node would read as billing forever.
    const db = legacyDb(V5, 5, seedV5Rows)
    db.exec(
      "CREATE TRIGGER vr_test_refuse BEFORE UPDATE ON nodes BEGIN SELECT RAISE(ABORT, 'disk said no'); END"
    )
    expect(() => applySchema(db)).toThrow(/disk said no/)
    expect(column(db, 'nodes', 'destroyed_at')).toBeUndefined()

    db.exec('DROP TRIGGER vr_test_refuse')
    applySchema(db)
    expect(get(db, 'SELECT destroyed_at FROM nodes WHERE id = ?', DESTROYED_METERED)).toEqual({
      destroyed_at: T0 + 7 * MINUTE
    })
    expect(shape(db)).toEqual(shape(freshDb()))
  })
})

describe('app_state', () => {
  it('reads back what was written, stamps the write and forgets a cleared key', () => {
    const db = freshDb()
    expect(readAppState(db, 'account_hold')).toBeNull()

    writeAppState(db, 'account_hold', '{"reason":"insufficient_credit"}')
    expect(readAppState(db, 'account_hold')).toBe('{"reason":"insufficient_credit"}')
    vi.setSystemTime(NOW + MINUTE)
    writeAppState(db, 'account_hold', '{"reason":"runway under 10 min"}')
    expect(all(db, 'SELECT * FROM app_state')).toEqual([
      { key: 'account_hold', value: '{"reason":"runway under 10 min"}', updated_at: NOW + MINUTE }
    ])

    writeAppState(db, 'install_id', 'c0ffee00')
    writeAppState(db, 'account_hold', null)
    expect(readAppState(db, 'account_hold')).toBeNull()
    // A restart keeps it: nothing in applySchema touches app_state.
    applySchema(db)
    expect(readAppState(db, 'install_id')).toBe('c0ffee00')
  })

  it('takes a key a later item adds without a change to db.ts', () => {
    // Typechecked: AppStateKey names the keys known now, not every key.
    const db = freshDb()
    writeAppState(db, 'local_sink_hold', '{"reason":"ENOSPC"}')
    writeAppState(db, 'a_later_items_key', '1')
    expect(readAppState(db, 'local_sink_hold')).toBe('{"reason":"ENOSPC"}')
    expect(readAppState(db, 'a_later_items_key')).toBe('1')
  })
})
