import type { ChannelEvent, MidiEvent, ParsedMidi } from './types.ts'

export interface PairedNote {
  trackIndex: number
  channel: number
  pitch: number
  velocity: number
  onTick: number
  offTick: number
  /** key-held duration in ticks */
  keyDurationTicks: number
  /** actual sounding duration in ticks (longer while sustain pedal held) */
  soundingDurationTicks: number
  /** note never closed (dangling at track end) */
  dangling: boolean
  onEvent: ChannelEvent
  offEvent: ChannelEvent | null
}

interface OpenNote {
  on: ChannelEvent
}

interface PedalRegion {
  downTick: number
  upTick: number
}

function isPercussion(channel: number): boolean {
  return channel === 9
}

/**
 * Pair Note On / Note Off across a single track per channel+pitch.
 * Zero-velocity Note On counts as a Note Off. Overlapping identical pitches
 * match the most recently opened note (LIFO). Sustain pedal (CC64 >= 64
 * means down) extends sounding time until the next pedal-up.
 */
export function pairNotes(doc: ParsedMidi): PairedNote[] {
  const notes: PairedNote[] = []
  doc.tracks.forEach((track, trackIndex) => {
    const open = new Map<number, OpenNote[]>()

    const channelEvents = track.events.filter(
      (e): e is ChannelEvent => e.kind === 'channel',
    )
    channelEvents.sort((a, b) => a.tick - b.tick || a.ordinal - b.ordinal)

    // First pass: collect complete sustain-pedal regions, independently of the
    // ordinal ordering between pedal-up and note-off at the same tick.
    const pedalDownAt = new Map<number, number>()
    const pedalRegions = new Map<number, PedalRegion[]>()
    for (const ev of channelEvents) {
      if (ev.subtype === 'controlChange' && ev.data1 === 64) {
        const channel0 = ev.status & 0x0f
        const down = ev.data2 >= 64
        const wasDownAt = pedalDownAt.get(channel0)
        if (down && wasDownAt === undefined) {
          pedalDownAt.set(channel0, ev.tick)
        } else if (!down && wasDownAt !== undefined) {
          let regions = pedalRegions.get(channel0)
          if (!regions) {
            regions = []
            pedalRegions.set(channel0, regions)
          }
          regions.push({ downTick: wasDownAt, upTick: ev.tick })
          pedalDownAt.delete(channel0)
        }
      }
    }

    for (const ev of channelEvents) {
      const channel = ev.status & 0x0f
      if (ev.subtype === 'noteOn' && ev.data2 > 0) {
        const key = keyOf(channel, ev.data1)
        let stack = open.get(key)
        if (!stack) {
          stack = []
          open.set(key, stack)
        }
        stack.push({ on: ev })
      } else if (ev.subtype === 'noteOff' || (ev.subtype === 'noteOn' && ev.data2 === 0)) {
        const key = keyOf(channel, ev.data1)
        const stack = open.get(key)
        const opener = stack?.pop()
        if (opener) {
          notes.push(
            makeNote(trackIndex, channel, ev.data1, opener.on, ev, pedalRegions.get(channel)),
          )
        }
      } else if (ev.subtype === 'controlChange' && ev.data1 === 64) {
        // handled in first pass
      }
    }

    // dangling notes: sound until track end or pedal release if later
    const trackEnd = track.endTick
    for (const [key, stack] of open) {
      for (const item of stack) {
        const channel = key & 0x0f
        const pitch = key >> 4
        notes.push(
          makeNote(trackIndex, channel, pitch, item.on, null, pedalRegions.get(channel), trackEnd),
        )
      }
    }
  })
  notes.sort(
    (a, b) =>
      a.onTick - b.onTick ||
      a.trackIndex - b.trackIndex ||
      a.channel - b.channel ||
      a.pitch - b.pitch ||
      a.onEvent.ordinal - b.onEvent.ordinal,
  )
  return notes
}

function keyOf(channel: number, pitch: number): number {
  return (pitch << 4) | channel
}

function makeNote(
  trackIndex: number,
  channel: number,
  pitch: number,
  onEvent: ChannelEvent,
  offEvent: ChannelEvent | null,
  pedalRegions: PedalRegion[] | undefined,
  trackEnd?: number,
): PairedNote {
  const dangling = offEvent === null
  const offTick = offEvent?.tick ?? trackEnd ?? onEvent.tick
  let soundingEnd = offTick
  if (!isPercussion(channel) && pedalRegions) {
    for (const region of pedalRegions) {
      if (region.downTick <= offTick && region.upTick > offTick && region.upTick > soundingEnd) {
        soundingEnd = region.upTick
      }
    }
  }
  return {
    trackIndex,
    channel,
    pitch,
    velocity: onEvent.data2,
    onTick: onEvent.tick,
    offTick,
    keyDurationTicks: offTick - onEvent.tick,
    soundingDurationTicks: soundingEnd - onEvent.tick,
    dangling,
    onEvent,
    offEvent,
  }
}

export { isPercussion }
