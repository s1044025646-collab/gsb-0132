import type { BeatLocation, ParsedFile, TempoChange, TimeSignature } from "./types.ts";

export interface TempoSegment {
  startTick: number;
  startMs: number;
  usPerQuarter: number;
}

/** Build cumulative segments mapping each tempo region's start tick to a start ms. */
export function buildTempoSegments(ppq: number, tempos: TempoChange[]): TempoSegment[] {
  const sorted = [...tempos].sort((a, b) => a.tick - b.tick || a.order - b.order);
  // Collapse tempo changes at the identical tick to one deterministic value:
  // the earliest in stable parse order wins across a cross-track conflict.
  const unique = sorted.filter((t, i) => i === 0 || t.tick !== sorted[i - 1].tick);
  const segs: TempoSegment[] = [];
  let ms = 0;
  for (let i = 0; i < unique.length; i++) {
    const t = unique[i];
    if (i > 0) {
      const prev = unique[i - 1];
      ms += ticksToMsRaw(t.tick - prev.tick, ppq, prev.usPerQuarter);
    }
    segs.push({ startTick: t.tick, startMs: ms, usPerQuarter: t.usPerQuarter });
  }
  return segs;
}

function ticksToMsRaw(ticks: number, ppq: number, usPerQuarter: number): number {
  return (ticks * usPerQuarter) / ppq / 1000;
}

export class TimingEngine {
  readonly segments: TempoSegment[];

  constructor(readonly file: ParsedFile) {
    this.segments = buildTempoSegments(file.ppq, file.tempos);
  }

  tickToMs(tick: number): number {
    const segs = this.segments;
    let active = segs[0];
    for (const s of segs) {
      if (tick >= s.startTick) active = s;
      else break;
    }
    return active.startMs + ticksToMsRaw(tick - active.startTick, this.file.ppq, active.usPerQuarter);
  }

  msToTick(ms: number): number {
    const segs = this.segments;
    let active = segs[0];
    let nextStartMs = Infinity;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (ms >= s.startMs) {
        active = s;
        nextStartMs = i + 1 < segs.length ? segs[i + 1].startMs : Infinity;
      } else break;
    }
    const us = active.usPerQuarter;
    const intoMs = Math.min(ms, nextStartMs) - active.startMs;
    const ticks = (intoMs * 1000 * this.file.ppq) / us;
    return active.startTick + ticks;
  }

  /** Ticks per quarter beat under a time signature (denominator 4 => ppq). */
  ticksPerBeat(ts: TimeSignature): number {
    return (this.file.ppq * 4) / ts.denominator;
  }

  /**
   * Resolve an absolute tick to a musical beat location.
   * Measures advance by numerator beats; time signatures take effect at their tick.
   */
  locate(tick: number): BeatLocation {
    const sigs = this.file.timeSignatures;
    let sig = sigs[0];
    for (const s of sigs) if (tick >= s.tick) sig = s;
    else break;

    const ticksPerBeat = this.ticksPerBeat(sig);
    const beatsPerMeasure = sig.numerator;
    const measureTicks = ticksPerBeat * beatsPerMeasure;
    const delta = tick - sig.tick;
    const measuresElapsed = Math.floor(delta / measureTicks);
    const intoMeasure = delta - measuresElapsed * measureTicks;
    const beatInMeasure = Math.floor(intoMeasure / ticksPerBeat);
    const tickOffset = intoMeasure - beatInMeasure * ticksPerBeat;

    // Count measure number across prior signatures (each segment starts at measure 1 boundary).
    let measure = 1;
    const sigIndex = sigs.indexOf(sig);
    for (let i = 0; i < sigIndex; i++) {
      const prev = sigs[i];
      const spanTicks = sig.tick - prev.tick;
      const prevBeatTicks = this.ticksPerBeat(prev);
      const prevMeasureTicks = prevBeatTicks * prev.numerator;
      measure += Math.round(spanTicks / prevMeasureTicks);
    }
    measure += measuresElapsed;

    return {
      measure,
      beat: beatInMeasure + 1,
      tickOffset,
      numerator: sig.numerator,
      denominator: sig.denominator,
      ticksPerBeat,
    };
  }

  /**
   * Convert a musical position (1-based measure/beat) to an absolute tick.
   */
  beatToTick(measure: number, beat: number, tickOffset = 0): number {
    const sigs = this.file.timeSignatures;
    // Find which signature region contains the measure by walking measures from tick 0.
    let currentMeasure = 1;
    let sig = sigs[0];
    for (let i = 0; i < sigs.length; i++) {
      const s = sigs[i];
      if (i === 0) {
        sig = s;
        continue;
      }
      const prev = sigs[i - 1];
      const prevMeasureTicks = this.ticksPerBeat(prev) * prev.numerator;
      const measuresInPrev = Math.round((s.tick - prev.tick) / prevMeasureTicks);
      if (measure <= currentMeasure + measuresInPrev - 1) {
        sig = prev;
        break;
      }
      currentMeasure += measuresInPrev;
      sig = s;
    }
    const ticksPerBeat = this.ticksPerBeat(sig);
    const measureTicks = ticksPerBeat * sig.numerator;
    const measureOffset = measure - currentMeasure;
    return (
      sig.tick +
      measureOffset * measureTicks +
      (beat - 1) * ticksPerBeat +
      tickOffset
    );
  }

  /**
   * Snap a tick to the nearest musical grid line. Grid spacing is expressed
   * in beats (e.g. 1 = beat, 0.5 = eighth). Quantization is performed purely
   * in tick/musical space, never via milliseconds.
   */
  quantizeTick(tick: number, gridBeats: number): { from: number; to: number; deltaTicks: number } {
    if (!(gridBeats > 0)) {
      throw new Error("gridBeats must be positive");
    }
    const gridTicks = this.gridTicksForBeat(tick, gridBeats);
    const to = Math.round(tick / gridTicks) * gridTicks;
    return { from: tick, to, deltaTicks: to - tick };
  }

  private gridTicksForBeat(tick: number, gridBeats: number): number {
    const sigs = this.file.timeSignatures;
    let sig = sigs[0];
    for (const s of sigs) if (tick >= s.tick) sig = s;
    else break;
    const ticksPerBeat = this.ticksPerBeat(sig);
    return ticksPerBeat * gridBeats;
  }
}
