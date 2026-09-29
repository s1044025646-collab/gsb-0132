import type { ParsedFile, RawEvent } from "./types.ts";

let orderCounter = 0;

function ev(partial: Partial<RawEvent> & { tick: number; kind: RawEvent["kind"] }): RawEvent {
  return {
    channel: -1,
    data1: 0,
    data2: -1,
    bytes: [],
    status: 0,
    order: orderCounter++,
    ...partial,
  };
}

function meta(tick: number, type: number, bytes: number[]): RawEvent {
  return ev({ tick, kind: "meta", data1: type, bytes, status: 0xff });
}

function tempoMeta(tick: number, usPerQuarter: number): RawEvent {
  return meta(tick, 0x51, [
    (usPerQuarter >> 16) & 0xff,
    (usPerQuarter >> 8) & 0xff,
    usPerQuarter & 0xff,
  ]);
}

function timeSig(tick: number, num: number, denom: number): RawEvent {
  return meta(tick, 0x58, [num, Math.log2(denom), 24, 8]);
}

function trackName(name: string): RawEvent {
  return meta(0, 0x03, [...Buffer.from(name, "utf8")]);
}

function note(
  tick: number,
  channel: number,
  pitch: number,
  durTicks: number,
  velocity = 96,
): { on: RawEvent; off: RawEvent } {
  return {
    on: ev({
      tick, kind: "noteOn", channel, data1: pitch, data2: velocity, status: 0x90 | channel,
    }),
    off: ev({
      tick: tick + durTicks, kind: "noteOff", channel, data1: pitch, data2: 0,
      status: 0x80 | channel,
    }),
  };
}

function program(tick: number, channel: number, prog: number): RawEvent {
  return ev({ tick, kind: "programChange", channel, data1: prog, data2: -1, status: 0xc0 | channel });
}

function cc(tick: number, channel: number, controller: number, value: number): RawEvent {
  return ev({ tick, kind: "controlChange", channel, data1: controller, data2: value, status: 0xb0 | channel });
}

function endTrack(tick: number): RawEvent {
  return meta(tick, 0x2f, []);
}

/**
 * Build a deterministic multi-track demo file:
 * - format 1, PPQ 480
 * - conductor track with two tempo changes and a 4/4 -> 3/4 switch
 * - a piano melody, a bass line and a drum (channel 10) pattern
 */
export function buildDemoFile(): ParsedFile {
  orderCounter = 0;
  const ppq = 480;

  const conductor: RawEvent[] = [
    trackName("Conductor"),
    tempoMeta(0, 500000),
    timeSig(0, 4, 4),
    tempoMeta(ppq * 4, 400000),
    timeSig(ppq * 8, 3, 4),
    tempoMeta(ppq * 11, 600000),
    endTrack(ppq * 14),
  ];

  const piano: RawEvent[] = [
    trackName("Piano"),
    program(0, 0, 0),
  ];
  const melody = [60, 64, 67, 72, 71, 67, 65, 64, 62, 60, 64, 67, 69];
  melody.forEach((p, i) => {
    const { on, off } = note(i * ppq, 0, p, ppq - 60, 90);
    piano.push(on, off);
  });
  piano.push(endTrack(melody.length * ppq));

  const bass: RawEvent[] = [trackName("Bass"), program(0, 1, 33)];
  for (let bar = 0; bar < 3; bar++) {
    const root = [36, 40, 43][bar];
    const start = bar * 4 * ppq;
    for (let b = 0; b < 4; b++) {
      const { on, off } = note(start + b * ppq, 1, root + (b === 3 ? 7 : 0), ppq / 2, 100);
      bass.push(on, off);
    }
  }
  bass.push(endTrack(3 * 4 * ppq));

  const drums: RawEvent[] = [trackName("Drums"), program(0, 9, 0)];
  for (let i = 0; i < 12; i++) {
    const start = i * ppq;
    const kick = note(start, 9, 36, ppq / 4, 110);
    const snare = note(start + ppq / 2, 9, 38, ppq / 4, 90);
    drums.push(kick.on, kick.off, snare.on, snare.off);
  }
  drums.push(endTrack(12 * ppq));

  return {
    format: 1,
    ppq,
    tracks: [
      { index: 0, name: "Conductor", events: conductor },
      { index: 1, name: "Piano", events: piano },
      { index: 2, name: "Bass", events: bass },
      { index: 3, name: "Drums", events: drums },
    ],
    tempos: [],
    timeSignatures: [],
  };
}

/** A small fixture exercising sustain pedal and overlapping unison notes. */
export function buildSustainFile(): ParsedFile {
  orderCounter = 0;
  const ppq = 480;
  const events: RawEvent[] = [
    trackName("Sustain"),
    program(0, 0, 0),
  ];
  const a = note(0, 0, 60, ppq, 90);
  const b = note(0, 0, 60, ppq / 2, 80); // overlapping unison
  events.push(a.on, b.on, cc(ppq / 4, 0, 64, 127), b.off, a.off, cc(ppq * 2, 0, 64, 0));
  events.push(endTrack(ppq * 3));
  return {
    format: 0, ppq,
    tracks: [{ index: 0, name: "Sustain", events }],
    tempos: [], timeSignatures: [],
  };
}

/** Empty-track fixture: format 1 with one conductor and an empty note track. */
export function buildEmptyTrackFile(): ParsedFile {
  orderCounter = 0;
  const ppq = 240;
  return {
    format: 1, ppq,
    tracks: [
      { index: 0, name: "", events: [tempoMeta(0, 500000), endTrack(0)] },
      { index: 1, name: "Empty", events: [trackName("Empty"), endTrack(0)] },
    ],
    tempos: [], timeSignatures: [],
  };
}
