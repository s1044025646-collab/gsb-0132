export type EventKind =
  | "noteOn"
  | "noteOff"
  | "programChange"
  | "controlChange"
  | "meta"
  | "sysex"
  | "raw";

export interface RawEvent {
  /** Absolute tick since the start of the track. */
  tick: number;
  kind: EventKind;
  /** MIDI channel 0..15 for channel events, -1 otherwise. */
  channel: number;
  /** Primary data byte 1 (note number / controller / program / meta type). */
  data1: number;
  /** Data byte 2 (velocity / value) when applicable, else -1. */
  data2: number;
  /** Meta/sysex payload bytes; empty for channel events. */
  bytes: number[];
  /** Full status byte used for channel events (for running status rebuild). */
  status: number;
  /** Stable order index within the whole file, assigned at parse time. */
  order: number;
}

export interface TempoChange {
  tick: number;
  /** Microseconds per quarter note. */
  usPerQuarter: number;
  order: number;
}

export interface TimeSignature {
  tick: number;
  numerator: number;
  denominator: number;
  /** MIDI clocks per metronome click. */
  clocksPerClick: number;
  /** 32nd notes per quarter. */
  thirtySeconds: number;
  order: number;
}

export interface ParsedTrack {
  index: number;
  name: string;
  events: RawEvent[];
}

export interface ParsedFile {
  format: 0 | 1;
  /** Ticks per quarter note (PPQ). */
  ppq: number;
  tracks: ParsedTrack[];
  tempos: TempoChange[];
  timeSignatures: TimeSignature[];
}

export interface PairedNote {
  id: string;
  trackIndex: number;
  channel: number;
  note: number;
  velocity: number;
  onTick: number;
  /** Tick of the matching note-off / zero-velocity note-on. */
  offTick: number;
  /** Key-held duration in ticks (offTick - onTick). */
  keyDurationTicks: number;
  /** Actual sounding duration including sustain pedal, in ticks. */
  soundingEndTick: number;
  soundingDurationTicks: number;
  /** True when no matching off event was found (truncated/end of track). */
  hanging: boolean;
  onOrder: number;
  offOrder: number;
}

export interface BeatLocation {
  measure: number;
  beat: number;
  /** Tick offset within the beat, 0..ticksPerBeat-1. */
  tickOffset: number;
  numerator: number;
  denominator: number;
  ticksPerBeat: number;
}
