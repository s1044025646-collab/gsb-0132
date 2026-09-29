import { AppError, ErrorCodes } from './errors.ts'
import { isPercussion, pairNotes, type PairedNote } from './notes.ts'
import type { ChannelEvent, ParsedMidi } from './types.ts'

export interface TransposeOptions {
  semitones: number
  trackIndex?: number
  channel?: number
  /** default false: percussion (channel 10 / index 9) is never transposed */
  includePercussion?: boolean
}

export interface TransposeResult {
  moved: number
  skippedPercussion: number
  notes: PairedNote[]
}

/**
 * Transpose note pairs atomically. Both Note On and its matching Note Off
 * (including zero-velocity Note On) move together. If any target pitch leaves
 * 0..127 the whole operation is rejected before any mutation occurs.
 */
export function transpose(doc: ParsedMidi, opts: TransposeOptions): TransposeResult {
  if (!Number.isInteger(opts.semitones)) {
    throw new AppError(ErrorCodes.VALIDATION, 'semitones must be an integer')
  }
  if (opts.semitones === 0) {
    return { moved: 0, skippedPercussion: 0, notes: [] }
  }
  const notes = pairNotes(doc).filter(
    (n) =>
      (opts.trackIndex === undefined || n.trackIndex === opts.trackIndex) &&
      (opts.channel === undefined || n.channel === opts.channel),
  )
  let skippedPercussion = 0
  const targets = notes.filter((n) => {
    if (isPercussion(n.channel) && !opts.includePercussion) {
      skippedPercussion++
      return false
    }
    return true
  })

  for (const note of targets) {
    const target = note.pitch + opts.semitones
    if (target < 0 || target > 127) {
      throw new AppError(
        ErrorCodes.PITCH_OUT_OF_RANGE,
        `transposition would move pitch ${note.pitch} to ${target} on channel ${note.channel + 1}; allowed range is 0..127`,
        422,
        { trackIndex: note.trackIndex, channel: note.channel, pitch: note.pitch, target },
      )
    }
  }

  for (const note of targets) {
    note.onEvent.data1 = note.pitch + opts.semitones
    if (note.offEvent) note.offEvent.data1 = note.pitch + opts.semitones
  }
  return { moved: targets.length, skippedPercussion, notes: targets }
}

/**
 * Set instrument (program 0..121+) for a channel inside one track. A program
 * change is inserted before the track's first channel event. Repeated calls
 * replace the existing tick-0 program change for that channel instead of
 * stacking duplicates.
 */
export function setInstrument(
  doc: ParsedMidi,
  trackIndex: number,
  channel: number,
  program: number,
): { event: ChannelEvent; inserted: boolean } {
  if (trackIndex < 0 || trackIndex >= doc.tracks.length) {
    throw new AppError(ErrorCodes.NOT_FOUND, `track ${trackIndex} does not exist`, 404)
  }
  if (channel < 0 || channel > 15) {
    throw new AppError(ErrorCodes.VALIDATION, 'channel must be 0..15')
  }
  if (program < 0 || program > 127) {
    throw new AppError(ErrorCodes.VALIDATION, 'program must be 0..127')
  }
  const track = doc.tracks[trackIndex]
  const existing = track.events.find(
    (e): e is ChannelEvent =>
      e.kind === 'channel' &&
      e.subtype === 'programChange' &&
      (e.status & 0x0f) === channel &&
      e.tick === 0,
  )
  if (existing) {
    existing.data1 = program
    return { event: existing, inserted: false }
  }
  const firstOrdinal = track.events.reduce((min, e) => Math.min(min, e.ordinal), 0)
  const event: ChannelEvent = {
    kind: 'channel',
    tick: 0,
    status: 0xc0 | channel,
    subtype: 'programChange',
    data1: program,
    data2: 0,
    ordinal: firstOrdinal - 0.5,
  }
  track.events.push(event)
  return { event, inserted: true }
}
