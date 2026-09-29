import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { AppError, ErrorCodes } from '../core/errors.ts'
import { transpose, setInstrument } from '../core/edit.ts'
import { parseMidi } from '../core/parser.ts'
import { writeMidi } from '../core/writer.ts'
import type { ParsedMidi } from '../core/types.ts'

export type Clock = () => number

interface SongRow {
  id: number
  name: string
  midi_format: number
  ppq: number
  original_sha256: string
  created_at_ms: number
}

interface VersionRow {
  id: number
  song_id: number
  version_no: number
  kind: string
  params_json: string
  document_json: string
  parent_version_id: number | null
  created_at_ms: number
}

function revive(buf: unknown): Buffer {
  return Buffer.from(buf as Uint8Array)
}

/** Deep clone a parsed document through JSON (Buffers round-trip via reviver). */
export function deserializeDocument(json: string): ParsedMidi {
  return JSON.parse(json, (key, value) => {
    if (value && typeof value === 'object' && value.type === 'Buffer' && Array.isArray(value.data)) {
      return Buffer.from(value.data)
    }
    return value
  }) as ParsedMidi
}

export class Repository {
  private readonly db: DatabaseSync
  private readonly clock: Clock

  constructor(db: DatabaseSync, clock: Clock = () => Date.now()) {
    this.db = db
    this.clock = clock
  }

 importSong(name: string, bytes: Uint8Array): { songId: number; versionId: number } {
    const buf = Buffer.from(bytes)
    const parsed = parseMidi(buf)
    const sha = createHash('sha256').update(buf).digest('hex')
    const tx = this.db
    tx.exec('BEGIN IMMEDIATE')
    try {
      const res = this.db
        .prepare(
          'INSERT INTO songs (name, midi_format, ppq, original_sha256, original_bytes, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(name, parsed.format, parsed.ppq, sha, buf, this.clock())
      const songId = Number(res.lastInsertRowid)
      const versionId = this.addVersion(songId, 'import', {}, parsed)
      this.db.exec('COMMIT')
      return { songId, versionId }
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  listSongs(limit: number, offset: number): { items: SongRow[]; total: number } {
    const total = (this.db.prepare('SELECT COUNT(*) AS c FROM songs').get() as { c: number }).c
    const items = this.db
      .prepare('SELECT id, name, midi_format, ppq, original_sha256, created_at_ms FROM songs ORDER BY id LIMIT ? OFFSET ?')
      .all(limit, offset) as SongRow[]
    return { items, total }
  }

  getSong(songId: number): SongRow {
    const row = this.db
      .prepare('SELECT id, name, midi_format, ppq, original_sha256, created_at_ms FROM songs WHERE id = ?')
      .get(songId) as SongRow | undefined
    if (!row) throw new AppError(ErrorCodes.NOT_FOUND, `song ${songId} not found`, 404)
    return row
  }

  getOriginalBytes(songId: number): Buffer {
    const row = this.db
      .prepare('SELECT original_bytes AS b FROM songs WHERE id = ?')
      .get(songId) as { b: Uint8Array } | undefined
    if (!row) throw new AppError(ErrorCodes.NOT_FOUND, `song ${songId} not found`, 404)
    return revive(row.b)
  }

  listVersions(songId: number, limit: number, offset: number): { items: VersionRow[]; total: number } {
    this.getSong(songId)
    const total = (
      this.db.prepare('SELECT COUNT(*) AS c FROM versions WHERE song_id = ?').get(songId) as { c: number }
    ).c
    const items = this.db
      .prepare(
        'SELECT id, song_id, version_no, kind, params_json, parent_version_id, created_at_ms FROM versions WHERE song_id = ? ORDER BY version_no DESC LIMIT ? OFFSET ?',
      )
      .all(songId, limit, offset) as VersionRow[]
    return { items, total }
  }

  getLatestVersion(songId: number): VersionRow {
    this.getSong(songId)
    const row = this.db
      .prepare('SELECT * FROM versions WHERE song_id = ? ORDER BY version_no DESC LIMIT 1')
      .get(songId) as VersionRow | undefined
    if (!row) throw new AppError(ErrorCodes.NOT_FOUND, `no versions for song ${songId}`, 404)
    return row
  }

  getVersion(songId: number, versionNo: number): VersionRow {
    const row = this.db
      .prepare('SELECT * FROM versions WHERE song_id = ? AND version_no = ?')
      .get(songId, versionNo) as VersionRow | undefined
    if (!row) {
      throw new AppError(ErrorCodes.NOT_FOUND, `version ${versionNo} of song ${songId} not found`, 404)
    }
    return row
  }

  documentFor(version: VersionRow): ParsedMidi {
    return deserializeDocument(version.document_json)
  }

  /** Reproduce the exact document of any older version. */
  reproduceVersion(songId: number, versionNo: number): ParsedMidi {
    return this.documentFor(this.getVersion(songId, versionNo))
  }

  editSong(
    songId: number,
    kind: 'transpose' | 'instrument',
    apply: (doc: ParsedMidi) => unknown,
    params: Record<string, unknown>,
  ): { versionId: number; versionNo: number; summary: unknown } {
    const latest = this.getLatestVersion(songId)
    const doc = this.documentFor(latest)
    const summary = apply(doc)
    const versionId = this.addVersion(songId, kind, params, doc, latest.id)
    return { versionId, versionNo: this.versionNoOf(versionId), summary }
  }

  applyTranspose(songId: number, params: {
    semitones: number
    trackIndex?: number
    channel?: number
    includePercussion?: boolean
  }) {
    return this.editSong(songId, 'transpose', (doc) => transpose(doc, params), params)
  }

  applyInstrument(songId: number, params: {
    trackIndex: number
    channel: number
    program: number
  }) {
    return this.editSong(songId, 'instrument', (doc) => {
      const result = setInstrument(doc, params.trackIndex, params.channel, params.program)
      return { inserted: result.inserted }
    }, params)
  }

  /** Idempotent export: same key returns the previous batch without rewriting. */
  exportVersion(
    songId: number,
    versionNo: number | 'latest',
    idempotencyKey: string,
    filePath: string,
  ): { versionId: number; path: string; sha256: string; byteCount: number; reused: boolean } {
    const existing = this.db
      .prepare('SELECT * FROM export_batches WHERE idempotency_key = ?')
      .get(idempotencyKey) as
      | { song_id: number; version_id: number; file_path: string; sha256: string; byte_count: number }
      | undefined
    if (existing) {
      if (existing.song_id !== songId) {
        throw new AppError(
          ErrorCodes.CONFLICT,
          'idempotency key already used for a different song',
          409,
        )
      }
      return {
        versionId: existing.version_id,
        path: existing.file_path,
        sha256: existing.sha256,
        byteCount: existing.byte_count,
        reused: true,
      }
    }

    const version =
      versionNo === 'latest' ? this.getLatestVersion(songId) : this.getVersion(songId, versionNo)
    const doc = this.documentFor(version)
    const bytes = writeMidi(doc)
    const sha = createHash('sha256').update(bytes).digest('hex')
    this.db
      .prepare(
        'INSERT INTO export_batches (idempotency_key, song_id, version_id, file_path, sha256, byte_count, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(idempotencyKey, songId, version.id, filePath, sha, bytes.length, this.clock())
    return {
      versionId: version.id,
      path: filePath,
      sha256: sha,
      byteCount: bytes.length,
      reused: false,
      bytes,
    }
  }

  private addVersion(
    songId: number,
    kind: string,
    params: Record<string, unknown>,
    doc: ParsedMidi,
    parentId?: number | null,
  ): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(version_no), 0) + 1 AS next FROM versions WHERE song_id = ?')
      .get(songId) as { next: number }
    const res = this.db
      .prepare(
        'INSERT INTO versions (song_id, version_no, kind, params_json, document_json, parent_version_id, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        songId,
        row.next,
        kind,
        JSON.stringify(params),
        JSON.stringify(doc),
        parentId ?? null,
        this.clock(),
      )
    return Number(res.lastInsertRowid)
  }

  private versionNoOf(versionId: number): number {
    const row = this.db
      .prepare('SELECT version_no FROM versions WHERE id = ?')
      .get(versionId) as { version_no: number }
    return row.version_no
  }
}
