import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMidi } from "../src/midi/parser.ts";
import { writeMidi } from "../src/midi/writer.ts";
import { TimingEngine } from "../src/midi/timing.ts";
import { pairNotes } from "../src/midi/notes.ts";
import { transpose } from "../src/midi/transform.ts";
import {
  demoBytes,
  sustainBytes,
  emptyTrackBytes,
  rawMidi,
  varLen,
  endOfTrack,
} from "./fixtures.ts";
import { AppError } from "../src/errors.ts";

test("parse/write round-trip preserves semantics for multi-tempo format 1", () => {
  const a = parseMidi(demoBytes());
  const b = parseMidi(writeMidi(a));
  assert.equal(b.format, 1);
  assert.equal(b.ppq, 480);
  assert.equal(b.tracks.length, a.tracks.length);
  assert.deepEqual(b.tempos.map((t) => [t.tick, t.usPerQuarter]), [
    [0, 500000], [1920, 400000], [5280, 600000],
  ]);
  assert.deepEqual(b.timeSignatures.map((s) => [s.tick, s.numerator, s.denominator]), [
    [0, 4, 4], [3840, 3, 4],
  ]);
  for (let i = 0; i < a.tracks.length; i++) {
    assert.equal(b.tracks[i].events.length, a.tracks[i].events.length);
  }
});

test("tick/ms conversion follows the complete tempo map and round-trips", () => {
  const f = parseMidi(demoBytes());
  const e = new TimingEngine(f);
  assert.equal(e.tickToMs(0), 0);
  assert.equal(e.tickToMs(480), 500);
  // 4 beats at 500ms = 2000ms; then tempo becomes 400us => 400ms/beat.
  assert.equal(e.tickToMs(1920 + 480), 2400);
  for (const tick of [0, 1, 479, 1920, 3000, 5280, 6000]) {
    const back = e.msToTick(e.tickToMs(tick));
    assert.ok(Math.abs(back - tick) < 1e-6, `roundtrip ${tick} -> ${back}`);
  }
});

test("beat locations cross the 4/4 -> 3/4 boundary", () => {
  const e = new TimingEngine(parseMidi(demoBytes()));
  assert.deepEqual([e.locate(0).measure, e.locate(0).beat], [1, 1]);
  assert.deepEqual([e.locate(3840).measure, e.locate(3840).beat], [3, 1]);
  assert.equal(e.locate(3840).numerator, 3);
});

test("running status parses repeated channel events", () => {
  // two note-ons on channel 0 with running status, then end
  const body = Buffer.from([
    0x00, 0x90, 60, 100,
    ...varLen(10), 64, 100,
    ...endOfTrack(10),
  ]);
  const f = parseMidi(rawMidi(0, 1, 480, [body]));
  const ons = f.tracks[0].events.filter((ev) => ev.kind === "noteOn");
  assert.equal(ons.length, 2);
  assert.deepEqual(ons.map((o) => [o.tick, o.data1]), [[0, 60], [10, 64]]);
});

test("zero-velocity note-on is treated as note-off and pairs correctly", () => {
  const body = Buffer.from([
    0x00, 0x90, 60, 100,
    ...varLen(100), 60, 0,
    ...endOfTrack(100),
  ]);
  const f = parseMidi(rawMidi(0, 1, 480, [body]));
  const notes = pairNotes(f);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].offTick, 100);
  assert.equal(notes[0].hanging, false);
});

test("overlapping unison notes pair FIFO; same-tick off/on is stable", () => {
  const f = parseMidi(sustainBytes());
  const notes = pairNotes(f).filter((n) => n.note === 60);
  assert.equal(notes.length, 2);
  assert.deepEqual(notes.map((n) => n.onTick), [0, 0]);
  assert.deepEqual(notes.map((n) => n.offTick), [240, 480]);
});

test("sustain pedal extends sounding duration beyond key release", () => {
  const f = parseMidi(sustainBytes());
  const notes = pairNotes(f);
  for (const n of notes) {
    assert.ok(n.soundingEndTick >= n.offTick);
    assert.equal(n.soundingEndTick, 960);
    assert.ok(n.soundingDurationTicks > n.keyDurationTicks || n.offTick === 960);
  }
});

test("hanging notes are reported, not dropped", () => {
  const body = Buffer.from([0x00, 0x90, 72, 90, ...endOfTrack(10)]);
  const f = parseMidi(rawMidi(0, 1, 480, [body]));
  const notes = pairNotes(f);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].hanging, true);
});

test("empty track parses and yields no notes", () => {
  const f = parseMidi(emptyTrackBytes());
  assert.equal(f.tracks.length, 2);
  assert.equal(pairNotes(f).length, 0);
});

test("SMPTE division is explicitly rejected", () => {
  const body = Buffer.from(endOfTrack(0));
  assert.throws(
    () => parseMidi(rawMidi(0, 1, 0x8063, [body])),
    (e: unknown) => e instanceof AppError && e.code === "UNSUPPORTED_SMPTE",
  );
});

test("unsupported format (2) is rejected", () => {
  const body = Buffer.from(endOfTrack(0));
  assert.throws(
    () => parseMidi(rawMidi(2, 1, 480, [body])),
    (e: unknown) => e instanceof AppError && e.code === "UNSUPPORTED_FORMAT",
  );
});

test("truncated file is detected", () => {
  const full = demoBytes();
  assert.throws(
    () => parseMidi(full.subarray(0, full.length - 50)),
    (e: unknown) => e instanceof AppError &&
      (e.code === "TRUNCATED_FILE" || e.code === "INVALID_FILE"),
  );
});

test("transpose preserves drums and rejects out-of-range", () => {
  const f = parseMidi(demoBytes());
  const beforeDrum = pairNotes(f).filter((n) => n.channel === 9).map((n) => n.note).sort();
  const changed = transpose(f, { semitones: 12 });
  assert.ok(changed > 0);
  const afterDrum = pairNotes(f).filter((n) => n.channel === 9).map((n) => n.note).sort();
  assert.deepEqual(afterDrum, beforeDrum);
  assert.throws(
    () => transpose(parseMidi(demoBytes()), { semitones: 120 }),
    (e: unknown) => e instanceof AppError && e.code === "OUT_OF_RANGE",
  );
});

test("unknown/sysex events survive a write round-trip", () => {
  const f = parseMidi(demoBytes());
  const body = Buffer.from([
    0x00, 0xf0, 0x04, 0x7e, 0x01, 0x02, 0x03,
    ...endOfTrack(0),
  ]);
  const g = parseMidi(rawMidi(0, 1, 480, [body]));
  const again = parseMidi(writeMidi(g));
  const sx = again.tracks[0].events.filter((e) => e.kind === "sysex");
  assert.equal(sx.length, 1);
  assert.deepEqual(sx[0].bytes, [0x7e, 0x01, 0x02, 0x03]);
});
