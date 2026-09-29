import type { ParsedMidi, MidiEvent } from './types.ts'

let ordinalCounter = 0
function channel(
  tick: number,
  status: number,
  data1: number,
  data2: number,
): MidiEvent {
  const high = status >> 4
  const subtype = (
    {
      0x8: 'noteOff',
      0x9: 'noteOn',
      0xb: 'controlChange',
      0xc: 'programChange',
    } as const
  )[high]
  return {
    kind: 'channel',
    tick,
    status,
    subtype: subtype as never,
    data1,
    data2,
    ordinal: ordinalCounter++,
  }
}

function metaEvent(tick: number, metaType: number, data: Buffer): MidiEvent {
  return { kind: 'meta', tick, metaType, data, ordinal: ordinalCounter++ }
}

function tempoMeta(tick: number, usPerQuarter: number): MidiEvent {
  const data = Buffer.alloc(3)
  data[0] = (usPerQuarter >> 16) & 0xff
  data[1] = (usPerQuarter >> 8) & 0xff
  data[2] = usPerQuarter & 0xff
  return { kind: 'meta', tick, metaType: 0x51, data, ordinal: ordinalCounter++ }
}

export interface GeneratorOptions {
  ppq?: number
  tempoChanges?: { tick: number; usPerQuarter: number }[]
  timeSignatures?: { tick: number; numerator: number; denominatorPower: number }[]
  tracks?: Array<{
    channel: number
    program?: number
    notes?: Array<[number, number, number, number?]>
    sustain?: Array<[number, number]>
    empty?: boolean
  }>
}

/** Deterministic synthetic MIDI document used by demo and tests. */
export function generateMidi(opts: GeneratorOptions = {}): ParsedMidi {
  ordinalCounter = 0
  const ppq = opts.ppq ?? 480
  const events: MidiEvent[] = []
  events.push({
    kind: 'meta',
    tick: 0,
    metaType: 0x03,
    data: Buffer.from('TempoMap', 'ascii'),
    ordinal: ordinalCounter++,
  })
  for (const t of opts.tempoChanges ?? []) {
    events.push(tempoMeta(t.tick, t.usPerQuarter))
  }
  for (const ts of opts.timeSignatures ?? []) {
    events.push(metaEvent(ts.tick, 0x58, Buffer.from([ts.numerator, ts.denominatorPower, 24, 8])))
  }
  events.push(metaEvent(0, 0x2f, Buffer.alloc(0)))
  const endOfTempoTrack = events.reduce((max, e) => Math.max(max, e.tick), 0)
  const tempoTrack = { events, endTick: endOfTempoTrack }

  const tracks = [tempoTrack]
  for (const spec of opts.tracks ?? []) {
    const te: MidiEvent[] = []
    let endTick = 0
    if (spec.program !== undefined) {
      te.push(channel(0, 0xc0 | spec.channel, spec.program, 0))
    }
    for (const [start, length, pitch, velocity = 96] of spec.notes ?? []) {
      te.push(channel(start, 0x90 | spec.channel, pitch, velocity))
      te.push(channel(start + length, 0x80 | spec.channel, pitch, 0))
      endTick = Math.max(endTick, start + length)
    }
    for (const [down, up] of spec.sustain ?? []) {
      te.push(channel(down, 0xb0 | spec.channel, 64, 127))
      te.push(channel(up, 0xb0 | spec.channel, 64, 0))
      endTick = Math.max(endTick, up)
    }
    if (spec.empty) endTick = 0
    te.push(metaEvent(0, 0x2f, Buffer.alloc(0)))
    tracks.push({ events: te, endTick })
  }

  return { format: 1, ppq, tracks }
}
