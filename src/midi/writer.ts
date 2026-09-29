import type { ParsedFile, RawEvent } from "./types.ts";

export function encodeVarLen(valueIn: number): number[] {
  let value = valueIn >>> 0;
  const out: number[] = [value & 0x7f];
  value >>>= 7;
  while (value > 0) {
    out.unshift((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  return out;
}

function chunk(magic: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.write(magic, 0, "latin1");
  head.writeUInt32BE(body.length, 4);
  return Buffer.concat([head, body]);
}

/** Deterministic cross-track event ordering: tick, then parse order. */
export function stableSortEvents(events: RawEvent[]): RawEvent[] {
  return [...events].sort((a, b) => a.tick - b.tick || a.order - b.order);
}

function encodeEvent(ev: RawEvent, prevStatus: { s: number }): number[] {
  const out: number[] = [];
  if (ev.kind === "meta") {
    out.push(0xff);
    out.push(ev.data1);
    out.push(...encodeVarLen(ev.bytes.length));
    out.push(...ev.bytes);
    prevStatus.s = -1;
  } else if (ev.kind === "sysex") {
    out.push(ev.status);
    out.push(...encodeVarLen(ev.bytes.length));
    out.push(...ev.bytes);
    prevStatus.s = -1;
  } else {
    // Running status only applies to channel messages and when status repeats.
    const isChannel = ev.status >= 0x80 && ev.status < 0xf0;
    if (isChannel && prevStatus.s === ev.status) {
      // omit status byte
    } else {
      out.push(ev.status);
      if (isChannel) prevStatus.s = ev.status;
    }
    const high = ev.status & 0xf0;
    out.push(ev.data1 & 0x7f);
    if (high !== 0xc0 && high !== 0xd0) out.push(ev.data2 & 0x7f);
  }
  return out;
}

export function writeMidi(file: ParsedFile): Buffer {
  const header = Buffer.alloc(14);
  header.write("MThd", 0, "latin1");
  header.writeUInt32BE(6, 4);
  header.writeUInt16BE(file.format, 8);
  header.writeUInt16BE(file.tracks.length, 10);
  header.writeUInt16BE(file.ppq, 12);

  const chunks: Buffer[] = [header];
  for (const track of file.tracks) {
    const ordered = stableSortEvents(track.events);
    const body: number[] = [];
    let lastTick = 0;
    const prevStatus = { s: -1 };
    let hasEnd = false;
    for (const ev of ordered) {
      if (ev.tick < lastTick) {
        throw new Error("Events not in ascending tick order before serialization");
      }
      body.push(...encodeVarLen(ev.tick - lastTick));
      lastTick = ev.tick;
      body.push(...encodeEvent(ev, prevStatus));
      if (ev.kind === "meta" && ev.data1 === 0x2f) hasEnd = true;
    }
    if (!hasEnd) {
      body.push(0, 0xff, 0x2f, 0);
    }
    chunks.push(chunk("MTrk", Buffer.from(body)));
  }
  return Buffer.concat(chunks);
}
