import { AppError } from "../errors.ts";
import type { ParsedFile, RawEvent } from "./types.ts";

export const DRUM_CHANNEL = 9;

export interface TransposeOptions {
  semitones: number;
  /** Channels to affect; defaults to all except the drum channel (9). */
  channels?: number[];
  includeDrums?: boolean;
}

/**
 * Transpose every note on/off pair by a fixed number of semitones.
 * Drum channel 9 is preserved by default. All targets are validated to stay
 * within 0..127 before any byte is changed so the operation is all-or-nothing.
 */
export function transpose(file: ParsedFile, opts: TransposeOptions): number {
  const semitones = Math.trunc(opts.semitones);
  if (!Number.isFinite(semitones)) {
    throw new AppError("VALIDATION", "semitones must be an integer");
  }
  const includeDrums = opts.includeDrums ?? false;
  const explicit = opts.channels ? new Set(opts.channels) : null;
  const affected = (ch: number) => {
    if (explicit) return explicit.has(ch);
    if (ch === DRUM_CHANNEL && !includeDrums) return false;
    return true;
  };

  const noteEvents: RawEvent[] = [];
  for (const track of file.tracks) {
    for (const ev of track.events) {
      if ((ev.kind === "noteOn" || ev.kind === "noteOff") && affected(ev.channel)) {
        noteEvents.push(ev);
      }
    }
  }

  const violations: { channel: number; from: number; to: number }[] = [];
  for (const ev of noteEvents) {
    const target = ev.data1 + semitones;
    if (target < 0 || target > 127) {
      violations.push({ channel: ev.channel, from: ev.data1, to: target });
    }
  }
  if (violations.length > 0) {
    throw new AppError(
      "OUT_OF_RANGE",
      `Transposition would move ${violations.length} note(s) outside 0..127`,
      { semitones, violations: violations.slice(0, 20) },
    );
  }

  for (const ev of noteEvents) ev.data1 = ev.data1 + semitones;
  return noteEvents.length;
}

/**
 * Set the instrument (program 0..127) for a track/channel. Reuses an existing
 * program change at or before tick 0 on that channel when present, otherwise
 * inserts one at tick 0. Unknown events are never removed.
 */
export function setInstrument(
  file: ParsedFile,
  trackIndex: number,
  channel: number,
  program: number,
  nextOrder: () => number,
): void {
  if (trackIndex < 0 || trackIndex >= file.tracks.length) {
    throw new AppError("NOT_FOUND", `Track ${trackIndex} does not exist`);
  }
  if (channel < 0 || channel > 15) {
    throw new AppError("VALIDATION", "channel must be 0..15");
  }
  if (program < 0 || program > 127) {
    throw new AppError("VALIDATION", "program must be 0..127");
  }
  const track = file.tracks[trackIndex];
  const existing = track.events.find(
    (e) =>
      e.kind === "programChange" &&
      e.channel === channel &&
      e.tick === 0,
  );
  if (existing) {
    existing.data1 = program;
    return;
  }
  track.events.push({
    tick: 0,
    kind: "programChange",
    channel,
    data1: program,
    data2: -1,
    bytes: [],
    status: 0xc0 | channel,
    order: nextOrder(),
  });
}

/** Get the effective program for a channel in a track (latest change at/before tick). */
export function effectiveProgram(
  file: ParsedFile,
  trackIndex: number,
  channel: number,
  atTick = Number.MAX_SAFE_INTEGER,
): number | null {
  const track = file.tracks[trackIndex];
  let prog: number | null = null;
  for (const ev of track.events) {
    if (
      ev.kind === "programChange" &&
      ev.channel === channel &&
      ev.tick <= atTick
    ) {
      prog = ev.data1;
    }
  }
  return prog;
}
