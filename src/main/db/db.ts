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
    db.prepare('INSERT INTO schema_meta (version) VALUES (?)').run(1)
  }
  // Future migrations: switch on row.version here.
  return db
}

export function closeDb(): void {
  db?.close()
  db = null
}
