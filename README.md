# MIDI Beat Mapper & Orchestration Backend

A fully local, dependency-free TypeScript/Node.js backend for parsing MIDI,
mapping ticks to musical time across the complete tempo map, pairing notes
(including sustain and dangling notes), transposing/orchestrating, and
exporting standard MIDI files.

- **No web UI, no audio synthesis, no hardware/device connections.**
- Supports Standard MIDI File **format 0 and 1**, **PPQ (ticks-per-quarter)**
  only. Files using **SMPTE time division are explicitly rejected** with error
  code `SMPTE_TIME_FORMAT_UNSUPPORTED`.
- Persistence uses the built-in `node:sqlite` (Node ≥ 22.5; developed on
  Node 25). There are no npm dependencies to install.

## Requirements

- Node.js **22.5 or newer** (uses built-in `node:sqlite` and native
  TypeScript type-stripping). Check with `node --version`.
- Windows / macOS / Linux. All data stays inside this project directory.

## Install

No third-party packages are required:

```powershell
# optional: just confirms npm works; node_modules stays empty
npm install
```

## Run the tests

```powershell
npm test
```

The suite (29 tests) covers:

- VLQ encode/decode, running status, truncated files, bad headers, SMPTE
  rejection, unsupported format, unknown-event preservation on export
- multiple tempo changes and tick↔ms round trips
- cross-track tempo conflicts at the same tick and deterministic ordering
- time signature switching (4/4 → 3/4) and bar/beat math
- same-tick off/on overlap, zero-velocity Note On as Note Off, overlapping
  identical pitches, dangling notes, sustain pedal vs key duration, empty
  tracks
- beat-grid quantization (musical grid, never milliseconds-first)
- paired transposition, out-of-range rejection (atomic, no partial edits),
  percussion (channel 10) protected by default
- transaction rollback, repeatable migrations, restart persistence, injected
  clock, idempotent exports
- HTTP happy paths, validation/error codes, pagination and loopback binding

## Reproducible end-to-end demo

```powershell
npm run demo
```

Generates a deterministic synthetic piece (three tempo changes, 4/4 → 3/4,
melody with sustain pedal, a drum track and an empty track), writes it to
`data/demo/demo.mid`, then asserts timing math, note pairing, versioning,
rollback, idempotent export, old-version reproduction and restart
persistence. Delete `data/demo/` or run `npm run clean` to reset; the demo
always produces the same result.

## Start the API server

```powershell
npm start
```

- Binds **only to `127.0.0.1`** on an **OS-assigned ephemeral port** (set
  `PORT=...` only if you need a fixed port). The chosen URL is printed at
  startup, e.g. `MIDI API listening on http://127.0.0.1:55205`.
- SQLite database: `data/app.sqlite`; exported files: `data/exports/`.

### Stop the server

Press `Ctrl+C` in the terminal running it. The project never manages
  unrelated processes; `npm run clean` only removes this project's `data/`
  and `tmp/` directories.

### API

All request bodies are JSON. Errors use the shape:

```json
{ "error": { "code": "PITCH_OUT_OF_RANGE", "message": "...", "details": null } }
```

| Method | Path | Description |
| --- | --- | --- |
| GET | `/health` | liveness check |
| POST | `/songs/import` | body `{name, midiBase64}`; rejects SMPTE/bad files |
| GET | `/songs?limit=&offset=` | paged songs |
| GET | `/songs/:id` | song metadata |
| GET | `/songs/:id/tracks` | per-track channels, programs, note counts, empty flag |
| GET | `/songs/:id/tracks/:track?limit=&offset=` | paged paired notes with key vs sounding duration |
| GET | `/songs/:id/beat?measure=&beat=&subdivision=` (or `tick=` / `ms=`) | musical position ↔ tick ↔ ms |
| POST | `/songs/:id/transpose` | `{semitones, trackIndex?, channel?, includePercussion?}` |
| POST | `/songs/:id/instrument` | `{trackIndex, channel:0..15, program:0..127}` |
| POST | `/songs/:id/quantize-preview` | `{subdivisionsPerQuarter, strength?, trackIndex?, channel?}` |
| GET | `/songs/:id/versions?limit=&offset=` | edit history |
| POST | `/songs/:id/exports` | `{idempotencyKey, version?}` — repeated keys return the same batch |

Error codes include `VALIDATION_FAILED`, `INVALID_MIDI_FILE`,
`SMPTE_TIME_FORMAT_UNSUPPORTED`, `TRUNCATED_MIDI_FILE`,
`UNKNOWN_MIDI_FORMAT`, `PITCH_OUT_OF_RANGE`, `RESOURCE_NOT_FOUND`,
`STATE_CONFLICT`, `NOT_FOUND`, `INTERNAL_ERROR`.

Example (PowerShell):

```powershell
$b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes('data/demo/demo.mid'))
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:<port>/songs/import' `
  -ContentType 'application/json' -Body (@{ name='demo'; midiBase64=$b64 } | ConvertTo-Json)
```

## CLI

```powershell
npm run cli -- import <file.mid> [name]
npm run cli -- list
npm run cli -- tracks <songId>
npm run cli -- notes <songId> <trackIndex> [limit] [offset]
npm run cli -- beat <songId> --measure 1 --beat 1
npm run cli -- beat <songId> --tick 480
npm run cli -- beat <songId> --ms 500
npm run cli -- transpose <songId> <semitones> [--track N] [--channel N(1-16)] [--percussion]
npm run cli -- instrument <songId> <trackIndex> <channel(1-16)> <program(0-127)>
npm run cli -- quantize <songId> <subdivisionsPerQuarter> [--strength 0..1]
npm run cli -- versions <songId> [limit] [offset]
npm run cli -- export <songId> <version|latest> <idempotencyKey> [out.mid]
```

The CLI uses `data/cli.sqlite` and prints before/after state for transpose,
instrument and export operations.

## Semantics notes

- **Tempo map:** tempo and time-signature meta events from **all tracks** are
  merged with the stable order `(tick, trackIndex, ordinal)`. At the same
  tick the later track/ordinal wins, matching chunk-order stream semantics.
  `tick → ms` and `ms → tick` integrate the complete piecewise tempo map;
  the default tempo before the first event is 120 BPM (500,000 µs/quarter).
- **Note pairing:** Note On/Off and zero-velocity Note On are paired per
  channel+pitch LIFO (handles same-pitch overlaps). Unclosed notes are
  reported as `dangling` (sounding to track end) rather than invented.
  Sustain pedal (CC64 ≥ 64) extends **sounding** duration until pedal-up;
  **key-held duration** is always the on→off span and is reported separately.
- **Transposition:** each matched on/off pair moves together; if any target
  pitch leaves `0..127` the whole operation is rejected before mutation.
  Channel 10 (index 9) percussion is left untouched unless explicitly
  included.
- **Quantization:** the grid is `PPQ / subdivisionsPerQuarter` ticks, i.e. a
  purely musical operation; time is never converted to milliseconds and then
  snapped to fixed wall-clock durations.
- **Versions & provenance:** every edit appends an immutable version that
  stores the full document plus parameters; the original imported bytes and
  SHA-256 are retained. Any older version can be reproduced/exported
  byte-stably. Unknown/unsupported meta and SysEx events are carried through
  editing and export and are never silently dropped.

## Project layout

```
src/
  core/       vlq, parser, writer, meta/tempo maps, timing, notes, quantize, edit, generator
  storage/    sqlite migrations + repository (versions, export batches)
  service.ts  query layer (tracks, notes paging, beat lookup, quantize preview)
  api.ts      loopback HTTP API
  cli.ts      command line interface
  demo.ts     reproducible end-to-end demonstration
test/         node:test suites
scripts/      clean.ts
data/, tmp/   created at runtime; safe to delete via `npm run clean`
```

## Cleanup

```powershell
npm run clean
```

Removes only this project's `data/` and `tmp/` (databases, exports,
demo artifacts, test scratch files).
