import { buildTempoMap, buildTimeSignatureMap, DEFAULT_TEMPO_US } from './meta.ts'
import type { TempoPoint, TimeSignaturePoint } from './meta.ts'
import type { ParsedMidi } from './types.ts'

export interface BeatLocation {
  tick: number
  measure: number
  beat: number
  /** 0..1 position inside the beat */
  beatFraction: number
  numerator: number
  denominator: number
  ticksPerBeat: number
  bpm: number
  ms: number
}

/**
 * Full tempo/beat graph for a document. All conversion is driven by the
 * complete tempo map; time is never quantized before beat math.
 */
export class TimingMap {
  readonly tempo: TempoPoint[]
  readonly timeSigs: TimeSignaturePoint[]
  /** cumulative milliseconds at each tempo point tick */
  private readonly msAtPoint: number[]
  readonly doc: ParsedMidi

  constructor(doc: ParsedMidi) {
    this.doc = doc
    this.tempo = buildTempoMap(doc)
    this.timeSigs = buildTimeSignatureMap(doc)
    this.msAtPoint = [0]
    for (let i = 0; i < this.tempo.length; i++) {
      const point = this.tempo[i]
      const prevTick = i === 0 ? 0 : this.tempo[i - 1].tick
      const prevUs = i === 0 ? DEFAULT_TEMPO_US : this.tempo[i - 1].usPerQuarter
      this.msAtPoint[i] ??= 0
      const deltaTicks = point.tick - prevTick
      this.msAtPoint[i + 1] =
        this.msAtPoint[i] + (deltaTicks * prevUs) / doc.ppq / 1000
    }
  }

  /** Microseconds-per-quarter in effect at a tick. */
  usPerQuarterAt(tick: number): number {
    let us = DEFAULT_TEMPO_US
    for (const point of this.tempo) {
      if (point.tick <= tick) us = point.usPerQuarter
      else break
    }
    return us
  }

  bpmAt(tick: number): number {
    return 60_000_000 / this.usPerQuarterAt(tick)
  }

  tickToMs(tick: number): number {
    if (this.tempo.length === 0) return (tick * DEFAULT_TEMPO_US) / this.doc.ppq / 1000
    let idx = 0
    while (idx < this.tempo.length && this.tempo[idx].tick <= tick) idx++
    // idx = first point strictly after tick
    const segStartTick = idx === 0 ? 0 : this.tempo[idx - 1].tick
    const segStartMs = idx === 0 ? 0 : this.msAtPoint[idx]
    const segUs = idx === 0 ? DEFAULT_TEMPO_US : this.tempo[idx - 1].usPerQuarter
    return segStartMs + ((tick - segStartTick) * segUs) / this.doc.ppq / 1000
  }

  /** Inverse mapping; may return fractional ticks. */
  msToTick(ms: number): number {
    if (this.tempo.length === 0) return (ms * 1000 * this.doc.ppq) / DEFAULT_TEMPO_US
    let idx = 0
    while (idx < this.tempo.length && this.msAtPoint[idx + 1] <= ms + 1e-9) idx++
    const segStartTick = idx === 0 ? 0 : this.tempo[idx - 1].tick
    const segStartMs = idx === 0 ? 0 : this.msAtPoint[idx]
    const segUs = idx === 0 ? DEFAULT_TEMPO_US : this.tempo[idx - 1].usPerQuarter
    return segStartTick + ((ms - segStartMs) * 1000 * this.doc.ppq) / segUs
  }

  private sigAt(tick: number): { sig: TimeSignaturePoint | null; index: number } {
    let active: TimeSignaturePoint | null = null
    let index = -1
    for (let i = 0; i < this.timeSigs.length; i++) {
      if (this.timeSigs[i].tick <= tick) {
        active = this.timeSigs[i]
        index = i
      } else break
    }
    return { sig: active, index }
  }

  /**
   * Resolve a tick to musical position. Signature changes are assumed to land
   * on bar boundaries; beats use the active denominator.
   */
  locate(tick: number): BeatLocation {
    const { sig, index } = this.sigAt(tick)
    const numerator = sig?.numerator ?? 4
    const denominator = sig?.denominator ?? 4
    const ticksPerBeat = (this.doc.ppq * 4) / denominator
    const regionStartTick = sig?.tick ?? 0
    const offsetBeats = (tick - regionStartTick) / ticksPerBeat
    // bars elapsed since the most recent signature change (it sits on a bar line)
    const barsIntoRegion = Math.floor(offsetBeats / numerator)
    const beatInBar = Math.floor(offsetBeats - barsIntoRegion * numerator)
    // count all complete bars before the tick, region by region
    let measure = 1
    if (this.timeSigs.length === 0) {
      measure += barsIntoRegion
    } else {
      for (let i = 0; i <= Math.max(index, 0); i++) {
        const regionStart = i === 0 ? 0 : this.timeSigs[i].tick
        const regionEnd = i < this.timeSigs.length - 1 ? this.timeSigs[i + 1].tick : Infinity
        const num = i < this.timeSigs.length ? this.timeSigs[i].numerator : 4
        const den = i < this.timeSigs.length ? this.timeSigs[i].denominator : 4
        const tpb = (this.doc.ppq * 4) / den
        const barsBeforeTick =
          i === index
            ? barsIntoRegion
            : Math.round(((regionEnd as number) - regionStart) / (tpb * num))
        measure += barsBeforeTick
      }
    }
    const beatStartTick = regionStartTick + (barsIntoRegion * numerator + beatInBar) * ticksPerBeat
    return {
      tick,
      measure,
      beat: beatInBar + 1,
      beatFraction: (tick - beatStartTick) / ticksPerBeat,
      numerator,
      denominator,
      ticksPerBeat,
      bpm: this.bpmAt(tick),
      ms: this.tickToMs(tick),
    }
  }

  /** Tick of a musical position (1-based measure/beat, 0-based subdivision). */
  musicalToTick(measure: number, beat: number, beatFraction = 0): number {
    const oneBased = measure - 1
    const zeroBeat = beat - 1 + beatFraction
    if (this.timeSigs.length === 0) {
      return (oneBased * 4 + zeroBeat) * this.doc.ppq
    }
    const sigTicks = this.timeSigs.map((p) => p.tick)
    let regionIndex = 0
    let barsIntoRegion = oneBased
    while (regionIndex < this.timeSigs.length - 1) {
      const sig0 = this.timeSigs[regionIndex]
      const sig0TicksPerBeat = (this.doc.ppq * 4) / sig0.denominator
      // advance when the target bar starts at or beyond the next signature
      const targetTick =
        sigTicks[regionIndex] + barsIntoRegion * sig0TicksPerBeat * sig0.numerator
      if (targetTick < sigTicks[regionIndex + 1]) break
      const regionBars = Math.round(
        (sigTicks[regionIndex + 1] - sigTicks[regionIndex]) /
          (sig0TicksPerBeat * sig0.numerator),
      )
      barsIntoRegion -= regionBars
      regionIndex++
    }
    const tick = sigTicks[regionIndex]
    const sig = this.timeSigs[regionIndex]
    const num = sig?.numerator ?? 4
    const den = sig?.denominator ?? 4
    const ticksPerBeat = (this.doc.ppq * 4) / den
    return tick + (barsIntoRegion * num + zeroBeat) * ticksPerBeat
  }
}
