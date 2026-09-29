import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, mkdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { openDatabase } from '../src/storage/db.ts'
import { Repository } from '../src/storage/repository.ts'
import { generateMidi } from '../src/core/generator.ts'
import { writeMidi } from '../src/core/writer.ts'
import { pairNotes } from '../src/core/notes.ts'
import { AppError } from '../src/core/errors.ts'

const TMP_BASE = resolve('tmp/test-storage')
let clock = 1000
let TMP = TMP_BASE

beforeEach(() => {
  TMP = resolve(TMP_BASE, `run-${Math.random().toString(36).slice(2)}`)
  mkdirSync(TMP, { recursive: true })
  clock = 1000
})

function repoAt(file: string) {
  return new Repository(openDatabase(`${TMP}/${file}`), () => clock)
}

test('versions append, failures roll back, and state survives restart', () => {
  const doc = generateMidi({ ppq: 480, tracks: [{ channel: 0, notes: [[0, 100, 60]] }] })
  const bytes = writeMidi(doc)

  const dbPath = `${TMP}/a.sqlite`
  let repo = new Repository(openDatabase(dbPath), () => clock)
  const { songId } = repo.importSong('x', bytes)
  clock = 2000
  repo.applyTranspose(songId, { semitones: 5 })
  assert.throws(
    () => repo.applyTranspose(songId, { semitones: 200 }),
    (e: AppError) => e.code === 'VALIDATION_FAILED' || e.code === 'PITCH_OUT_OF_RANGE',
  )
  const before = repo.listVersions(songId, 10, 0).total
  assert.equal(before, 2)
  repo.db.close()

  repo = new Repository(openDatabase(dbPath), () => clock)
  assert.equal(repo.listVersions(songId, 10, 0).total, 2)
  const v1Pitches = pairNotes(repo.reproduceVersion(songId, 1)).map((n) => n.pitch)
  const v2Pitches = pairNotes(repo.reproduceVersion(songId, 2)).map((n) => n.pitch)
  assert.deepEqual(v1Pitches, [60])
  assert.deepEqual(v2Pitches, [65])
  repo.db.close()
})

test('migration is repeatable on an existing database', () => {
  const db = openDatabase(`${TMP}/b.sqlite`)
  assert.doesNotThrow(() => openDatabase(`${TMP}/b.sqlite`))
  db.close()
})

test('export batches are idempotent by key', () => {
  const repo = repoAt('c.sqlite')
  const { songId } = repo.importSong('x', writeMidi(generateMidi({ tracks: [{ channel: 0, notes: [[0, 1, 1]] }] })))
  const first = repo.exportVersion(songId, 'latest', 'k1', `${TMP}/x.mid`)
  const second = repo.exportVersion(songId, 'latest', 'k1', `${TMP}/x.mid`)
  assert.equal(first.reused, false)
  assert.equal(second.reused, true)
  assert.equal(second.sha256, first.sha256)
})

test('injected clock timestamps versions deterministically', () => {
  const repo = repoAt('d.sqlite')
  const { songId } = repo.importSong('x', writeMidi(generateMidi({ tracks: [{ channel: 0, notes: [[0, 1, 1]] }] })))
  const v1 = repo.getVersion(songId, 1)
  assert.equal(v1.created_at_ms, 1000)
  clock = 5000
  repo.applyTranspose(songId, { semitones: 1 })
  assert.equal(repo.getVersion(songId, 2).created_at_ms, 5000)
})

test('original bytes are retained for source provenance', () => {
  const repo = repoAt('e.sqlite')
  const bytes = writeMidi(generateMidi())
  const { songId } = repo.importSong('x', bytes)
  assert.ok(repo.getOriginalBytes(songId).equals(bytes))
})
