import { rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { generateMidi } from './core/generator.ts'
import { writeMidi } from './core/writer.ts'
import { parseMidi } from './core/parser.ts'
import { TimingMap } from './core/timing.ts'
import { pairNotes } from './core/notes.ts'
import { openDatabase } from './storage/db.ts'
import { Repository } from './storage/repository.ts'
import { SongService } from './service.ts'
import { createHash } from 'node:crypto'

const ROOT = resolve('data/demo')
const DB_PATH = `${ROOT}/demo.sqlite`
const EXPORT_DIR = `${ROOT}/exports`

function assert(cond: boolean, message: string) {
  if (!cond) {
    console.error(`ASSERTION FAILED: ${message}`)
    process.exit(1)
  }
  console.log(`  ok - ${message}`)
}

async function main() {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(EXPORT_DIR, { recursive: true })

  console.log('1) building deterministic synthetic piece (multiple tempo changes, 4/4 -> 3/4, sustain, drums, empty track)')
  const doc = generateMidi({
    ppq: 480,
    tempoChanges: [
      { tick: 0, usPerQuarter: 500_000 },
      { tick: 1920, usPerQuarter: 333_333 },
      { tick: 3840, usPerQuarter: 600_000 },
    ],
    timeSignatures: [
      { tick: 0, numerator: 4, denominatorPower: 2 },
      { tick: 7680, numerator: 3, denominatorPower: 2 },
    ],
    tracks: [
      {
        channel: 0,
        program: 0,
        notes: [
          [0, 480, 60],
          [480, 480, 64],
          [960, 960, 67],
          [1920, 240, 72],
          [7680, 480, 60],
        ],
        sustain: [[960, 2000]],
      },
      {
        channel: 9,
        notes: [
          [0, 10, 36],
          [480, 10, 38],
          [960, 10, 36],
        ],
      },
      { channel: 2, empty: true },
    ],
  })
  const midiPath = `${ROOT}/demo.mid`
  const bytes = writeMidi(doc)
  writeFileSync(midiPath, bytes)
  const reparsed = parseMidi(readFileSync(midiPath))
  assert(reparsed.ppq === 480, 'PPQ preserved after round trip')
  assert(reparsed.tracks.length === 4, 'all four chunks present after round trip')

  console.log('2) timing checks across tempo map')
  const timing = new TimingMap(reparsed)
  assert(timing.tickToMs(1920) === 2000, '1920 ticks (4 quarters) at 120bpm = 2000ms')
  assert(Math.abs(timing.tickToMs(3840) - 3333.332) < 0.01, '3840 ticks lands at ~3333.33ms after accel')
  const back = timing.msToTick(3333.332)
  assert(Math.abs(back - 3840) < 0.001, `ms->tick round trip (${back})`)
  assert(timing.locate(7680).measure === 5, '4 bars of 4/4 elapsed before signature change')
  assert(timing.locate(7680).numerator === 3, 'time signature switches to 3/4 at tick 7680')

  console.log('3) note pairing and sustain')
  const notes = pairNotes(reparsed)
  const sustained = notes.find((n) => n.pitch === 67)!
  assert(sustained.keyDurationTicks === 960, 'key-held duration is 960')
  assert(sustained.soundingDurationTicks === 1040, 'sounding duration extends to pedal-up at 2000')
  const drums = notes.filter((n) => n.channel === 9)
  assert(drums.length === 3, 'three percussion notes paired')

  console.log('4) storage, versions and persistence')
  const db = openDatabase(DB_PATH)
  const repo = new Repository(db)
  const { songId } = repo.importSong('demo-piece', readFileSync(midiPath))
  const t = repo.applyTranspose(songId, { semitones: 2 })
  assert((t.summary as any).moved === 5, 'five melodic notes transposed +2')
  assert((t.summary as any).skippedPercussion === 3, 'three drum notes preserved')
  const tooFar = repo.applyTranspose.bind(null, songId, { semitones: 127 })
  let rejected = false
  try {
    tooFar()
  } catch {
    rejected = true
  }
  assert(rejected, 'pitch out of range rejects the whole edit')
  repo.applyInstrument(songId, { trackIndex: 1, channel: 0, program: 40 })
  const service = new SongService(repo)
  assert(service.tracksOverview(songId)[1].programs[0] === 40, 'instrument applied on latest version')

  console.log('5) idempotent export batch')
  const key = 'run-001'
  const first = repo.exportVersion(songId, 'latest', key, `${EXPORT_DIR}/a.mid`)
  writeFileSync(`${EXPORT_DIR}/a.mid`, first.bytes!)
  const second = repo.exportVersion(songId, 'latest', key, `${EXPORT_DIR}/a.mid`)
  assert(second.reused && second.sha256 === first.sha256, 'repeated export is idempotent')

  console.log('6) old version reproduction')
  const v1 = repo.reproduceVersion(songId, 1)
  const v1Pitches = pairNotes(v1).filter((n) => n.channel === 0).map((n) => n.pitch)
  assert(JSON.stringify(v1Pitches) === JSON.stringify([60, 64, 67, 72, 60]), 'v1 original pitches reproduce exactly')

  db.close()

  console.log('7) reopen database (simulated restart) and verify persistence')
  const db2 = openDatabase(DB_PATH)
  const repo2 = new Repository(db2)
  const { items } = repo2.listVersions(songId, 50, 0)
  assert(items.length === 3, 'three versions survive restart (import, transpose, instrument); failed edit rolled back')
  assert(repo2.getSong(songId).original_sha256 === createHash('sha256').update(bytes).digest('hex'), 'original bytes hash intact')
  db2.close()

  console.log('\nDEMO COMPLETE - artifacts in', ROOT)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
