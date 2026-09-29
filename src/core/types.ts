export type ChannelEventKind =
  | 'noteOff'
  | 'noteOn'
  | 'polyPressure'
  | 'controlChange'
  | 'programChange'
  | 'channelPressure'
  | 'pitchBend'

export interface ChannelEvent {
  kind: 'channel'
  tick: number
  /** absolute status byte (running status already resolved), 0x80-0xEF */
  status: number
  subtype: ChannelEventKind
  data1: number
  data2: number
  /** ordinal position inside the owning track chunk */
  ordinal: number
}

export interface MetaEvent {
  kind: 'meta'
  tick: number
  metaType: number
  data: Buffer
  ordinal: number
}

export interface SysExEvent {
  kind: 'sysex'
  tick: number
  /** full F0/F7 escaped payload exactly as stored in the file */
  data: Buffer
  ordinal: number
}

export type MidiEvent = ChannelEvent | MetaEvent | SysExEvent

export interface RawTrack {
  events: MidiEvent[]
  /** last absolute tick reached while parsing */
  endTick: number
}

export interface ParsedMidi {
  format: 0 | 1
  /** pulses (ticks) per quarter note */
  ppq: number
  tracks: RawTrack[]
}
