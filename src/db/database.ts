import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MIGRATIONS } from "./schema.ts";

export type DB = DatabaseSync;

/**
 * Open the database and run any pending migrations. Migrations are keyed and
 * guarded by schema_migrations, so running them repeatedly is safe.
 */
export function openDatabase(path: string, now: () => Date = () => new Date()): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db, now);
  return db;
}

export function migrate(db: DB, now: () => Date): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);",
  );
  const appliedStmt = db.prepare("SELECT id FROM schema_migrations WHERE id = ?");
  const insert = db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)");
  for (const m of MIGRATIONS) {
    const row = appliedStmt.get(m.id) as { id: number } | undefined;
    if (row) continue;
    const tx = db.exec.bind(db);
    void tx;
    db.exec("BEGIN");
    try {
      db.exec(m.sql);
      insert.run(m.id, now().toISOString());
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}

export function closeDatabase(db: DB): void {
  db.close();
}
