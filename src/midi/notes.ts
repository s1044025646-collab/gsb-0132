import type { PairedNote, ParsedFile, RawEvent } from "./types.ts";

const CC_SUSTAIN = 64;

interface Held {
  ev: RawEvent;
}
interface Released {
  held: Held;
  offTick: number;
  offOrder: number;
}

/**
 * Pair note on/off events per track+channel.
 *
 * - Overlapping identical pitches are matched FIFO.
 * - A zero-velocity note-on is treated as a note-off (handled by the parser).
 * - Sustain pedal (CC64 >= 64) keeps released notes sounding until pedal-up,
 *   so key duration (on..off) is distinguished from sounding duration
 *   (on..pedal-up or off when the pedal is up).
 * - Unmatched ons at the track end are reported as hanging notes.
 *
 * Events at the same tick are processed in stable parse order, so a note-off
 * and note-on at the identical tick pair deterministically.
 */
export function pairNotes(file: ParsedFile): PairedNote[] {
  const out: PairedNote[] = [];

  const emit = (
    trackIndex: number,
    held: Held,
    offTick: number,
    offOrder: number,
    soundingEnd: number,
    hanging: boolean,
  ) => {
    const ev = held.ev;
    out.push({
      id: `${trackIndex}:${ev.channel}:${ev.data1}@${ev.tick}#${ev.order}`,
      trackIndex,
      channel: ev.channel,
      note: ev.data1,
      velocity: ev.data2,
      onTick: ev.tick,
      offTick,
      keyDurationTicks: Math.max(0, offTick - ev.tick),
      soundingEndTick: soundingEnd,
      soundingDurationTicks: Math.max(0, soundingEnd - ev.tick),
      hanging,
      onOrder: ev.order,
      offOrder,
    });
  };

  for (const track of file.tracks) {
    const held = new Map<number, Held[]>();
    const sustained = new Map<number, Released[]>();
    const pedalDown = new Set<number>();
    const sorted = [...track.events].sort((a, b) => a.tick - b.tick || a.order - b.order);
    const lastTick = sorted.reduce((m, e) => Math.max(m, e.tick), 0);

    const releaseSustained = (channel: number, atTick: number) => {
      for (const [key, list] of sustained) {
        if ((key / 128 | 0) !== channel) continue;
        for (const rel of list) {
          emit(track.index, rel.held, rel.offTick, rel.offOrder, Math.max(rel.offTick, atTick), false);
        }
        sustained.delete(key);
      }
    };

    for (const ev of sorted) {
      if (ev.channel < 0) continue;
      const pitchKey = ev.channel * 128 + ev.data1;

      if (ev.kind === "noteOn") {
        if (!held.has(pitchKey)) held.set(pitchKey, []);
        held.get(pitchKey)!.push({ ev });
      } else if (ev.kind === "noteOff") {
        const queue = held.get(pitchKey);
        const head = queue?.shift();
        if (!head) continue; // unmatched off is ignored
        if (pedalDown.has(ev.channel)) {
          if (!sustained.has(pitchKey)) sustained.set(pitchKey, []);
          sustained.get(pitchKey)!.push({ held: head, offTick: ev.tick, offOrder: ev.order });
        } else {
          emit(track.index, head, ev.tick, ev.order, ev.tick, false);
        }
      } else if (ev.kind === "controlChange" && ev.data1 === CC_SUSTAIN) {
        const down = ev.data2 >= 64;
        if (down) pedalDown.add(ev.channel);
        else {
          pedalDown.delete(ev.channel);
          releaseSustained(ev.channel, ev.tick);
        }
      }
    }

    // Flush anything still held by the pedal at the end.
    for (const [key, list] of sustained) {
      const channel = (key / 128) | 0;
      for (const rel of list) {
        emit(track.index, rel.held, rel.offTick, rel.offOrder, Math.max(rel.offTick, lastTick), true);
      }
    }
    // Hanging notes: ons with no off.
    for (const [, queue] of held) {
      for (const h of queue) {
        emit(track.index, h, lastTick, -1, lastTick, true);
      }
    }
  }

  out.sort((a, b) => a.onTick - b.onTick || a.onOrder - b.onOrder);
  return out;
}
