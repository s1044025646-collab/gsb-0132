import { writeVLQ } from './vlq.ts'
import type { MidiEvent, ParsedMidi } from './types.ts'

/**
 * Serialize a document back to a standard MIDI file.
 * Events must carry their original `ordinal`; events at the same tick are
 * emitted in ascending ordinal order so output is deterministic.
 */
export function writeMidi(doc: ParsedMidi): Buffer {
  const header = Buffer.alloc(14)
  header.write('MThd', 0, 'ascii')
  header.writeUInt32BE(6, 4)
  header.writeUInt16BE(doc.format, 8)
  header.writeUInt16BE(doc.tracks.length, 10)
  header.writeUInt16BE(doc.ppq, 12)

  const chunks: Buffer[] = [header]
  for (const track of doc.tracks) {
    chunks.push(writeTrack(track.events))
  }
  return Buffer.concat(chunks)
}

function writeTrack(events: MidiEvent[]): Buffer {
  const ordered = [...events].sort((a, b) => a.tick - b.tick || a.ordinal - b.ordinal)
  const body: Buffer[] = []
  let lastTick = 0
  for (const ev of ordered) {
    body.push(writeVLQ(ev.tick - lastTick))
    lastTick = ev.tick
    if (ev.kind === 'channel') {
      body.push(Buffer.from([ev.status, ev.data1, ...(needsSecondDataByte(ev.status) ? [ev.data2] : [])]))
    } else if (ev.kind === 'meta') {
      body.push(Buffer.from([0xff, ev.metaType]))
      body.push(writeVLQ(ev.data.length))
      body.push(ev.data)
    } else {
      body.push(writeVLQ(ev.data.length))
      body.push(ev.data)
    }
  }
  const payload = Buffer.concat(body)
  const head = Buffer.alloc(8)
  head.write('MTrk', 0, 'ascii')
  head.writeUInt32BE(payload.length, 4)
  return Buffer.concat([head, payload])
}

function needsSecondDataByte(status: number): boolean {
  const high = status >> 4
  return high !== 0xc && high !== 0xd
}
