import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateMidi } from '../src/core/generator.ts'
import { TimingMap } from '../src/core/timing.ts'
import { pairNotes } from '../src/core/notes.ts'

test('tick/ms conversion across multiple tempo changes is exact and invertible', () => {
  const doc = generateMidi({
    ppq: 480,
    tempoChanges: [
      { tick: 0, usPerQuarter: 500_000 },
      { tick: 480, usPerQuarter: 250_000 },
      { tick: 960, usPerQuarter: 1_000_000 },
    ],
    tracks: [{ channel: 0, notes: [[0, 1440, 60]] }],
  })
  const t = new TimingMap(doc)
  assert.equal(t.tickToMs(0), 0)
  assert.equal(t.tickToMs(480), 500)
  assert.equal(t.tickToMs(960), 750)
  assert.equal(t.tickToMs(1440), 1750)
  for (const ms of [0, 250, 500, 750, 1000, 1750]) {
    assert.ok(Math.abs(t.tickToMs(t.msToTick(ms)) - ms) < 1e-9, `roundtrip ${ms}`)
  }
})

test('cross-track tempo events at the same tick resolve in track order', () => {
  const doc = generateMidi({
    ppq: 480,
    tempoChanges: [],
    tracks: [
      { channel: 0, notes: [[0, 480, 60]] },
      { channel: 1, notes: [[0, 480, 60]] },
    ],
  })
  // inject conflicting tempos at tick 480: track 1 (index 1) and track 2 (index 2)
  const tempo = (us: number) => {
    const d = Buffer.alloc(3)
    d[2] = us & 0xff
    d[1] = (us >> 8) & 0xff
    d[0] = (us >> 16) & 0xff
    return d
  }
  doc.tracks[1].events.push({ kind: 'meta', tick: 480, metaType: 0x51, data: tempo(400_000), ordinal: 5000 })
  doc.tracks[2].events.push({ kind: 'meta', tick: 480, metaType: 0x51, data: tempo(200_000), ordinal: 5000 })
  const t = new TimingMap(doc)
  assert.equal(t.usPerQuarterAt(480), 200_000)
  // deterministic: same input -> same sorted order
  assert.deepEqual(
    t.tempo.map((p) => [p.trackIndex, p.usPerQuarter]),
    [
      [1, 400_000],
      [2, 200_000],
    ],
  )
})

test('beat location handles time signature change from 4/4 to 3/4', () => {
  const doc = generateMidi({
    ppq: 480,
    timeSignatures: [
      { tick: 0, numerator: 4, denominatorPower: 2 },
      { tick: 1920, numerator: 3, denominatorPower: 2 },
    ],
    tracks: [{ channel: 0, notes: [[0, 2400, 60]] }],
  })
  const t = new TimingMap(doc)
  assert.deepEqual([t.locate(0).measure, t.locate(0).beat], [1, 1])
  assert.deepEqual([t.locate(1920).measure, t.locate(1920).beat], [2, 1])
  assert.equal(t.locate(1920).numerator, 3)
  assert.equal(t.musicalToTick(2, 1), 1920)
  assert.equal(t.musicalToTick(3, 1), 1920 + 3 * 480)
})

test('note pairing handles same-tick off/on overlap and zero-velocity note on', () => {
  const doc = generateMidi({
    ppq: 480,
    tracks: [
      {
        channel: 0,
        notes: [
          [0, 480, 60],
          [480, 480, 60], // reopen same pitch exactly at prior off tick
        ],
      },
    ],
  })
  // convert first NoteOff to zero-velocity Note On
  const off = doc.tracks[1].events.find(
    (e) => e.kind === 'channel' && e.subtype === 'noteOff' && e.tick === 480,
  )!
  off.status = 0x90
  off.subtype = 'noteOn'
  off.data2 = 0
  const notes = pairNotes(doc)
  assert.equal(notes.length, 2)
  assert.equal(notes[0].offTick, 480)
  assert.equal(notes[1].onTick, 480)
})

test('dangling notes are reported rather than invented', () => {
  const doc = generateMidi({ ppq: 480, tracks: [{ channel: 0, notes: [[0, 240, 60]] }] })
  // remove the note-off
  const track = doc.tracks[1]
  track.events = track.events.filter((e) => !(e.kind === 'channel' && e.subtype === 'noteOff'))
  track.endTick = 240
  const notes = pairNotes(doc)
  assert.equal(notes.length, 1)
  assert.equal(notes[0].dangling, true)
  assert.equal(notes[0].soundingDurationTicks, 240)
})

test('sustain pedal extends sounding duration but not key duration', () => {
  const doc = generateMidi({
    ppq: 480,
    tracks: [
      {
        channel: 0,
        notes: [[100, 200, 64]],
        sustain: [[0, 600]],
      },
    ],
  })
  const [note] = pairNotes(doc)
  assert.equal(note.keyDurationTicks, 200)
  assert.equal(note.soundingDurationTicks, 500)
})

test('empty tracks yield no notes', () => {
  const doc = generateMidi({ ppq: 480, tracks: [{ channel: 3, empty: true }] })
  assert.equal(pairNotes(doc).length, 0)
})
