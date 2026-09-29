import { AppError, ErrorCodes } from './errors.ts'
import { readVLQ } from './vlq.ts'
import type {
  ChannelEvent,
  ChannelEventKind,
  MidiEvent,
  ParsedMidi,
  RawTrack,
  SysExEvent,
  MetaEvent,
} from './types.ts'

const HEADER = Buffer.from('MThd')
const TRACK_MAGIC = Buffer.from('MTrk')

const CHANNEL_DATA_LEN: Record<number, number> = {
  0x8: 2,
  0x9: 2,
  0xa: 2,
  0xb: 2,
  0xc: 1,
  0xd: 1,
  0xe: 2,
}

const SUBTYPE: Record<number, ChannelEventKind> = {
  0x8: 'noteOff',
  0x9: 'noteOn',
  0xa: 'polyPressure',
  0xb: 'controlChange',
  0xc: 'programChange',
  0xd: 'channelPressure',
  0xe: 'pitchBend',
}

export function parseMidi(buf: Buffer): ParsedMidi {
  if (buf.length < 14 || !buf.subarray(0, 4).equals(HEADER)) {
    throw new AppError(ErrorCodes.INVALID_FILE, 'missing MThd header')
  }
  const headerLen = buf.readUInt32BE(4)
  if (headerLen < 6) {
    throw new AppError(ErrorCodes.INVALID_FILE, `bad header length ${headerLen}`)
  }
  const format = buf.readUInt16BE(8)
  if (format !== 0 && format !== 1) {
    throw new AppError(ErrorCodes.UNKNOWN_FORMAT, `MIDI format ${format} is not supported`)
  }
  const ntrks = buf.readUInt16BE(10)
  const division = buf.readUInt16BE(12)
  if (division & 0x8000) {
    throw new AppError(
      ErrorCodes.SMPTE_UNSUPPORTED,
      'SMPTE time division is not supported; only PPQ (ticks-per-quarter) files are accepted',
    )
  }
  const ppq = division & 0x7fff
  if (ppq === 0) {
    throw new AppError(ErrorCodes.INVALID_FILE, 'PPQ must be non-zero')
  }

  let pos = 8 + headerLen
  const tracks: RawTrack[] = []
  for (let t = 0; t < ntrks; t++) {
    if (pos + 8 > buf.length) {
      throw new AppError(ErrorCodes.TRUNCATED_FILE, `track ${t} header is missing`)
    }
    if (!buf.subarray(pos, pos + 4).equals(TRACK_MAGIC)) {
      throw new AppError(ErrorCodes.INVALID_FILE, `expected MTrk at track ${t}`)
    }
    const chunkLen = buf.readUInt32BE(pos + 4)
    const chunkStart = pos + 8
    const chunkEnd = chunkStart + chunkLen
    if (chunkEnd > buf.length) {
      throw new AppError(
        ErrorCodes.TRUNCATED_FILE,
        `track ${t} declares ${chunkLen} bytes but only ${buf.length - chunkStart} remain`,
      )
    }
    tracks.push(parseTrack(buf, chunkStart, chunkEnd, t))
    pos = chunkEnd
  }

  if (format === 0 && tracks.length !== 1) {
    throw new AppError(ErrorCodes.INVALID_FILE, 'format 0 file must contain exactly one track')
  }
  if (tracks.length === 0) {
    throw new AppError(ErrorCodes.INVALID_FILE, 'file contains no tracks')
  }
  return { format, ppq, tracks }
}

function parseTrack(buf: Buffer, start: number, end: number, trackIndex: number): RawTrack {
  let p = start
  let tick = 0
  let runningStatus = 0
  let ordinal = 0
  const events: MidiEvent[] = []

  while (p < end) {
    const delta = readVLQ(buf, p)
    p = delta.nextOffset
    tick += delta.value

    if (p >= end) {
      throw new AppError(ErrorCodes.TRUNCATED_FILE, `track ${trackIndex} ends mid-event`)
    }
    let status = buf[p]
    if (status < 0x80) {
      if (runningStatus === 0) {
        throw new AppError(
          ErrorCodes.INVALID_FILE,
          `track ${trackIndex}: data byte without running status at tick ${tick}`,
        )
      }
      status = runningStatus
    } else {
      p++
      runningStatus = status < 0xf0 ? status : 0
    }

    if (status === 0xff) {
      if (p + 1 > end) throw truncated(trackIndex, 'meta type')
      const metaType = buf[p++]
      const len = readVLQ(buf, p)
      p = len.nextOffset
      if (p + len.value > end) throw truncated(trackIndex, 'meta payload')
      const meta: MetaEvent = {
        kind: 'meta',
        tick,
        metaType,
        data: Buffer.from(buf.subarray(p, p + len.value)),
        ordinal: ordinal++,
      }
      events.push(meta)
      p += len.value
    } else if (status === 0xf0 || status === 0xf7) {
      const len = readVLQ(buf, p)
      p = len.nextOffset
      if (p + len.value > end) throw truncated(trackIndex, 'sysex payload')
      const sysex: SysExEvent = {
        kind: 'sysex',
        tick,
        data: Buffer.concat([Buffer.from([status]), buf.subarray(p, p + len.value)]),
        ordinal: ordinal++,
      }
      events.push(sysex)
      p += len.value
    } else {
      const high = status >> 4
      const dataLen = CHANNEL_DATA_LEN[high]
      if (dataLen === undefined) {
        throw new AppError(
          ErrorCodes.INVALID_FILE,
          `track ${trackIndex}: unsupported status 0x${status.toString(16)} at tick ${tick}`,
        )
      }
      if (p + dataLen > end) throw truncated(trackIndex, 'channel event data')
      const data1 = buf[p]
      const data2 = dataLen === 2 ? buf[p + 1] : 0
      if (data1 > 127 || data2 > 127) {
        throw new AppError(
          ErrorCodes.INVALID_FILE,
          `track ${trackIndex}: channel data exceeds 7 bits at tick ${tick}`,
        )
      }
      const ev: ChannelEvent = {
        kind: 'channel',
        tick,
        status,
        subtype: SUBTYPE[high],
        data1,
        data2,
        ordinal: ordinal++,
      }
      events.push(ev)
      p += dataLen
    }
  }

  return { events, endTick: tick }
}

function truncated(track: number, what: string): AppError {
  return new AppError(ErrorCodes.TRUNCATED_FILE, `track ${track}: truncated ${what}`)
}
