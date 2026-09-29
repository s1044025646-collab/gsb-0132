import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export function openDatabase(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  migrate(db)
  return db
}

/**
 * Idempotent migrations. Every statement is re-runnable and the user_version
 * guard makes running migrations on an existing database a no-op.
 */
export function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS songs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      midi_format INTEGER NOT NULL,
      ppq INTEGER NOT NULL,
      original_sha256 TEXT NOT NULL,
      original_bytes BLOB NOT NULL,
      created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      song_id INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
      version_no INTEGER NOT NULL,
      kind TEXT NOT NULL,
      params_json TEXT NOT NULL DEFAULT '{}',
      document_json TEXT NOT NULL,
      parent_version_id INTEGER,
      created_at_ms INTEGER NOT NULL,
      UNIQUE(song_id, version_no)
    );
    CREATE TABLE IF NOT EXISTS export_batches (
      idempotency_key TEXT PRIMARY KEY,
      song_id INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
      version_id INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      byte_count INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL
    );
  `)
}
