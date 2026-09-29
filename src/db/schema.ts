export const MIGRATIONS: { id: number; sql: string }[] = [
  {
    id: 1,
    sql: `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS songs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  format INTEGER NOT NULL,
  ppq INTEGER NOT NULL,
  original_bytes BLOB NOT NULL,
  source_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  song_id INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL,
  parent_version_id INTEGER,
  label TEXT NOT NULL,
  op_type TEXT NOT NULL,
  op_json TEXT NOT NULL,
  bytes BLOB NOT NULL,
  next_order INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(song_id, version_no)
);

CREATE TABLE IF NOT EXISTS source_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  song_id INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  track_index INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  tick INTEGER NOT NULL,
  kind TEXT NOT NULL,
  channel INTEGER NOT NULL,
  data1 INTEGER NOT NULL,
  data2 INTEGER NOT NULL,
  status INTEGER NOT NULL,
  bytes BLOB NOT NULL,
  parse_order INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS export_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  song_id INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  version_id INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  idempotency_key TEXT,
  format INTEGER NOT NULL,
  bytes BLOB NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_versions_song ON versions(song_id, version_no);
CREATE INDEX IF NOT EXISTS idx_source_events_song ON source_events(song_id, track_index, tick);
CREATE INDEX IF NOT EXISTS idx_exports_song ON export_batches(song_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_exports_idem
  ON export_batches(song_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
`,
  },
];
