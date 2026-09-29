import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMidi } from "../src/midi/parser.ts";
import { writeMidi } from "../src/midi/writer.ts";
import { rawMidi, varLen, endOfTrack } from "./fixtures.ts";
import { TimingEngine } from "../src/midi/timing.ts";

test("cross-track events at same tick keep a stable global parse order", () => {
  const noteOn = (tick: number, ch: number, pitch: number, vel: number) => [
    ...varLen(tick), 0x90 | ch, pitch, vel,
  ];
  const t1 = Buffer.from([
    ...noteOn(100, 0, 60, 90),
    ...varLen(0), 0x80, 60, 0,
    ...endOfTrack(100),
  ]);
  const t2 = Buffer.from([
    ...noteOn(100, 1, 48, 90),
    ...varLen(0), 0x81, 48, 0,
    ...endOfTrack(100),
  ]);
  const f = parseMidi(rawMidi(1, 2, 480, [t1, t2]));
  const combined = f.tracks
    .flatMap((t) => t.events)
    .filter((e) => e.kind === "noteOn")
    .sort((a, b) => a.tick - b.tick || a.order - b.order);
  assert.equal(combined[0].channel, 0);
  assert.equal(combined[1].channel, 1);
  // order must survive a serialize/parse cycle
  const again = parseMidi(writeMidi(f));
  const recombined = again.tracks
    .flatMap((t) => t.events)
    .filter((e) => e.kind === "noteOn")
    .sort((a, b) => a.tick - b.tick || a.order - b.order);
  assert.deepEqual(recombined.map((e) => e.channel), [0, 1]);
});

test("conflicting tempo on different tracks: earliest parse order wins at a tick", () => {
  const tempo = (tick: number, us: number) => [
    ...varLen(tick), 0xff, 0x51, 0x03,
    (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff,
  ];
  // Both tracks set a tempo at tick 0 with different values.
  const t1 = Buffer.from([...tempo(0, 500000), ...endOfTrack(0)]);
  const t2 = Buffer.from([...tempo(0, 250000), ...endOfTrack(0)]);
  const f = parseMidi(rawMidi(1, 2, 480, [t1, t2]));
  const e = new TimingEngine(f);
  // The first tempo in stable order at tick 0 governs.
  assert.equal(f.tempos[0].usPerQuarter, 500000);
  assert.equal(e.tickToMs(480), 500);
});

test("multiple tempo changes accumulate correctly over time", () => {
  const tempo = (delta: number, us: number) => [
    ...varLen(delta), 0xff, 0x51, 0x03,
    (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff,
  ];
  const t = Buffer.from([
    ...tempo(0, 500000),
    ...tempo(480, 250000),  // at tick 480
    ...tempo(480, 1000000), // at tick 960
    ...endOfTrack(480),     // end at tick 1440
  ]);
  const f = parseMidi(rawMidi(0, 1, 480, [t]));
  const e = new TimingEngine(f);
  // beat1 500ms, beat2 250ms => at tick 960 = 750ms; one beat at 1000us = 1000ms
  assert.equal(e.tickToMs(960), 750);
  assert.equal(e.tickToMs(1440), 1750);
  assert.equal(e.tickToMs(960 + 48), 750 + 100);
});
