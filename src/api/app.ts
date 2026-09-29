import type { IncomingMessage, ServerResponse } from "node:http";
import { AppError, isAppError, type ErrorCode } from "../errors.ts";
import { Store } from "../store.ts";
import { pairNotes } from "../midi/notes.ts";
import { TimingEngine } from "../midi/timing.ts";
import { intParam, optionalInt, numberParam, paging, requireBody } from "./validation.ts";

const HTTP_STATUS: Record<ErrorCode, number> = {
  INVALID_FILE: 400,
  UNSUPPORTED_SMPTE: 422,
  TRUNCATED_FILE: 400,
  UNSUPPORTED_FORMAT: 422,
  NOT_FOUND: 404,
  VALIDATION: 400,
  OUT_OF_RANGE: 422,
  CONFLICT: 409,
  BAD_REQUEST: 400,
  INTERNAL: 500,
};

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

function readBody(req: IncomingMessage, maxBytes = 20 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new AppError("BAD_REQUEST", `Body exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function createApi(store: Store) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";
    try {
      await route(req, res, url, path, method, store);
    } catch (e) {
      if (isAppError(e)) {
        send(res, HTTP_STATUS[e.code], { error: e.code, message: e.message, details: e.details ?? null });
      } else {
        send(res, 500, {
          error: "INTERNAL",
          message: e instanceof Error ? e.message : "Unknown error",
        });
      }
    }
  };
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  path: string,
  method: string,
  store: Store,
): Promise<void> {
  const q = url.searchParams;

  if (path === "/health" && method === "GET") {
    return send(res, 200, { ok: true });
  }

  if (path === "/songs" && method === "GET") {
    const { limit, offset } = paging(q);
    return send(res, 200, store.listSongs(limit, offset));
  }

  if (path === "/songs" && method === "POST") {
    const raw = await readBody(req);
    const contentType = req.headers["content-type"] ?? "";
    const name = q.get("name") ?? req.headers["x-song-name"]?.toString() ?? "imported.mid";
    let bytes: Buffer;
    if (contentType.includes("application/json")) {
      const body = requireBody<{ name?: string; dataBase64?: string; data?: string }>(
        JSON.parse(raw.toString("utf8") || "{}"),
      );
      const dataB64 = body.dataBase64 ?? body.data;
      if (!dataB64) throw new AppError("VALIDATION", "dataBase64 is required");
      bytes = Buffer.from(dataB64, "base64");
      const result = store.importSong(body.name ?? name, bytes);
      return send(res, 201, result);
    }
    const result = store.importSong(name, raw);
    return send(res, 201, result);
  }

  const songMatch = path.match(/^\/songs\/(\d+)$/);
  if (songMatch && method === "GET") {
    return send(res, 200, store.getSong(intParam(songMatch[1], "id")));
  }

  const tracksMatch = path.match(/^\/songs\/(\d+)\/tracks$/);
  if (tracksMatch && method === "GET") {
    const songId = intParam(tracksMatch[1], "id");
    const { limit, offset } = paging(q);
    const versionId = optionalInt(q.get("versionId") ?? undefined, "versionId");
    const v = versionId ?? store.latestVersion(songId).id;
    const { file } = store.loadVersion(songId, v);
    const notes = pairNotes(file);
    const trackFilter = optionalInt(q.get("trackIndex") ?? undefined, "trackIndex", { min: 0 });
    const channelFilter = optionalInt(q.get("channel") ?? undefined, "channel", { min: 0, max: 15 });
    let items = notes;
    if (trackFilter !== undefined) items = items.filter((n) => n.trackIndex === trackFilter);
    if (channelFilter !== undefined) items = items.filter((n) => n.channel === channelFilter);
    const total = items.length;
    const page = items.slice(offset, offset + limit);
    return send(res, 200, {
      versionId: v,
      ppq: file.ppq,
      tracks: file.tracks.map((t) => ({ index: t.index, name: t.name, eventCount: t.events.length })),
      total, limit, offset,
      notes: page,
    });
  }

  const timingMatch = path.match(/^\/songs\/(\d+)\/timing$/);
  if (timingMatch && method === "GET") {
    const songId = intParam(timingMatch[1], "id");
    const versionId = optionalInt(q.get("versionId") ?? undefined, "versionId");
    const v = versionId ?? store.latestVersion(songId).id;
    const { file } = store.loadVersion(songId, v);
    const engine = new TimingEngine(file);
    const tickQ = q.get("tick");
    const msQ = q.get("ms");
    if (tickQ !== null) {
      const tick = numberParam(tickQ, "tick");
      return send(res, 200, { tick, ms: engine.tickToMs(tick), location: engine.locate(Math.round(tick)) });
    }
    if (msQ !== null) {
      const ms = numberParam(msQ, "ms");
      if (ms < 0) throw new AppError("VALIDATION", "ms must be >= 0");
      const tick = engine.msToTick(ms);
      return send(res, 200, { ms, tick, location: engine.locate(Math.round(tick)) });
    }
    throw new AppError("VALIDATION", "Provide either tick or ms query parameter");
  }

  const versionsMatch = path.match(/^\/songs\/(\d+)\/versions$/);
  if (versionsMatch && method === "GET") {
    const songId = intParam(versionsMatch[1], "id");
    const { limit, offset } = paging(q);
    return send(res, 200, store.listVersions(songId, limit, offset));
  }

  const transposeMatch = path.match(/^\/songs\/(\d+)\/transpose$/);
  if (transposeMatch && method === "POST") {
    const songId = intParam(transposeMatch[1], "id");
    const body = requireBody<{
      semitones: number; channels?: number[]; includeDrums?: boolean; baseVersionId?: number;
    }>(JSON.parse((await readBody(req)).toString("utf8") || "{}"));
    const semitones = intParam(body.semitones, "semitones", { min: -127, max: 127 });
    return send(res, 201, store.transpose(songId, body.baseVersionId ?? null, {
      semitones,
      channels: body.channels,
      includeDrums: body.includeDrums,
    }));
  }

  const instrumentMatch = path.match(/^\/songs\/(\d+)\/instrument$/);
  if (instrumentMatch && method === "POST") {
    const songId = intParam(instrumentMatch[1], "id");
    const body = requireBody<{
      trackIndex: number; channel: number; program: number; baseVersionId?: number;
    }>(JSON.parse((await readBody(req)).toString("utf8") || "{}"));
    const trackIndex = intParam(body.trackIndex, "trackIndex", { min: 0 });
    const channel = intParam(body.channel, "channel", { min: 0, max: 15 });
    const program = intParam(body.program, "program", { min: 0, max: 127 });
    return send(res, 201, store.setInstrument(
      songId, body.baseVersionId ?? null, trackIndex, channel, program,
    ));
  }

  const qPreviewMatch = path.match(/^\/songs\/(\d+)\/quantize\/preview$/);
  if (qPreviewMatch && method === "POST") {
    const songId = intParam(qPreviewMatch[1], "id");
    const body = requireBody<{ gridBeats: number; channels?: number[]; baseVersionId?: number }>(
      JSON.parse((await readBody(req)).toString("utf8") || "{}"),
    );
    const gridBeats = numberParam(body.gridBeats, "gridBeats");
    if (gridBeats <= 0) throw new AppError("VALIDATION", "gridBeats must be positive");
    return send(res, 200, store.quantizePreview(songId, body.baseVersionId ?? null, {
      gridBeats, channels: body.channels,
    }));
  }

  const quantizeMatch = path.match(/^\/songs\/(\d+)\/quantize$/);
  if (quantizeMatch && method === "POST") {
    const songId = intParam(quantizeMatch[1], "id");
    const body = requireBody<{ gridBeats: number; channels?: number[]; baseVersionId?: number }>(
      JSON.parse((await readBody(req)).toString("utf8") || "{}"),
    );
    const gridBeats = numberParam(body.gridBeats, "gridBeats");
    if (gridBeats <= 0) throw new AppError("VALIDATION", "gridBeats must be positive");
    return send(res, 201, store.quantize(songId, body.baseVersionId ?? null, {
      gridBeats, channels: body.channels,
    }));
  }

  const exportMatch = path.match(/^\/songs\/(\d+)\/export$/);
  if (exportMatch && method === "POST") {
    const songId = intParam(exportMatch[1], "id");
    const body = requireBody<{ versionId?: number; idempotencyKey?: string }>(
      JSON.parse((await readBody(req)).toString("utf8") || "{}"),
    );
    const result = store.exportMidi(songId, body.versionId ?? null, body.idempotencyKey);
    res.writeHead(200, {
      "content-type": "audio/midi",
      "content-disposition": `attachment; filename="song-${songId}-v.mid"`,
      "x-batch-id": String(result.batchId),
      "x-sha256": result.sha256,
      "x-idempotent-reused": result.reused ? "true" : "false",
    });
    return res.end(result.bytes);
  }

  throw new AppError("NOT_FOUND", `No route for ${method} ${path}`);
}
