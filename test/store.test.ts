import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../src/db/database.ts";
import type { DB } from "../src/db/database.ts";
import { Store } from "../src/store.ts";
import { demoBytes } from "./fixtures.ts";
import { pairNotes } from "../src/midi/notes.ts";
import { parseMidi } from "../src/midi/parser.ts";
import { AppError } from "../src/errors.ts";

const dir = join(process.cwd(), "tmp", "test-store");
const dbPath = join(dir, "s.db");

let db: DB;
let store: Store;

before(() => {
  rmSync(dir, { recursive: true, force: true });
  const clock = (() => {
    let t = 0;
    return () => new Date(Date.UTC(2026, 0, 1) + t++ * 1000);
  })();
  db = openDatabase(dbPath, clock);
  store = new Store(db, clock);
});

after(() => {
  db.close();
});

test("import then transpose creates a version chain", () => {
  const { songId } = store.importSong("a.mid", demoBytes());
  const v1 = store.latestVersion(songId);
  assert.equal(v1.version_no, 1);
  const v2 = store.transpose(songId, null, { semitones: 3 });
  assert.equal(v2.version_no, 2);
  assert.equal(v2.parent_version_id, v1.id);
  const { file: f2 } = store.loadVersion(songId, v2.id);
  assert.ok(pairNotes(f2).length > 0);
});

test("out-of-range transpose rolls back and leaves latest version intact", () => {
  const { songId } = store.importSong("b.mid", demoBytes());
  const before = store.latestVersion(songId);
  assert.throws(
    () => store.transpose(songId, null, { semitones: 120 }),
    (e: unknown) => e instanceof AppError && e.code === "OUT_OF_RANGE",
  );
  const after = store.latestVersion(songId);
  assert.equal(after.id, before.id);
  const count = (
    db.prepare("SELECT COUNT(*) c FROM versions WHERE song_id = ?").get(songId) as { c: number }
  ).c;
  assert.equal(count, 1);
});

test("repeated export with same idempotency key returns same batch", () => {
  const { songId } = store.importSong("c.mid", demoBytes());
  const a = store.exportMidi(songId, null, "fixed-key");
  const b = store.exportMidi(songId, null, "fixed-key");
  assert.equal(a.batchId, b.batchId);
  assert.equal(b.reused, true);
  assert.equal(a.sha256, b.sha256);
});

test("exports are deterministic byte-for-byte", () => {
  const { songId } = store.importSong("d.mid", demoBytes());
  const a = store.exportMidi(songId, null).bytes;
  const b = store.exportMidi(songId, null).bytes;
  assert.deepEqual(a, b);
});

test("older versions remain reproducible after further edits", () => {
  const { songId } = store.importSong("e.mid", demoBytes());
  const v1 = store.latestVersion(songId);
  store.transpose(songId, null, { semitones: 7 });
  store.setInstrument(songId, null, 1, 0, 50);
  const reloaded = store.loadVersion(songId, v1.id);
  const notes = pairNotes(reloaded.file).filter((n) => n.channel !== 9);
  const expected = pairNotes(parseMidi(demoBytes())).filter((n) => n.channel !== 9);
  assert.deepEqual(notes.map((n) => n.note), expected.map((n) => n.note));
});

test("pagination bounds and totals work", () => {
  for (let i = 0; i < 3; i++) store.importSong(`p${i}.mid`, demoBytes());
  const page = store.listSongs(2, 0);
  assert.equal(page.items.length, 2);
  assert.ok(page.total >= 5);
});

test("restart persistence: reopen database file and read songs", () => {
  db.close();
  const db2 = openDatabase(dbPath);
  const store2 = new Store(db2);
  const page = store2.listSongs(100, 0);
  assert.ok(page.total >= 6);
  const first = page.items[0];
  const v = store2.latestVersion(first.id);
  assert.ok(v.id > 0);
  db2.close();
  // reopen for subsequent tests/after hook consistency
  db = openDatabase(dbPath);
});

test("migrations are idempotent on reopen", () => {
  const db3 = openDatabase(dbPath);
  const rows = db3.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as { id: number }[];
  assert.deepEqual(rows.map((r) => r.id), [1]);
  db3.close();
});
