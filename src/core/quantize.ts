import { TimingMap } from './timing.ts'
import type { PairedNote } from './notes.ts'

export interface QuantizeItem {
  note: PairedNote
  oldOnTick: number
  newOnTick: number
  oldOffTick: number
  newOffTick: number
}

export interface QuantizePlan {
  /** subdivisions per quarter note, e.g. 1 = beats, 2 = eighth notes */
  subdivisionsPerQuarter: number
  items: QuantizeItem[]
}

/**
 * Beat-grid quantization. Grid ticks are derived from PPQ directly so the
 * operation is a musical one; milliseconds are never an intermediate step.
 */
export function planQuantize(
  timing: TimingMap,
  notes: PairedNote[],
  opts: {
    subdivisionsPerQuarter: number
    strength?: number
    trackIndex?: number
    channel?: number
  },
): QuantizePlan {
  const sub = opts.subdivisionsPerQuarter
  if (!Number.isInteger(sub) || sub <= 0) {
    throw new Error('subdivisionsPerQuarter must be a positive integer')
  }
  const strength = opts.strength ?? 1
  if (strength < 0 || strength > 1) throw new Error('strength must be within 0..1')
  const grid = timing.doc.ppq / sub
  if (!Number.isInteger(grid)) {
    throw new Error(`PPQ ${timing.doc.ppq} is not divisible into ${sub} subdivisions`)
  }

  const snap = (tick: number) => {
    const nearest = Math.round(tick / grid) * grid
    return tick + (nearest - tick) * strength
  }

  const items: QuantizeItem[] = []
  for (const note of notes) {
    if (opts.trackIndex !== undefined && note.trackIndex !== opts.trackIndex) continue
    if (opts.channel !== undefined && note.channel !== opts.channel) continue
    if (note.dangling) continue
    const newOn = snap(note.onTick)
    let newOff = snap(note.offTick)
    if (newOff <= newOn) newOff = newOn + grid
    if (newOn !== note.onTick || newOff !== note.offTick) {
      items.push({
        note,
        oldOnTick: note.onTick,
        newOnTick: newOn,
        oldOffTick: note.offTick,
        newOffTick: newOff,
      })
    }
  }
  return { subdivisionsPerQuarter: sub, items }
}
