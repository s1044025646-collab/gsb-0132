import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateMidi } from '../src/core/generator.ts'
import { transpose, setInstrument } from '../src/core/edit.ts'
import { pairNotes } from '../src/core/notes.ts'
import { planQuantize } from '../src/core/quantize.ts'
import { TimingMap } from '../src/core/timing.ts'
import { AppError } from '../src/core/errors.ts'

test('transpose moves note pairs together and protects drums by default', () => {
  const doc = generateMidi({
    ppq: 480,
    tracks: [
      { channel: 0, notes: [[0, 100, 60]] },
      { channel: 9, notes: [[0, 10, 36]] },
    ],
  })
  const result = transpose(doc, { semitones: 7 })
  assert.equal(result.moved, 1)
  assert.equal(result.skippedPercussion, 1)
  const [melodic, drum] = pairNotes(doc)
  assert.equal(melodic.pitch, 67)
  assert.equal(melodic.offEvent!.data1, 67)
  assert.equal(drum.pitch, 36)
})

test('transpose rejects atomically when any pitch leaves 0..127', () => {
  const doc = generateMidi({
    ppq: 480,
    tracks: [{ channel: 0, notes: [[0, 100, 60], [100, 100, 65]] }],
  })
  assert.throws(
    () => transpose(doc, { semitones: 70 }),
    (e: AppError) => e.code === 'PITCH_OUT_OF_RANGE',
  )
  // no mutation occurred
  assert.deepEqual(pairNotes(doc).map((n) => n.pitch), [60, 65])
})

test('instrument set inserts then replaces program change', () => {
  const doc = generateMidi({ ppq: 480, tracks: [{ channel: 0, notes: [[0, 10, 60]] }] })
  const first = setInstrument(doc, 1, 0, 40)
  assert.equal(first.inserted, true)
  const second = setInstrument(doc, 1, 0, 41)
  assert.equal(second.inserted, false)
  const changes = doc.tracks[1].events.filter(
    (e) => e.kind === 'channel' && e.subtype === 'programChange',
  )
  assert.equal(changes.length, 1)
  assert.equal((changes[0] as any).data1, 41)
})

test('quantize plan works on the beat grid, never via milliseconds', () => {
  const doc = generateMidi({
    ppq: 480,
    tempoChanges: [{ tick: 0, usPerQuarter: 500_000 }, { tick: 100, usPerQuarter: 100_000 }],
    tracks: [{ channel: 0, notes: [[5, 472, 60]] }],
  })
  const timing = new TimingMap(doc)
  const plan = planQuantize(timing, pairNotes(doc), { subdivisionsPerQuarter: 1 })
  assert.equal(plan.items.length, 1)
  assert.equal(plan.items[0].newOnTick, 0)
  assert.equal(plan.items[0].newOffTick, 480)
})

test('non-integral grid for PPQ is rejected', () => {
  const doc = generateMidi({ ppq: 480, tracks: [{ channel: 0, notes: [[0, 10, 60]] }] })
  assert.throws(() =>
    planQuantize(new TimingMap(doc), pairNotes(doc), { subdivisionsPerQuarter: 7 }),
  )
})
