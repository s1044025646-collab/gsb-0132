#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { AppError } from './core/errors.ts'
import { openDatabase } from './storage/db.ts'
import { Repository } from './storage/repository.ts'
import { SongService } from './service.ts'

const DATA_DIR = resolve('data')
const DB_PATH = resolve(DATA_DIR, 'cli.sqlite')
const EXPORT_DIR = resolve(DATA_DIR, 'exports')

function usage() {
  console.log(`Usage:
  npm run cli -- import <file.mid> [name]
  npm run cli -- list
  npm run cli -- tracks <songId>
  npm run cli -- notes <songId> <trackIndex> [limit] [offset]
  npm run cli -- beat <songId> --measure 1 --beat 1
  npm run cli -- beat <songId> --tick 480
  npm run cli -- beat <songId> --ms 500
  npm run cli -- transpose <songId> <semitones> [--track N] [--channel N] [--percussion]
  npm run cli -- instrument <songId> <trackIndex> <channel(1-16)> <program(0-127)>
  npm run cli -- quantize <songId> <subdivisionsPerQuarter> [--strength 0..1]
  npm run cli -- versions <songId> [limit] [offset]
  npm run cli -- export <songId> <version|latest> <idempotencyKey> [out.mid]
`)
}

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

function printBeforeAfter(label: string, before: unknown, after: unknown) {
  console.log(`\n${label}`)
  console.log('  before:', JSON.stringify(before))
  console.log('  after :', JSON.stringify(after))
}

async function main() {
  mkdirSync(EXPORT_DIR, { recursive: true })
  const db = openDatabase(DB_PATH)
  const repo = new Repository(db)
  const service = new SongService(repo)
  const [command, ...rest] = process.argv.slice(2)

  try {
    switch (command) {
      case 'import': {
        const [file, name] = rest
        if (!file) throw new AppError('VALIDATION_FAILED', 'file path required')
        const bytes = readFileSync(resolve(file))
        console.log(`importing ${file} (${bytes.length} bytes)...`)
        const result = repo.importSong(name ?? file, bytes)
        console.log(`created song ${result.songId}, version ${result.versionId}`)
        break
      }
      case 'list': {
        const { items, total } = repo.listSongs(50, 0)
        console.log(`songs (${total}):`)
        for (const s of items) {
          console.log(`  #${s.id} ${s.name}  format=${s.midi_format} ppq=${s.ppq}`)
        }
        break
      }
      case 'tracks': {
        const songId = Number(rest[0])
        const tracks = service.tracksOverview(songId)
        console.log(`song ${songId} tracks (${tracks.length}):`)
        for (const t of tracks) {
          console.log(
            `  [${t.trackIndex}] ${t.name} notes=${t.noteCount} channels=[${t.channels.map((c) => c + 1).join(',')}] programs=${JSON.stringify(t.programs)} end=${t.endTick}t/${t.endMs.toFixed(2)}ms${t.empty ? ' EMPTY' : ''}`,
          )
        }
        break
      }
      case 'notes': {
        const [songIdRaw, trackRaw, limitRaw = '20', offsetRaw = '0'] = rest
        const page = service.notesForTrack(
          Number(songIdRaw),
          Number(trackRaw),
          Number(limitRaw),
          Number(offsetRaw),
        )
        console.log(
          `track ${page.trackIndex}: ${page.total} notes (showing ${page.items.length}, offset ${page.offset}):`,
        )
        for (const n of page.items) {
          console.log(
            `  ch${n.channel}${n.percussion ? '(drums)' : ''} pitch=${n.pitch} vel=${n.velocity} ${n.onTick}t->${n.offTick}t (${n.onMs.toFixed(2)}ms) key=${n.keyDurationTicks}t sound=${n.soundingDurationTicks}t${n.extendedBySustainTicks ? ` +sustain${n.extendedBySustainTicks}t` : ''}${n.dangling ? ' DANGLING' : ''} @${n.beatOn.measure}:${n.beatOn.beat}`,
          )
        }
        break
      }
      case 'beat': {
        const songId = Number(rest[0])
        const result = service.beatAt(songId, {
          measure: option(rest, '--measure'),
          beat: option(rest, '--beat'),
          tick: option(rest, '--tick'),
          ms: option(rest, '--ms'),
          subdivision: option(rest, '--subdivision'),
        } as never)
        console.log(JSON.stringify(result, null, 2))
        break
      }
      case 'transpose': {
        const [songIdRaw, semisRaw] = rest
        const songId = Number(songIdRaw)
        const semitones = Number(semisRaw)
        const before = service
          .tracksOverview(songId)
          .map((t) => ({ track: t.trackIndex, notes: t.noteCount }))
        const result = repo.applyTranspose(songId, {
          semitones,
          trackIndex: option(rest, '--track') !== undefined ? Number(option(rest, '--track')) : undefined,
          channel:
            option(rest, '--channel') !== undefined
              ? Number(option(rest, '--channel')) - 1
              : undefined,
          includePercussion: rest.includes('--percussion'),
        })
        printBeforeAfter(
          `transpose ${semitones} semitones -> version ${result.versionNo} (moved ${(result.summary as any).moved}, drums skipped ${(result.summary as any).skippedPercussion})`,
          before,
          service.tracksOverview(songId).map((t) => ({ track: t.trackIndex, notes: t.noteCount })),
        )
        break
      }
      case 'instrument': {
        const [songIdRaw, trackRaw, channelRaw, programRaw] = rest
        const songId = Number(songIdRaw)
        const trackIndex = Number(trackRaw)
        const channel = Number(channelRaw) - 1
        const program = Number(programRaw)
        const before = service.tracksOverview(songId)[trackIndex].programs
        const result = repo.applyInstrument(songId, { trackIndex, channel, program })
        printBeforeAfter(
          `set program ${program} on ch${channel + 1} of track ${trackIndex} -> version ${result.versionNo}`,
          before,
          service.tracksOverview(songId)[trackIndex].programs,
        )
        break
      }
      case 'quantize': {
        const [songIdRaw, subRaw] = rest
        const strength = option(rest, '--strength') !== undefined ? Number(option(rest, '--strength')) : undefined
        const plan = service.quantizePreview(Number(songIdRaw), Number(subRaw), { strength })
        console.log(`quantize preview: ${plan.items.length} notes would move (1/${plan.subdivisionsPerQuarter} grid)`)
        for (const item of plan.items.slice(0, 20)) {
          console.log(
            `  track${item.note.trackIndex} ch${item.note.channel + 1} pitch=${item.note.pitch}: on ${item.oldOnTick}->${item.newOnTick}, off ${item.oldOffTick}->${item.newOffTick}`,
          )
        }
        break
      }
      case 'versions': {
        const [songIdRaw, limitRaw = '20', offsetRaw = '0'] = rest
        const { items, total } = repo.listVersions(Number(songIdRaw), Number(limitRaw), Number(offsetRaw))
        console.log(`versions (${total}):`)
        for (const v of items) {
          console.log(`  v${v.version_no} ${v.kind} ${v.params_json}`)
        }
        break
      }
      case 'export': {
        const [songIdRaw, versionRaw, key, outRaw] = rest
        if (!key) throw new AppError('VALIDATION_FAILED', 'idempotency key required')
        const songId = Number(songIdRaw)
        const versionNo = versionRaw === 'latest' ? 'latest' : Number(versionRaw)
        const outPath = resolve(outRaw ?? `${EXPORT_DIR}/song${songId}-v${versionNo}-${key}.mid`)
        const before = { path: outPath, note: 'file not yet written by this key' }
        const result = repo.exportVersion(songId, versionNo as never, key, outPath)
        if (!result.reused) writeFileSync(outPath, result.bytes!)
        printBeforeAfter(
          `export ${result.reused ? 'REUSED (idempotent)' : 'written'} -> ${outPath}`,
          before,
          { sha256: result.sha256, bytes: result.byteCount, reused: result.reused },
        )
        break
      }
      default:
        usage()
        if (command) process.exitCode = 1
    }
  } catch (err) {
    if (err instanceof AppError) {
      console.error(`error [${err.code}]: ${err.message}`)
      if (err.details) console.error(JSON.stringify(err.details))
    } else {
      console.error(err)
    }
    process.exitCode = 1
  } finally {
    db.close()
  }
}

main()
