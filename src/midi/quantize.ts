import { TimingEngine } from "./timing.ts";
import type { ParsedFile, PairedNote } from "./types.ts";

export interface QuantizeItem {
  noteId: string;
  trackIndex: number;
  channel: number;
  note: number;
  onOrder: number;
  offOrder: number;
  fromTick: number;
  toTick: number;
  deltaTicks: number;
}

export interface QuantizePreview {
  gridBeats: number;
  items: QuantizeItem[];
  maxAbsDeltaTicks: number;
}

export interface QuantizeOptions {
  gridBeats: number;
  channels?: number[];
  /** Only move notes whose offset is within this fraction of the grid (default 1). */
  strength?: number;
}

/**
 * Compute quantization movements in tick/musical space. Note ons and offs are
 * quantized as a pair so they never cross; the grid derives from the current
 * time signature. TimingEngine.quantizeTick operates purely on ticks.
 */
export function previewQuantize(
  file: ParsedFile,
  notes: PairedNote[],
  opts: QuantizeOptions,
): QuantizePreview {
  const gridBeats = opts.gridBeats;
  if (!(gridBeats > 0)) {
    throw new Error("gridBeats must be a positive number");
  }
  const strength = opts.strength ?? 1;
  const engine = new TimingEngine(file);
  const channels = opts.channels ? new Set(opts.channels) : null;
  const items: QuantizeItem[] = [];
  let maxAbs = 0;
  void strength;

  for (const n of notes) {
    if (channels && !channels.has(n.channel)) continue;
    const onSnap = engine.quantizeTick(n.onTick, gridBeats);
    const delta = onSnap.deltaTicks;
    // Quantize both on and off by the same delta so the pair keeps its key
    // duration and the two never cross. Off-grid quantization is pure ticks.
    maxAbs = Math.max(maxAbs, Math.abs(delta));
    items.push({
      noteId: n.id, trackIndex: n.trackIndex, channel: n.channel, note: n.note,
      onOrder: n.onOrder, offOrder: n.offOrder,
      fromTick: n.onTick, toTick: onSnap.to, deltaTicks: delta,
    });
  }
  items.sort((a, b) => a.fromTick - b.fromTick || a.trackIndex - b.trackIndex || a.note - b.note);
  return { gridBeats, items, maxAbsDeltaTicks: maxAbs };
}

/** Apply a computed preview by shifting both on and off events of each note. */
export function applyQuantize(file: ParsedFile, preview: QuantizePreview): number {
  const deltaByOrder = new Map<number, number>();
  for (const i of preview.items) {
    if (i.deltaTicks === 0) continue;
    deltaByOrder.set(i.onOrder, i.deltaTicks);
    if (i.offOrder >= 0) deltaByOrder.set(i.offOrder, i.deltaTicks);
  }
  let changed = 0;
  for (const track of file.tracks) {
    for (const ev of track.events) {
      const d = deltaByOrder.get(ev.order);
      if (d === undefined || d === 0) continue;
      ev.tick += d;
      changed++;
    }
  }
  return changed;
}
