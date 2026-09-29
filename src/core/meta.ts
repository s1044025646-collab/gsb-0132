import type { ParsedMidi } from './types.ts'

export interface TempoPoint {
  tick: number
  usPerQuarter: number
  bpm: number
  trackIndex: number
  ordinal: number
}

export interface TimeSignaturePoint {
  tick: number
  numerator: number
  denominator: number
  /** MIDI cc: metronome clocks per click */
  metronomeClocks: number
  thirtySecondsPerQuarter: number
  trackIndex: number
  ordinal: number
}

export const DEFAULT_TEMPO_US = 500_000

export function decodeTempo(data: Buffer): number {
  if (data.length < 3) throw new Error('tempo meta must be 3 bytes')
  return (data[0] << 16) | (data[1] << 8) | data[2]
}

export function decodeTimeSignature(data: Buffer): Omit<TimeSignaturePoint, 'tick' | 'trackIndex' | 'ordinal'> {
  if (data.length < 4) throw new Error('time signature meta must be 4 bytes')
  const denominator = 2 ** data[1]
  return {
    numerator: data[0],
    denominator,
    metronomeClocks: data[2],
    thirtySecondsPerQuarter: data[3],
  }
}

/**
 * Extract every tempo change across all tracks, in a deterministic order:
 * (tick, trackIndex, ordinal). When several tracks set the tempo at the same
 * tick the later entry in this order wins, exactly as a byte-stream merge
 * would when tracks are interleaved in chunk order.
 */
export function buildTempoMap(doc: ParsedMidi): TempoPoint[] {
  const points: TempoPoint[] = []
  doc.tracks.forEach((track, trackIndex) => {
    for (const ev of track.events) {
      if (ev.kind === 'meta' && ev.metaType === 0x51) {
        const us = decodeTempo(ev.data)
        points.push({
          tick: ev.tick,
          usPerQuarter: us,
          bpm: 60_000_000 / us,
          trackIndex,
          ordinal: ev.ordinal,
        })
      }
    }
  })
  points.sort(
    (a, b) => a.tick - b.tick || a.trackIndex - b.trackIndex || a.ordinal - b.ordinal,
  )
  return points
}

export function buildTimeSignatureMap(doc: ParsedMidi): TimeSignaturePoint[] {
  const points: TimeSignaturePoint[] = []
  doc.tracks.forEach((track, trackIndex) => {
    for (const ev of track.events) {
      if (ev.kind === 'meta' && ev.metaType === 0x58) {
        points.push({
          tick: ev.tick,
          ...decodeTimeSignature(ev.data),
          trackIndex,
          ordinal: ev.ordinal,
        })
      }
    }
  })
  points.sort(
    (a, b) => a.tick - b.tick || a.trackIndex - b.trackIndex || a.ordinal - b.ordinal,
  )
  return points
}
