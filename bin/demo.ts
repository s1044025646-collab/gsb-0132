import { rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../src/db/database.ts";
import { Store } from "../src/store.ts";
import { buildDemoFile } from "../src/midi/generator.ts";
import { writeMidi } from "../src/midi/writer.ts";
import { parseMidi } from "../src/midi/parser.ts";
import { TimingEngine } from "../src/midi/timing.ts";
import { pairNotes } from "../src/midi/notes.ts";

const root = process.cwd();
const tmp = join(root, "tmp", "demo");
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

const dbPath = join(tmp, "demo.db");
const db = openDatabase(dbPath);
const fixedNow = (() => {
  let t = Date.parse("2026-01-01T00:00:00Z");
  return () => new Date((t += 1000));
})();
const store = new Store(db, fixedNow);

const demo = buildDemoFile();
const inputPath = join(tmp, "demo.mid");
writeFileSync(inputPath, writeMidi(demo));

const imported = store.importSong("demo.mid", readFileSync(inputPath));
console.log("1) imported", imported);

const { file: before } = store.loadVersion(imported.songId, imported.versionId);
const beforeNotes = pairNotes(before).filter((n) => n.channel !== 9);
console.log("2) non-drum notes before transpose:", beforeNotes.length,
  "pitch range", Math.min(...beforeNotes.map((n) => n.note)), "-", Math.max(...beforeNotes.map((n) => n.note)));

const transposed = store.transpose(imported.songId, null, { semitones: 2 });
console.log("3) transpose +2 -> version", transposed.version_no, transposed.label);
const { file: after } = store.loadVersion(imported.songId, transposed.id);
const afterNotes = pairNotes(after).filter((n) => n.channel !== 9);
console.log("   non-drum pitch range after:",
  Math.min(...afterNotes.map((n) => n.note)), "-", Math.max(...afterNotes.map((n) => n.note)));
const drums = pairNotes(after).filter((n) => n.channel === 9);
console.log("   drum pitches preserved:", new Set(drums.map((n) => n.note)));

const engine = new TimingEngine(after);
console.log("4) timing tick=1920 -> ms", engine.tickToMs(1920).toFixed(2),
  "roundtrip tick", engine.msToTick(engine.tickToMs(1920)).toFixed(3));
console.log("   locate 4320:", engine.locate(4320));

const inst = store.setInstrument(imported.songId, null, 1, 0, 40);
console.log("5) instrument -> version", inst.version_no);

const preview = store.quantizePreview(imported.songId, null, { gridBeats: 1 });
console.log("6) quantize preview affected:", preview.items.length, "maxDelta", preview.maxAbsDeltaTicks);

const exp1 = store.exportMidi(imported.songId, null, "demo-key");
const exp2 = store.exportMidi(imported.songId, null, "demo-key");
console.log("7) export batch", exp1.batchId, "reused on repeat:", exp2.reused, "same sha:", exp1.sha256 === exp2.sha256);
const outPath = join(tmp, "demo-export.mid");
writeFileSync(outPath, exp1.bytes);
const reparsed = parseMidi(readFileSync(outPath));
console.log("8) reparse export: format", reparsed.format, "tracks", reparsed.tracks.length);

const versions = store.listVersions(imported.songId, 50, 0);
console.log("9) versions:", versions.items.map((v) => `${v.version_no}:${v.op_type}`).join(" "));
console.log("Demo artifacts in", tmp);
db.close();
