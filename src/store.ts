import { createHash, randomUUID } from "node:crypto";
import type { DB } from "./db/database.ts";
import { AppError } from "./errors.ts";
import { parseMidi } from "./midi/parser.ts";
import { writeMidi } from "./midi/writer.ts";
import { transpose, setInstrument, type TransposeOptions } from "./midi/transform.ts";
import type { ParsedFile } from "./midi/types.ts";
import { pairNotes } from "./midi/notes.ts";
import { previewQuantize, applyQuantize, type QuantizeOptions, type QuantizePreview } from "./midi/quantize.ts";

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface OpRecord {
  type: "transpose" | "instrument" | "quantize" | "import";
  params: unknown;
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

export class Store {
  constructor(
    readonly db: DB,
    private readonly now: () => Date = () => new Date(),
  ) {}

  importSong(name: string, bytes: Buffer): { songId: number; versionId: number } {
    let parsed: ParsedFile;
    try {
      parsed = parseMidi(bytes);
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError("INVALID_FILE", (e as Error).message);
    }

    const canonical = writeMidi(parsed);
    const sourceHash = sha(canonical);
    const ts = this.now().toISOString();

    const tx = this.db.exec("BEGIN");
    void tx;
    try {
      const songInfo = this.db
        .prepare(
          `INSERT INTO songs (name, format, ppq, original_bytes, source_sha256, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(name, parsed.format, parsed.ppq, bytes, sourceHash, ts);
      const songId = Number(songInfo.lastInsertRowid);

      let seq = 0;
      const insEvent = this.db.prepare(
        `INSERT INTO source_events
         (song_id, track_index, seq, tick, kind, channel, data1, data2, status, bytes, parse_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const track of parsed.tracks) {
        for (const ev of track.events) {
          insEvent.run(
            songId, track.index, seq++, ev.tick, ev.kind, ev.channel,
            ev.data1, ev.data2, ev.status, Buffer.from(ev.bytes), ev.order,
          );
        }
      }

      const nextOrder = this.computeNextOrder(parsed);
      const vInfo = this.db
        .prepare(
          `INSERT INTO versions
           (song_id, version_no, parent_version_id, label, op_type, op_json, bytes, next_order, created_at)
           VALUES (?, 1, NULL, 'import', 'import', ?, ?, ?, ?)`,
        )
        .run(songId, JSON.stringify({}), canonical, nextOrder, ts);
      const versionId = Number(vInfo.lastInsertRowid);
      this.db.exec("COMMIT");
      return { songId, versionId };
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  private computeNextOrder(file: ParsedFile): number {
    let max = -1;
    for (const t of file.tracks) for (const e of t.events) max = Math.max(max, e.order);
    return max + 1;
  }

  getSong(songId: number) {
    const row = this.db
      .prepare("SELECT id, name, format, ppq, source_sha256, created_at FROM songs WHERE id = ?")
      .get(songId) as
      | { id: number; name: string; format: number; ppq: number; source_sha256: string; created_at: string }
      | undefined;
    if (!row) throw new AppError("NOT_FOUND", `Song ${songId} not found`);
    return row;
  }

  listSongs(limit: number, offset: number): Page<ReturnType<Store["getSong"]>> {
    const total = (this.db.prepare("SELECT COUNT(*) c FROM songs").get() as { c: number }).c;
    const rows = this.db
      .prepare("SELECT id, name, format, ppq, source_sha256, created_at FROM songs ORDER BY id LIMIT ? OFFSET ?")
      .all(limit, offset) as ReturnType<Store["getSong"]>[];
    return { items: rows, total, limit, offset };
  }

  listVersions(songId: number, limit: number, offset: number): Page<VersionRow> {
    this.getSong(songId);
    const total = (
      this.db.prepare("SELECT COUNT(*) c FROM versions WHERE song_id = ?").get(songId) as { c: number }
    ).c;
    const items = this.db
      .prepare(
        `SELECT id, song_id, version_no, parent_version_id, label, op_type, op_json, created_at
         FROM versions WHERE song_id = ? ORDER BY version_no DESC LIMIT ? OFFSET ?`,
      )
      .all(songId, limit, offset) as VersionRow[];
    return { items, total, limit, offset };
  }

  loadVersion(songId: number, versionId: number): { file: ParsedFile; row: VersionRowFull; nextOrder: () => number } {
    const row = this.db
      .prepare("SELECT * FROM versions WHERE id = ? AND song_id = ?")
      .get(versionId, songId) as VersionRowFull | undefined;
    if (!row) throw new AppError("NOT_FOUND", `Version ${versionId} of song ${songId} not found`);
    const file = parseMidi(Buffer.from(row.bytes));
    let order = row.next_order;
    return { file, row, nextOrder: () => order++ };
  }

  latestVersion(songId: number): VersionRowFull {
    const row = this.db
      .prepare("SELECT * FROM versions WHERE song_id = ? ORDER BY version_no DESC LIMIT 1")
      .get(songId) as VersionRowFull | undefined;
    if (!row) throw new AppError("NOT_FOUND", `No versions for song ${songId}`);
    return row;
  }

  private applyVersion(
    songId: number,
    parentVersionId: number,
    label: string,
    op: OpRecord,
    mutate: (file: ParsedFile, nextOrder: () => number) => void,
  ): VersionRow {
    const ts = this.now().toISOString();
    this.db.exec("BEGIN");
    try {
      const loaded = this.loadVersion(songId, parentVersionId);
      const file = loaded.file;
      mutate(file, loaded.nextOrder);
      const bytes = writeMidi(file);
      const nextOrderVal = this.computeNextOrder(file);
      const maxNo = (
        this.db
          .prepare("SELECT COALESCE(MAX(version_no), 0) m FROM versions WHERE song_id = ?")
          .get(songId) as { m: number }
      ).m;
      const info = this.db
        .prepare(
          `INSERT INTO versions
           (song_id, version_no, parent_version_id, label, op_type, op_json, bytes, next_order, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          songId, maxNo + 1, parentVersionId, label, op.type, JSON.stringify(op.params),
          bytes, nextOrderVal, ts,
        );
      this.db.exec("COMMIT");
      return this.getVersion(Number(info.lastInsertRowid));
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  getVersion(versionId: number): VersionRow {
    const row = this.db
      .prepare(
        `SELECT id, song_id, version_no, parent_version_id, label, op_type, op_json, created_at
         FROM versions WHERE id = ?`,
      )
      .get(versionId) as VersionRow | undefined;
    if (!row) throw new AppError("NOT_FOUND", `Version ${versionId} not found`);
    return row;
  }

  transpose(songId: number, baseVersionId: number | null, opts: TransposeOptions): VersionRow {
    const base = baseVersionId ?? this.latestVersion(songId).id;
    return this.applyVersion(songId, base, `transpose ${opts.semitones}`, {
      type: "transpose",
      params: opts,
    }, (file) => {
      transpose(file, opts);
    });
  }

  setInstrument(
    songId: number,
    baseVersionId: number | null,
    trackIndex: number,
    channel: number,
    program: number,
  ): VersionRow {
    const base = baseVersionId ?? this.latestVersion(songId).id;
    return this.applyVersion(songId, base, `instrument ch${channel}=${program}`, {
      type: "instrument",
      params: { trackIndex, channel, program },
    }, (file, nextOrder) => {
      setInstrument(file, trackIndex, channel, program, nextOrder);
    });
  }

  quantizePreview(songId: number, versionId: number | null, opts: QuantizeOptions): QuantizePreview {
    const v = versionId ?? this.latestVersion(songId).id;
    const { file } = this.loadVersion(songId, v);
    const notes = pairNotes(file);
    return previewQuantize(file, notes, opts);
  }

  quantize(songId: number, baseVersionId: number | null, opts: QuantizeOptions): VersionRow {
    const base = baseVersionId ?? this.latestVersion(songId).id;
    return this.applyVersion(songId, base, `quantize ${opts.gridBeats} beat`, {
      type: "quantize",
      params: opts,
    }, (file) => {
      const preview = previewQuantize(file, pairNotes(file), opts);
      applyQuantize(file, preview);
    });
  }

  exportMidi(songId: number, versionId: number | null, idempotencyKey?: string): {
    batchId: number; bytes: Buffer; sha256: string; reused: boolean;
  } {
    const v = versionId ?? this.latestVersion(songId).id;
    const key = idempotencyKey?.trim() || null;
    this.db.exec("BEGIN");
    try {
      if (key) {
        const existing = this.db
          .prepare("SELECT * FROM export_batches WHERE song_id = ? AND idempotency_key = ?")
          .get(songId, key) as ExportRow | undefined;
        if (existing) {
          this.db.exec("COMMIT");
          return {
            batchId: existing.id, bytes: Buffer.from(existing.bytes),
            sha256: existing.sha256, reused: true,
          };
        }
      }
      const loaded = this.loadVersion(songId, v);
      const bytes = writeMidi(loaded.file);
      const hash = sha(bytes);
      const info = this.db
        .prepare(
          `INSERT INTO export_batches (song_id, version_id, idempotency_key, format, bytes, sha256, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(songId, v, key, loaded.file.format, bytes, hash, this.now().toISOString());
      this.db.exec("COMMIT");
      return { batchId: Number(info.lastInsertRowid), bytes, sha256: hash, reused: false };
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  newIdempotencyToken(): string {
    return randomUUID();
  }
}

export interface VersionRow {
  id: number;
  song_id: number;
  version_no: number;
  parent_version_id: number | null;
  label: string;
  op_type: string;
  op_json: string;
  created_at: string;
}

interface VersionRowFull extends VersionRow {
  bytes: Uint8Array;
  next_order: number;
}

interface ExportRow {
  id: number;
  bytes: Uint8Array;
  sha256: string;
}
