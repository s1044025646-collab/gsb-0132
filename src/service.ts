import { AppError, ErrorCodes } from './core/errors.ts'
import { pairNotes, type PairedNote } from './core/notes.ts'
import { planQuantize, type QuantizePlan } from './core/quantize.ts'
import { TimingMap } from './core/timing.ts'
import type { ParsedMidi } from './core/types.ts'
import type { Repository } from './storage/repository.ts'

export function paginate(total: number, limit: unknown, offset: unknown): { limit: number; offset: number } {
  const lim = limit === undefined ? 50 : Number(limit)
  const off = offset === undefined ? 0 : Number(offset)
  if (!Number.isInteger(lim) || lim < 1 || lim > 500) {
    throw new AppError(ErrorCodes.VALIDATION, 'limit must be an integer between 1 and 500')
  }
  if (!Number.isInteger(off) || off < 0) {
    throw new AppError(ErrorCodes.VALIDATION, 'offset must be a non-negative integer')
  }
  if (off > total) {
    throw new AppError(ErrorCodes.VALIDATION, `offset ${off} exceeds total ${total}`)
  }
  return { limit: lim, offset: off }
}

export interface DocumentView {
  timing: TimingMap
  notes: PairedNote[]
  doc: ParsedMidi
}

export class SongService {
  private readonly repo: Repository

  constructor(repo: Repository) {
    this.repo = repo
  }

  latestView(songId: number, versionNo?: number): DocumentView & { versionNo: number } {
    const version =
      versionNo === undefined
        ? this.repo.getLatestVersion(songId)
        : this.repo.getVersion(songId, versionNo)
    const doc = this.repo.documentFor(version)
    return {
      doc,
      timing: new TimingMap(doc),
      notes: pairNotes(doc),
      versionNo: version.version_no,
    }
  }

  tracksOverview(songId: number, versionNo?: number) {
    const view = this.latestView(songId, versionNo)
    return view.doc.tracks.map((track, trackIndex) => {
      const channels = new Set<number>()
      const programs = new Map<number, number>()
      let noteCount = 0
      for (const ev of track.events) {
        if (ev.kind !== 'channel') continue
        const ch = ev.status & 0x0f
        if (ev.subtype === 'noteOn' && ev.data2 > 0) {
          channels.add(ch)
          noteCount++
        }
        if (ev.subtype === 'programChange') programs.set(ch, ev.data1)
      }
      const name = track.events.find(
        (e) => e.kind === 'meta' && (e.metaType === 0x03 || e.metaType === 0x04),
      )
      return {
        trackIndex,
        name: name?.kind === 'meta' ? name.data.toString('utf8') : `Track ${trackIndex + 1}`,
        channels: [...channels].sort((a, b) => a - b),
        programs: Object.fromEntries([...programs].sort((a, b) => a[0] - b[0])),
        noteCount,
        empty: noteCount === 0,
        endTick: track.endTick,
        endMs: view.timing.tickToMs(track.endTick),
      }
    })
  }

  notesForTrack(
    songId: number,
    trackIndex: number,
    limit: number,
    offset: number,
    versionNo?: number,
  ) {
    const view = this.latestView(songId, versionNo)
    if (trackIndex < 0 || trackIndex >= view.doc.tracks.length) {
      throw new AppError(ErrorCodes.NOT_FOUND, `track ${trackIndex} not found`, 404)
    }
    const all = view.notes
      .filter((n) => n.trackIndex === trackIndex)
      .map((n) => this.noteDto(n, view.timing))
    const page = paginate(all.length, limit, offset)
    return {
      versionNo: view.versionNo,
      trackIndex,
      total: all.length,
      limit: page.limit,
      offset: page.offset,
      items: all.slice(page.offset, page.offset + page.limit),
    }
  }

  beatAt(songId: number, query: { measure?: number; beat?: number; tick?: number; ms?: number; subdivision?: number }) {
    const view = this.latestView(songId)
    const { timing } = view
    let tick: number
    let source: string
    if (query.tick !== undefined) {
      tick = Number(query.tick)
      source = 'tick'
    } else if (query.ms !== undefined) {
      tick = timing.msToTick(Number(query.ms))
      source = 'ms'
    } else if (query.measure !== undefined) {
      tick = timing.musicalToTick(
        Number(query.measure),
        Number(query.beat ?? 1),
        Number(query.subdivision ?? 0),
      )
      source = 'beat'
    } else {
      throw new AppError(ErrorCodes.VALIDATION, 'provide one of: tick, ms, or measure')
    }
    if (!Number.isFinite(tick) || tick < 0) {
      throw new AppError(ErrorCodes.VALIDATION, 'resolved tick must be a non-negative number')
    }
    return { source, ...timing.locate(tick), ms: timing.tickToMs(tick) }
  }

  quantizePreview(
    songId: number,
    subdivisionsPerQuarter: number,
    opts: { strength?: number; trackIndex?: number; channel?: number; versionNo?: number },
  ): QuantizePlan {
    const view = this.latestView(songId, opts.versionNo)
    return planQuantize(view.timing, view.notes, {
      subdivisionsPerQuarter,
      strength: opts.strength,
      trackIndex: opts.trackIndex,
      channel: opts.channel,
    })
  }

  private noteDto(note: PairedNote, timing: TimingMap) {
    return {
      channel: note.channel + 1,
      percussion: note.channel === 9,
      pitch: note.pitch,
      velocity: note.velocity,
      onTick: note.onTick,
      offTick: note.offTick,
      onMs: timing.tickToMs(note.onTick),
      offMs: note.dangling ? null : timing.tickToMs(note.offTick),
      keyDurationTicks: note.keyDurationTicks,
      soundingDurationTicks: note.soundingDurationTicks,
      extendedBySustainTicks: note.soundingDurationTicks - note.keyDurationTicks,
      dangling: note.dangling,
      beatOn: timing.locate(note.onTick),
    }
  }
}
