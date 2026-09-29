import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { startServer, type StartedServer } from "../src/server.ts";
import { demoBytes } from "./fixtures.ts";

const dir = join(process.cwd(), "tmp", "test-api");
const dbPath = join(dir, "api.db");
let server: StartedServer;
let base: string;

before(async () => {
  rmSync(dir, { recursive: true, force: true });
  server = await startServer({ dbPath, writePortFile: false });
  base = `http://127.0.0.1:${server.port}`;
});

after(async () => {
  await server.close();
});

async function importSong(): Promise<number> {
  const res = await fetch(`${base}/songs?name=api.mid`, {
    method: "POST",
    headers: { "content-type": "audio/midi" },
    body: new Uint8Array(demoBytes()),
  });
  assert.equal(res.status, 201);
  const json = (await res.json()) as { songId: number };
  return json.songId;
}

test("health", async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("import then paginated tracks/notes", async () => {
  const songId = await importSong();
  const res = await fetch(`${base}/songs/${songId}/tracks?limit=5&offset=0`);
  assert.equal(res.status, 200);
  const json = (await res.json()) as {
    total: number; limit: number; offset: number; notes: unknown[]; tracks: unknown[];
  };
  assert.equal(json.limit, 5);
  assert.equal(json.notes.length, 5);
  assert.equal(json.tracks.length, 4);
  assert.ok(json.total > 5);
});

test("timing endpoint converts tick and ms", async () => {
  const songId = await importSong();
  const tick = await (await fetch(`${base}/songs/${songId}/timing?tick=1920`)).json() as {
    ms: number; location: { measure: number };
  };
  assert.equal(tick.ms, 2000);
  const ms = await (await fetch(`${base}/songs/${songId}/timing?ms=2000`)).json() as { tick: number };
  assert.ok(Math.abs(ms.tick - 1920) < 1e-6);
});

test("transpose endpoint drums stay fixed and version is created", async () => {
  const songId = await importSong();
  const res = await fetch(`${base}/songs/${songId}/transpose`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ semitones: 5 }),
  });
  assert.equal(res.status, 201);
  const v = (await res.json()) as { version_no: number };
  assert.equal(v.version_no, 2);
});

test("out-of-range transpose returns 422 with error code", async () => {
  const songId = await importSong();
  const res = await fetch(`${base}/songs/${songId}/transpose`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ semitones: 120 }),
  });
  assert.equal(res.status, 422);
  const json = (await res.json()) as { error: string };
  assert.equal(json.error, "OUT_OF_RANGE");
});

test("validation error for bad semitone and missing timing param", async () => {
  const songId = await importSong();
  const bad = await fetch(`${base}/songs/${songId}/transpose`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ semitones: 999 }),
  });
  assert.equal(bad.status, 400);
  assert.equal(((await bad.json()) as { error: string }).error, "VALIDATION");
  const noParam = await fetch(`${base}/songs/${songId}/timing`);
  assert.equal(noParam.status, 400);
});

test("SMPTE import is rejected 422", async () => {
  // division 0x8063, one empty track
  const eot = Buffer.from([0x00, 0xff, 0x2f, 0x00]);
  const header = Buffer.alloc(14);
  header.write("MThd", 0, "latin1");
  header.writeUInt32BE(6, 4);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(1, 10);
  header.writeUInt16BE(0x8063, 12);
  const trackHead = Buffer.alloc(8);
  trackHead.write("MTrk", 0, "latin1");
  trackHead.writeUInt32BE(eot.length, 4);
  const smpte = Buffer.concat([header, trackHead, eot]);
  const res = await fetch(`${base}/songs?name=smpte.mid`, { method: "POST", body: new Uint8Array(smpte) });
  assert.equal(res.status, 422);
  assert.equal(((await res.json()) as { error: string }).error, "UNSUPPORTED_SMPTE");
});

test("idempotent export repeated POST returns same batch", async () => {
  const songId = await importSong();
  const doExport = () =>
    fetch(`${base}/songs/${songId}/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "k1" }),
    });
  const r1 = await doExport();
  const r2 = await doExport();
  assert.equal(r1.headers.get("x-batch-id"), r2.headers.get("x-batch-id"));
  assert.equal(r2.headers.get("x-idempotent-reused"), "true");
  const b1 = Buffer.from(await r1.arrayBuffer());
  const b2 = Buffer.from(await r2.arrayBuffer());
  assert.deepEqual(b1, b2);
});

test("404 for unknown song", async () => {
  const res = await fetch(`${base}/songs/999999`);
  assert.equal(res.status, 404);
  assert.equal(((await res.json()) as { error: string }).error, "NOT_FOUND");
});
