# midi-mapper

Local, backend-only MIDI beat-mapping and orchestration/transposition service.
It parses and regenerates Standard MIDI Files (format 0/1, PPQ), builds a full
tempo/time-signature map, pairs notes (including zero-velocity note-off,
overlaps, hanging notes and sustain pedal), transposes and re-instruments
tracks, previews musical-grid quantization, and keeps an append-only version
history with idempotent export batches.

There is **no web UI, no audio synthesis and no real-device connection**.
Everything (SQLite DB and all temporary files) stays inside this project.

## Stack

- TypeScript run directly by Node (type stripping/transform, no build step).
- Node built-ins only: `node:sqlite`, `node:http`, `node:test`. Zero runtime
  dependencies, so no `npm install` is required.
- Requires Node.js 22+ (built and verified on Node 25).

## Layout

- `src/midi/` — parser, writer, timing engine, note pairing, transforms, quantize, generator.
- `src/db/` — SQLite open + repeatable migrations.
- `src/store.ts` — songs, version chain, source-event archive, idempotent exports.
- `src/api/` — framework-free HTTP API, validation and error codes.
- `src/cli.ts` — command line interface.
- `bin/demo.ts` — repeatable end-to-end demo; `bin/stop.ts` — project-only stop.
- `test/` — automated tests and binary fixtures.

## Setup / test

```bash
node --version            # need >= 22
npm test                  # all automated tests (node:test)
npm run demo              # deterministic end-to-end demo, writes to tmp/demo
```

## Start / stop the API server

```bash
npm start                 # binds 127.0.0.1 only, picks a free port automatically
                          # prints the URL/PID and records them in data/server.json
npm run stop              # stops ONLY the PID this project recorded
```

Override the port with `PORT=4000 npm start` (still loopback-only). The SQLite
database is `data/midi.db` by default; migrations run on every start and are
safe to repeat.

## CLI

```bash
npm run cli -- import --file path/to/song.mid --name "My Song"
npm run cli -- songs
npm run cli -- notes --song 1                 # per-track paired notes
npm run cli -- beat  --song 1 --tick 1920     # tick -> ms + measure/beat
npm run cli -- beat  --song 1 --ms 2000       # ms -> tick (inverse)
npm run cli -- transpose --song 1 --semitones 2      # drums (ch10) kept by default
npm run cli -- instrument --song 1 --track 1 --channel 0 --program 40
npm run cli -- quantize-preview --song 1 --grid 1    # 1 beat grid (musical ticks)
npm run cli -- export --song 1 --out tmp/out.mid --idempotency-key run-1
```

Editing commands print state before and after. `MIDI_DB=tmp/x.db` changes the
database used by the CLI.

## HTTP API

All errors use an envelope `{ "error": CODE, "message": string, "details": any }`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET  | `/health` | liveness |
| GET  | `/songs?limit&offset` | paginated songs |
| POST | `/songs?name=` | import raw MIDI body (or JSON `{dataBase64}`) |
| GET  | `/songs/:id` | song metadata |
| GET  | `/songs/:id/tracks?versionId&trackIndex&channel&limit&offset` | per-track paired notes (paginated) |
| GET  | `/songs/:id/timing?tick=` / `?ms=` | tick<->ms + musical location |
| GET  | `/songs/:id/versions?limit&offset` | version history |
| POST | `/songs/:id/transpose` | `{semitones, channels?, includeDrums?, baseVersionId?}` |
| POST | `/songs/:id/instrument` | `{trackIndex, channel, program, baseVersionId?}` |
| POST | `/songs/:id/quantize/preview` | `{gridBeats, channels?, baseVersionId?}` |
| POST | `/songs/:id/quantize` | commit quantization as a new version |
| POST | `/songs/:id/export` | MIDI bytes; `{versionId?, idempotencyKey?}` |

### Error codes

- `VALIDATION`, `BAD_REQUEST` (400)
- `OUT_OF_RANGE` transposition leaves 0..127 (422)
- `UNSUPPORTED_SMPTE` SMPTE time division explicitly refused (422)
- `UNSUPPORTED_FORMAT` not format 0/1 (422)
- `INVALID_FILE`, `TRUNCATED_FILE` (400)
- `NOT_FOUND` (404), `INTERNAL` (500)

## Semantics notes

- **Time division:** PPQ only; the high-bit SMPTE division is rejected with
  `UNSUPPORTED_SMPTE`.
- **Ordering:** events sort by `(tick, global parse order)`, including across
  tracks; a note-off and note-on at the same tick therefore pair
  deterministically. Tempo changes at an identical tick resolve to earliest
  parse order.
- **Note pairing:** FIFO per track/channel/pitch for overlaps; velocity-zero
  note-on acts as note-off. `keyDurationTicks` is press-to-release while
  `soundingDurationTicks` extends to sustain-pedal (CC64) release.
- **Transposition:** applies to on/off pairs atomically (all-or-nothing range
  check); channel 10 (index 9) drums are preserved by default.
- **Quantization:** the grid is computed from musical beats in tick space from
  the current time signature; it never converts to milliseconds and snaps on a
  fixed-time grid. On and off move together so pairs never cross.
- **Versions/provenance:** each edit adds a version referencing its parent;
  the original imported bytes and every raw source event (including unknown
  meta/sysex events) are retained, so unknown events are never silently lost and
  old versions reproduce byte-for-byte.
- **Idempotency/transactions:** exports with the same key return the same
  batch; failed edits roll back. Clock is injectable in tests for deterministic
  timestamps.

## Fixtures covered by tests

Multiple tempo changes, 4/4 -> 3/4 switching, same-tick off/on, cross-track
tempo conflict at one tick, sustain-pedal extension, overlapping unisons,
empty tracks, running status, hanging notes, sysex preservation, truncated
files, SMPTE rejection, parse/export semantic equality, tick/ms round-trip,
deterministic ordering, transaction rollback, idempotent export and
restart-persistence.
