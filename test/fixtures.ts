import { writeMidi } from "../src/midi/writer.ts";
import {
  buildDemoFile,
  buildEmptyTrackFile,
  buildSustainFile,
} from "../src/midi/generator.ts";

export function demoBytes(): Buffer {
  return writeMidi(buildDemoFile());
}
export function sustainBytes(): Buffer {
  return writeMidi(buildSustainFile());
}
export function emptyTrackBytes(): Buffer {
  return writeMidi(buildEmptyTrackFile());
}

/** Hand-build a minimal binary MIDI file for parser edge cases. */
export function rawMidi(format: number, ntracks: number, division: number, trackBodies: Buffer[]): Buffer {
  const header = Buffer.alloc(14);
  header.write("MThd", 0, "latin1");
  header.writeUInt32BE(6, 4);
  header.writeUInt16BE(format, 8);
  header.writeUInt16BE(ntracks, 10);
  header.writeUInt16BE(division, 12);
  const chunks = [header];
  for (const body of trackBodies) {
    const head = Buffer.alloc(8);
    head.write("MTrk", 0, "latin1");
    head.writeUInt32BE(body.length, 4);
    chunks.push(head, body);
  }
  return Buffer.concat(chunks);
}

export const varLen = (valueIn: number): number[] => {
  let value = valueIn >>> 0;
  const out = [value & 0x7f];
  value >>>= 7;
  while (value > 0) {
    out.unshift((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  return out;
};

export const endOfTrack = (tick = 0): number[] => [...varLen(tick), 0xff, 0x2f, 0];
