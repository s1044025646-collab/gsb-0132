import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, existsSync } from 'node:fs'
import type { Server } from 'node:http'
import { resolve } from 'node:path'
import { createApiApp } from '../src/api.ts'
import { generateMidi } from '../src/core/generator.ts'
import { writeMidi } from '../src/core/writer.ts'

const ROOT = resolve('tmp/test-api')
let server: Server
let base: string

before(async () => {
  rmSync(ROOT, { recursive: true, force: true })
  server = createApiApp({ dbPath: `${ROOT}/api.sqlite`, exportDir: `${ROOT}/exports` })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

after(async () => {
  await new Promise((resolve) => server.close(() => resolve(null)))
  rmSync(ROOT, { recursive: true, force: true })
})

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await res.json()
  return { status: res.status, json }
}

test('server binds to loopback only', () => {
  const addr = server.address()
  assert.equal(typeof addr === 'object' && addr && addr.address, '127.0.0.1')
})

test('full API flow: import, inspect, transpose, validation errors, paged notes, export', async () => {
  const midi = generateMidi({
    ppq: 480,
    tempoChanges: [{ tick: 0, usPerQuarter: 500_000 }],
    tracks: [
      { channel: 0, program: 0, notes: [[0, 480, 60], [480, 480, 62], [960, 480, 64]] },
      { channel: 9, notes: [[0, 5, 35]] },
      { channel: 1, empty: true },
    ],
  })

  const bad = await call('POST', '/songs/import', { name: 'x' })
  assert.equal(bad.status, 400)
  assert.equal(bad.json.error.code, 'VALIDATION_FAILED')

  const imported = await call('POST', '/songs/import', {
    name: 'suite',
    midiBase64: writeMidi(midi).toString('base64'),
  })
  assert.equal(imported.status, 201)
  const songId = imported.json.songId

  const tracks = await call('GET', `/songs/${songId}/tracks`)
  assert.equal(tracks.json.tracks[1].noteCount, 3)
  assert.equal(tracks.json.tracks[3].empty, true)

  const paged = await call('GET', `/songs/${songId}/tracks/1?limit=2&offset=0`)
  assert.equal(paged.status, 200)
  assert.equal(paged.json.items.length, 2)
  assert.equal(paged.json.total, 3)

  const badOffset = await call('GET', `/songs/${songId}/tracks/1?limit=2&offset=99`)
  assert.equal(badOffset.status, 400)

  const beat = await call('GET', `/songs/${songId}/beat?measure=1&beat=1`)
  assert.equal(beat.json.tick, 0)
  assert.equal(beat.json.numerator, 4)

  const transposed = await call('POST', `/songs/${songId}/transpose`, { semitones: 12 })
  assert.equal(transposed.status, 201)
  assert.equal(transposed.json.summary.moved, 3)
  assert.equal(transposed.json.summary.skippedPercussion, 1)

  const outOfRange = await call('POST', `/songs/${songId}/transpose`, { semitones: 120 })
  assert.equal(outOfRange.status, 422)
  assert.equal(outOfRange.json.error.code, 'PITCH_OUT_OF_RANGE')

  const q = await call('POST', `/songs/${songId}/quantize-preview`, { subdivisionsPerQuarter: 2 })
  assert.equal(q.status, 200)

  const export1 = await call('POST', `/songs/${songId}/exports`, { idempotencyKey: 'abc' })
  assert.equal(export1.status, 201)
  assert.equal(export1.json.reused, false)
  const export2 = await call('POST', `/songs/${songId}/exports`, { idempotencyKey: 'abc' })
  assert.equal(export2.json.reused, true)
  assert.ok(existsSync(export1.json.path))

  const notFound = await call('GET', '/songs/9999')
  assert.equal(notFound.status, 404)
  assert.equal(notFound.json.error.code, 'RESOURCE_NOT_FOUND')
})

test('SMPTE upload is rejected with a dedicated error code', async () => {
  const header = Buffer.alloc(14)
  header.write('MThd', 0, 'ascii')
  header.writeUInt32BE(6, 4)
  header.writeUInt16BE(0, 8)
  header.writeUInt16BE(1, 10)
  header.writeUInt16BE(0xe748, 12)
  const trackHead = Buffer.from('MTrk')
  const trackLen = Buffer.alloc(4)
  const res = await call('POST', '/songs/import', {
    name: 'smpte',
    midiBase64: Buffer.concat([header, trackHead, trackLen]).toString('base64'),
  })
  assert.equal(res.status, 400)
  assert.equal(res.json.error.code, 'SMPTE_TIME_FORMAT_UNSUPPORTED')
})
