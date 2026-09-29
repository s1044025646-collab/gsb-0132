#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "./db/database.ts";
import { Store } from "./store.ts";
import { TimingEngine } from "./midi/timing.ts";
import { pairNotes } from "./midi/notes.ts";
import { effectiveProgram } from "./midi/transform.ts";
import { AppError, isAppError } from "./errors.ts";

const dbPath = process.env.MIDI_DB ?? join(process.cwd(), "data", "midi.db");
const db = openDatabase(dbPath);
const store = new Store(db);

function parseFlags(args: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) map.set(key, "true");
      else {
        map.set(key, next);
        i++;
      }
    }
  }
  return map;
}

function num(map: Map<string, string>, key: string): number {
  const v = map.get(key);
  if (v === undefined) throw new AppError("VALIDATION", `--${key} is required`);
  const n = Number(v);
  if (!Number.isFinite(n)) throw new AppError("VALIDATION", `--${key} must be a number`);
  return n;
}

function versionSummary(songId: number): string {
  const v = store.latestVersion(songId);
  return `song=${songId} latestVersion=${v.version_no} (id=${v.id}) label="${v.label}"`;
}

function snapshot(songId: number): { tracks: string[] } {
  const v = store.latestVersion(songId);
  const { file } = store.loadVersion(songId, v.id);
  const notes = pairNotes(file);
  const tracks = file.tracks.map((t) => {
    const channels = new Set(
      t.events.filter((e) => e.channel >= 0).map((e) => e.channel),
    );
    const progs = [...channels].map((c) => {
      const p = effectiveProgram(file, t.index, c);
      return `ch${c}:prog=${p ?? "-"}`;
    });
    const nCount = notes.filter((n) => n.trackIndex === t.index).length;
    return `  track[${t.index}] "${t.name}" events=${t.events.length} notes=${nCount} ${progs.join(" ")}`;
  });
  return { tracks };
}

function printSnapshot(title: string, songId: number): void {
  console.log(`-- ${title}: ${versionSummary(songId)}`);
  for (const line of snapshot(songId).tracks) console.log(line);
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);

  switch (cmd) {
    case "import": {
      const file = flags.get("file");
      if (!file) throw new AppError("VALIDATION", "--file <path> is required");
      const name = flags.get("name") ?? file;
      const bytes = readFileSync(file);
      const { songId, versionId } = store.importSong(name, bytes);
      console.log(`Imported "${name}" -> songId=${songId} versionId=${versionId}`);
      printSnapshot("state after import", songId);
      return 0;
    }
    case "songs": {
      const limit = Number(flags.get("limit") ?? "50");
      const offset = Number(flags.get("offset") ?? "0");
      const page = store.listSongs(limit, offset);
      console.log(`songs total=${page.total} limit=${page.limit} offset=${page.offset}`);
      for (const s of page.items) {
        console.log(`  [${s.id}] ${s.name} format=${s.format} ppq=${s.ppq}`);
      }
      return 0;
    }
    case "notes": {
      const songId = num(flags, "song");
      const trackIndex = flags.has("track") ? Number(flags.get("track")) : undefined;
      const v = store.latestVersion(songId);
      const { file } = store.loadVersion(songId, v.id);
      const notes = pairNotes(file);
      const filtered = notes.filter((n) => trackIndex === undefined || n.trackIndex === trackIndex);
      console.log(`${versionSummary(songId)} notes=${filtered.length}`);
      for (const n of filtered.slice(0, Number(flags.get("max") ?? "200"))) {
        console.log(
          `  t${n.trackIndex} ch${n.channel} note=${n.note} vel=${n.velocity} ` +
            `on=${n.onTick} off=${n.offTick} key=${n.keyDurationTicks} sound=${n.soundingDurationTicks}` +
            (n.hanging ? " HANGING" : ""),
        );
      }
      return 0;
    }
    case "beat": {
      const songId = num(flags, "song");
      const v = store.latestVersion(songId);
      const { file } = store.loadVersion(songId, v.id);
      const engine = new TimingEngine(file);
      if (flags.has("tick")) {
        const tick = num(flags, "tick");
        const loc = engine.locate(tick);
        console.log(
          `tick=${tick} ms=${engine.tickToMs(tick).toFixed(3)} ` +
            `measure=${loc.measure} beat=${loc.beat} +${loc.tickOffset}t (${loc.numerator}/${loc.denominator})`,
        );
      } else if (flags.has("ms")) {
        const ms = num(flags, "ms");
        const tick = engine.msToTick(ms);
        const loc = engine.locate(Math.round(tick));
        console.log(
          `ms=${ms} tick=${tick.toFixed(3)} measure=${loc.measure} beat=${loc.beat} (${loc.numerator}/${loc.denominator})`,
        );
      } else {
        throw new AppError("VALIDATION", "Provide --tick or --ms");
      }
      return 0;
    }
    case "transpose": {
      const songId = num(flags, "song");
      const semitones = num(flags, "semitones");
      printSnapshot("state BEFORE transpose", songId);
      const version = store.transpose(songId, null, {
        semitones,
        includeDrums: flags.get("include-drums") === "true",
      });
      console.log(`Created version ${version.version_no}: ${version.label}`);
      printSnapshot("state AFTER transpose", songId);
      return 0;
    }
    case "instrument": {
      const songId = num(flags, "song");
      const trackIndex = num(flags, "track");
      const channel = num(flags, "channel");
      const program = num(flags, "program");
      printSnapshot("state BEFORE instrument", songId);
      const version = store.setInstrument(songId, null, trackIndex, channel, program);
      console.log(`Created version ${version.version_no}: ${version.label}`);
      printSnapshot("state AFTER instrument", songId);
      return 0;
    }
    case "quantize-preview": {
      const songId = num(flags, "song");
      const gridBeats = num(flags, "grid");
      const preview = store.quantizePreview(songId, null, { gridBeats });
      console.log(`grid=${gridBeats} beat, affected=${preview.items.length} maxDelta=${preview.maxAbsDeltaTicks}t`);
      for (const i of preview.items.slice(0, Number(flags.get("max") ?? "100"))) {
        console.log(
          `  note=${i.note} ch=${i.channel} t${i.trackIndex} ${i.fromTick} -> ${i.toTick} (${i.deltaTicks >= 0 ? "+" : ""}${i.deltaTicks})`,
        );
      }
      return 0;
    }
    case "export": {
      const songId = num(flags, "song");
      const out = flags.get("out") ?? join(process.cwd(), "tmp", `song-${songId}.mid`);
      const idem = flags.get("idempotency-key");
      const result = store.exportMidi(songId, null, idem);
      writeFileSync(out, result.bytes);
      console.log(
        `Exported batch=${result.batchId} ${result.bytes.length} bytes sha256=${result.sha256} ` +
          `reused=${result.reused} -> ${out}`,
      );
      return 0;
    }
    default:
      console.log(
        [
          "Usage: midi-mapper <command> [flags]",
          "Commands:",
          "  import --file <path> [--name n]",
          "  songs [--limit n] [--offset n]",
          "  notes --song id [--track i] [--max n]",
          "  beat --song id (--tick t | --ms ms)",
          "  transpose --song id --semitones n [--include-drums true]",
          "  instrument --song id --track i --channel c --program p",
          "  quantize-preview --song id --grid beats",
          "  export --song id [--out path] [--idempotency-key k]",
        ].join("\n"),
      );
      return cmd ? 1 : 0;
  }
}

main()
  .then((code) => {
    db.close();
    process.exit(code);
  })
  .catch((e: unknown) => {
    if (isAppError(e)) {
      console.error(`Error [${e.code}]: ${e.message}`);
      if (e.details) console.error(JSON.stringify(e.details));
    } else {
      console.error(e);
    }
    db.close();
    process.exit(1);
  });
