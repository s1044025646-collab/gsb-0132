import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readVLQ, writeVLQ } from '../src/core/vlq.ts'
import { parseMidi } from '../src/core/parser.ts'
import { writeMidi } from '../src/core/writer.ts'
import { AppError } from '../src/core/errors.ts'
import { generateMidi } from '../src/core/generator.ts'

test('VLQ encode/decode round trips known values', () => {
  for (const v of [0, 1, 64, 127, 128, 8192, 0x0fffffff]) {
    assert.equal(readVLQ(writeVLQ(v), 0).value, v)
  }
  assert.deepEqual(Array.from(writeVLQ(0x80)), [0x81, 0x00])
})

test('truncated VLQ is rejected', () => {
  assert.throws(() => readVLQ(Buffer.from([0x81]), 0), AppError)
})

function header(format: number, ntrks: number, division: number): Buffer {
  const b = Buffer.alloc(14)
  b.write('MThd', 0, 'ascii')
  b.writeUInt32BE(6, 4)
  b.writeUInt16BE(format, 8)
  b.writeUInt16BE(ntrks, 10)
  b.writeUInt16BE(division, 12)
  return b
}

test('SMPTE division is explicitly rejected', () => {
  const buf = Buffer.concat([header(0, 1, 0xe748), Buffer.from('MTrk'), Buffer.alloc(10, 0)])
  assert.throws(() => parseMidi(buf), (e: AppError) => e.code === 'SMPTE_TIME_FORMAT_UNSUPPORTED')
})

test('formats other than 0/1 are rejected', () => {
  const track = Buffer.concat([Buffer.from('MTrk'), Buffer.alloc(8, 0)])
  track.writeUInt32BE(0, 4)
  const buf = Buffer.concat([header(2, 1, 480), track])
  assert.throws(() => parseMidi(buf), (e: AppError) => e.code === 'UNKNOWN_MIDI_FORMAT')
})

test('truncated track chunk is detected', () => {
  const buf = Buffer.concat([header(0, 1, 480), Buffer.from('MTrk'), Buffer.from([0, 0, 0, 20, 0x90])])
  assert.throws(() => parseMidi(buf), (e: AppError) => e.code === 'TRUNCATED_MIDI_FILE')
})

test('running status resolves repeated channel messages', () => {
  // delta=0 NoteOn 60 100, delta=10 (running) 62 100, delta=0 NoteOff 60
  const body = Buffer.from([
    0x00, 0x90, 60, 100,
    0x0a, 62, 100,
    0x00, 0x80, 60, 0,
  ])
  const head = Buffer.from('MTrk')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(body.length, 0)
  const buf = Buffer.concat([header(0, 1, 480), head, len, body])
  const doc = parseMidi(buf)
  const evs = doc.tracks[0].events
  assert.equal(evs.length, 3)
  assert.equal(evs[1].status, 0x90)
  assert.equal(evs[1].tick, 10)
  assert.equal(evs[1].data1, 62)
})

test('data byte without running status is rejected', () => {
  const body = Buffer.from([0x00, 60, 100])
  const len = Buffer.alloc(4)
  len.writeUInt32BE(body.length, 0)
  const buf = Buffer.concat([header(0, 1, 480), Buffer.from('MTrk'), len, body])
  assert.throws(() => parseMidi(buf), (e: AppError) => e.code === 'INVALID_MIDI_FILE')
})

test('generated document survives a write/parse cycle semantically', () => {
  const doc = generateMidi({
    ppq: 120,
    tempoChanges: [{ tick: 0, usPerQuarter: 400_000 }],
    tracks: [{ channel: 0, program: 5, notes: [[0, 60, 60], [60, 60, 62]] }],
  })
  const again = parseMidi(writeMidi(doc))
  assert.equal(again.ppq, 120)
  assert.equal(again.tracks.length, doc.tracks.length)
  const noteOns = again.tracks[1].events.filter((e) => e.kind === 'channel' && e.subtype === 'noteOn')
  assert.equal(noteOns.length, 2)
})

test('unknown meta and sysex events are preserved through export', () => {
  const doc = generateMidi({ tracks: [{ channel: 0, notes: [[0, 30, 60]] }] })
  doc.tracks[1].events.push({
    kind: 'meta',
    tick: 5,
    metaType: 0x7d,
    data: Buffer.from([1, 2, 3]),
    ordinal: 9000,
  })
  const again = parseMidi(writeMidi(doc))
  const custom = again.tracks[1].events.find((e) => e.kind === 'meta' && e.metaType === 0x7d)
  assert.ok(custom && custom.kind === 'meta')
  assert.deepEqual(Array.from(custom.data), [1, 2, 3])
})
