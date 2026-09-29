import { AppError } from "../errors.ts";
import type {
  ParsedFile,
  ParsedTrack,
  RawEvent,
  TempoChange,
  TimeSignature,
} from "./types.ts";

const HEADER = "MThd";
const TRACK_MAGIC = "MTrk";

class Reader {
  pos = 0;
  constructor(readonly buf: Buffer) {}

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  need(n: number): void {
    if (this.remaining < n) {
      throw new AppError(
        "TRUNCATED_FILE",
        `Unexpected end of file: needed ${n} bytes at offset ${this.pos}, have ${this.remaining}`,
      );
    }
  }

  u8(): number {
    this.need(1);
    return this.buf[this.pos++];
  }

  u16(): number {
    this.need(2);
    const v = this.buf.readUInt16BE(this.pos);
    this.pos += 2;
    return v;
  }

  u32(): number {
    this.need(4);
    const v = this.buf.readUInt32BE(this.pos);
    this.pos += 4;
    return v;
  }

  ascii(n: number): string {
    this.need(n);
    const s = this.buf.toString("latin1", this.pos, this.pos + n);
    this.pos += n;
    return s;
  }

  bytes(n: number): number[] {
    this.need(n);
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(this.buf[this.pos + i]);
    this.pos += n;
    return out;
  }

  varLen(): number {
    let value = 0;
    let count = 0;
    for (;;) {
      const b = this.u8();
      count++;
      if (count > 4) {
        throw new AppError("INVALID_FILE", "Variable-length quantity exceeds 4 bytes");
      }
      value = (value << 7) | (b & 0x7f);
      if ((b & 0x80) === 0) break;
      if (value > 0xffffffff) {
        throw new AppError("INVALID_FILE", "Variable-length quantity overflow");
      }
    }
    return value >>> 0;
  }
}

function decodeText(bytes: number[]): string {
  return Buffer.from(bytes).toString("utf8");
}

export function parseMidi(input: Buffer | Uint8Array): ParsedFile {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const r = new Reader(buf);

  if (r.ascii(4) !== HEADER) {
    throw new AppError("INVALID_FILE", "Missing MThd chunk");
  }
  const headerLen = r.u32();
  if (headerLen < 6) {
    throw new AppError("INVALID_FILE", `Invalid header length ${headerLen}`);
  }
  const format = r.u16();
  const ntracks = r.u16();
  const division = r.u16();
  if (headerLen > 6) r.bytes(headerLen - 6);

  if (format !== 0 && format !== 1) {
    throw new AppError(
      "UNSUPPORTED_FORMAT",
      `Only MIDI format 0 and 1 are supported, got format ${format}`,
      { format },
    );
  }

  if (division & 0x8000) {
    throw new AppError(
      "UNSUPPORTED_SMPTE",
      `SMPTE time division is not supported (division=0x${division
        .toString(16)
        .padStart(4, "0")}). Only PPQ is accepted.`,
      { division },
    );
  }
  const ppq = division;
  if (ppq <= 0) {
    throw new AppError("INVALID_FILE", `Invalid PPQ division ${ppq}`);
  }

  const tracks: ParsedTrack[] = [];
  const tempos: TempoChange[] = [];
  const timeSignatures: TimeSignature[] = [];
  let order = 0;

  for (let t = 0; t < ntracks; t++) {
    if (r.ascii(4) !== TRACK_MAGIC) {
      throw new AppError("INVALID_FILE", `Expected MTrk chunk for track ${t}`);
    }
    const trackLen = r.u32();
    r.need(trackLen);
    const trackEnd = r.pos + trackLen;
    const events = parseTrack(r, trackEnd, () => order++);
    let name = "";
    for (const ev of events) {
      if (ev.kind === "meta") {
        if (ev.data1 === 0x03) name = decodeText(ev.bytes);
        if (ev.data1 === 0x51 && ev.bytes.length >= 3) {
          const us =
            ((ev.bytes[0] << 16) | (ev.bytes[1] << 8) | ev.bytes[2]) >>> 0;
          if (us > 0) tempos.push({ tick: ev.tick, usPerQuarter: us, order: ev.order });
        }
        if (ev.data1 === 0x58 && ev.bytes.length >= 4) {
          timeSignatures.push({
            tick: ev.tick,
            numerator: ev.bytes[0],
            denominator: 2 ** ev.bytes[1],
            clocksPerClick: ev.bytes[2],
            thirtySeconds: ev.bytes[3],
            order: ev.order,
          });
        }
      }
    }
    tracks.push({ index: t, name, events });
    r.pos = trackEnd;
  }

  if (format === 0 && tracks.length !== 1) {
    throw new AppError("INVALID_FILE", "Format 0 file must contain exactly one track");
  }

  tempos.sort((a, b) => a.tick - b.tick || a.order - b.order);
  timeSignatures.sort((a, b) => a.tick - b.tick || a.order - b.order);
  if (tempos.length === 0) {
    tempos.push({ tick: 0, usPerQuarter: 500000, order: -1 });
  }
  if (timeSignatures.length === 0) {
    timeSignatures.push({
      tick: 0,
      numerator: 4,
      denominator: 4,
      clocksPerClick: 24,
      thirtySeconds: 8,
      order: -1,
    });
  }

  return { format, ppq, tracks, tempos, timeSignatures };
}

function parseTrack(r: Reader, trackEnd: number, nextOrder: () => number): RawEvent[] {
  const events: RawEvent[] = [];
  let tick = 0;
  let runningStatus = -1;
  let ended = false;

  while (r.pos < trackEnd) {
    const delta = r.varLen();
    tick += delta;
    let status = r.u8();

    if (status < 0x80) {
      if (runningStatus < 0) {
        throw new AppError("INVALID_FILE", "Running status used without a prior status byte");
      }
      status = runningStatus;
      r.pos -= 1;
    } else {
      runningStatus = status;
    }

    const high = status & 0xf0;
    const channel = status & 0x0f;
    const ord = nextOrder();

    if (status === 0xff) {
      const metaType = r.u8();
      const len = r.varLen();
      const payload = r.bytes(len);
      events.push({
        tick, kind: "meta", channel: -1, data1: metaType, data2: -1,
        bytes: payload, status, order: ord,
      });
      if (metaType === 0x2f) ended = true;
    } else if (status === 0xf0 || status === 0xf7) {
      const len = r.varLen();
      const payload = r.bytes(len);
      events.push({
        tick, kind: "sysex", channel: -1, data1: status, data2: -1,
        bytes: payload, status, order: ord,
      });
    } else if (high >= 0x80 && high <= 0xe0) {
      const d1 = r.u8();
      let d2 = 0;
      const oneByte = high === 0xc0 || high === 0xd0;
      if (!oneByte) d2 = r.u8();
      let kind: RawEvent["kind"] = "raw";
      if (high === 0x90) kind = d2 === 0 ? "noteOff" : "noteOn";
      else if (high === 0x80) kind = "noteOff";
      else if (high === 0xc0) kind = "programChange";
      else if (high === 0xb0) kind = "controlChange";
      events.push({
        tick, kind, channel, data1: d1,
        data2: oneByte ? -1 : d2, bytes: [], status, order: ord,
      });
    } else {
      throw new AppError("INVALID_FILE", `Unsupported status byte 0x${status.toString(16)}`);
    }
    if (r.pos > trackEnd) {
      throw new AppError("TRUNCATED_FILE", "Track event extends beyond declared track length");
    }
  }

  if (!ended) {
    throw new AppError("TRUNCATED_FILE", "Track missing End Of Track meta event");
  }
  return events;
}
