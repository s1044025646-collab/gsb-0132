import { createServer, type IncomingMessage, type Server } from 'node:http'
import { resolve } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { AppError } from './core/errors.ts'
import { openDatabase } from './storage/db.ts'
import { Repository } from './storage/repository.ts'
import { SongService, paginate } from './service.ts'

export interface ApiDeps {
  dbPath: string
  exportDir: string
  clock?: () => number
}

interface Response {
  status: number
  body: unknown
}

export function createApiApp(deps: ApiDeps): Server {
  const db = openDatabase(deps.dbPath)
  const repo = new Repository(db, deps.clock)
  const service = new SongService(repo)
  mkdirSync(deps.exportDir, { recursive: true })

  const server = createServer(async (req, res) => {
    try {
      const result = await route(req, repo, service, deps.exportDir)
      res.writeHead(result.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(result.body))
    } catch (err) {
      const out = toError(err)
      res.writeHead(out.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(out.body))
    }
  })
  const realClose = server.close.bind(server)
  server.close = ((cb?: (err?: Error) => void) => {
    realClose((err) => {
      db.close()
      cb?.(err)
    })
  }) as Server['close']
  return server
}

async function readJson(req: IncomingMessage): Promise<any> {
  if (req.method === 'GET') return {}
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array))
  const raw = Buffer.concat(chunks)
  if (raw.length === 0) return {}
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch {
    throw new AppError('VALIDATION_FAILED', 'request body is not valid JSON')
  }
}

function requireInt(value: unknown, name: string, min: number, max?: number): number {
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || (max !== undefined && n > max)) {
    throw new AppError('VALIDATION_FAILED', `${name} must be an integer${max !== undefined ? ` between ${min} and ${max}` : ` >= ${min}`}`)
  }
  return n
}

async function route(
  req: IncomingMessage,
  repo: Repository,
  service: SongService,
  exportDir: string,
): Promise<Response> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const path = url.pathname
  const body = await readJson(req)

  if (req.method === 'POST' && path === '/songs/import') {
    const name = typeof body.name === 'string' && body.name.trim() ? body.name : undefined
    if (!name) throw new AppError('VALIDATION_FAILED', 'name is required')
    const bytes = body.midiBase64
    if (typeof bytes !== 'string' || !bytes) {
      throw new AppError('VALIDATION_FAILED', 'midiBase64 is required')
    }
    let decoded: Buffer
    try {
      decoded = Buffer.from(bytes, 'base64')
    } catch {
      throw new AppError('VALIDATION_FAILED', 'midiBase64 is not valid base64')
    }
    const result = repo.importSong(name, decoded)
    return { status: 201, body: result }
  }

  if (req.method === 'GET' && path === '/songs') {
    const page = paginate(
      Number.MAX_SAFE_INTEGER,
      url.searchParams.get('limit') ?? 50,
      url.searchParams.get('offset') ?? 0,
    )
    const { items, total } = repo.listSongs(
      page.limit,
      page.offset,
    )
    return { status: 200, body: { total, items } }
  }

  const songMatch = path.match(/^\/songs\/(\d+)(\/.*)?$/)
  if (songMatch) {
    const songId = requireInt(songMatch[1], 'songId', 1)
    const sub = songMatch[2] ?? ''

    if (req.method === 'GET' && sub === '') {
      return { status: 200, body: repo.getSong(songId) }
    }
    if (req.method === 'GET' && sub === '/tracks') {
      return { status: 200, body: { tracks: service.tracksOverview(songId) } }
    }
    if (req.method === 'GET' && sub.startsWith('/tracks/')) {
      const trackIndex = Number(sub.split('/')[2])
      requireInt(trackIndex, 'trackIndex', 0)
      const page = paginate(
        Number.MAX_SAFE_INTEGER,
      url.searchParams.get('limit') ?? 50,
      url.searchParams.get('offset') ?? 0,
      )
      return {
        status: 200,
        body: service.notesForTrack(songId, trackIndex, page.limit, page.offset),
      }
    }
    if (req.method === 'GET' && sub === '/beat') {
      return {
        status: 200,
        body: service.beatAt(songId, {
          measure: url.searchParams.get('measure') ?? undefined,
          beat: url.searchParams.get('beat') ?? undefined,
          tick: url.searchParams.get('tick') ?? undefined,
          ms: url.searchParams.get('ms') ?? undefined,
          subdivision: url.searchParams.get('subdivision') ?? undefined,
        } as never),
      }
    }
    if (req.method === 'GET' && sub === '/versions') {
      const page = paginate(
        Number.MAX_SAFE_INTEGER,
        url.searchParams.get('limit') ?? 50,
        url.searchParams.get('offset') ?? 0,
      )
      const { items, total } = repo.listVersions(songId, page.limit, page.offset)
      return { status: 200, body: { total, items } }
    }
    if (req.method === 'POST' && sub === '/transpose') {
      const semitones = requireInt(body.semitones, 'semitones', -127, 127)
      const result = repo.applyTranspose(songId, {
        semitones,
        trackIndex: body.trackIndex,
        channel: body.channel,
        includePercussion: body.includePercussion === true,
      })
      return { status: 201, body: result }
    }
    if (req.method === 'POST' && sub === '/instrument') {
      const trackIndex = requireInt(body.trackIndex, 'trackIndex', 0)
      const channel = requireInt(body.channel, 'channel', 0, 15)
      const program = requireInt(body.program, 'program', 0, 127)
      const result = repo.applyInstrument(songId, { trackIndex, channel, program })
      return { status: 201, body: result }
    }
    if (req.method === 'POST' && sub === '/quantize-preview') {
      const subPerQ = requireInt(body.subdivisionsPerQuarter, 'subdivisionsPerQuarter', 1)
      const plan = service.quantizePreview(songId, subPerQ, {
        strength: body.strength,
        trackIndex: body.trackIndex,
        channel: body.channel,
      })
      return { status: 200, body: plan }
    }
    if (req.method === 'POST' && sub === '/exports') {
      const key = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined
      if (!key) throw new AppError('VALIDATION_FAILED', 'idempotencyKey is required')
      const versionNo = body.version === 'latest' || body.version === undefined ? 'latest' : requireInt(body.version, 'version', 1)
      const fileName = `song${songId}-v${versionNo}-${key}.mid`
      const filePath = resolve(exportDir, fileName)
      const result = repo.exportVersion(songId, versionNo, key, filePath)
      if (!result.reused) writeFileSync(filePath, result.bytes!)
      return {
        status: 201,
        body: {
          versionId: result.versionId,
          path: result.path,
          sha256: result.sha256,
          byteCount: result.byteCount,
          reused: result.reused,
        },
      }
    }
  }

  if (req.method === 'GET' && path === '/health') {
    return { status: 200, body: { ok: true } }
  }
  throw new AppError('NOT_FOUND', `route ${req.method} ${path} not found`, 404)
}

function toError(err: unknown): Response {
  if (err instanceof AppError) {
    return {
      status: err.status,
      body: { error: { code: err.code, message: err.message, details: err.details ?? null } },
    }
  }
  const message = err instanceof Error ? err.message : 'unknown error'
  return {
    status: 500,
    body: { error: { code: 'INTERNAL_ERROR', message } },
  }
}

const isMain = import.meta.filename === process.argv[1] || process.argv[1]?.endsWith('api.ts')
if (isMain) {
  const port = process.env.PORT ? Number(process.env.PORT) : 0
  const app = createApiApp({
    dbPath: resolve('data/app.sqlite'),
    exportDir: resolve('data/exports'),
  })
  app.listen(port, '127.0.0.1', () => {
    const address = app.address()
    const actual = typeof address === 'object' && address ? address.port : port
    console.log(`MIDI API listening on http://127.0.0.1:${actual}`)
  })
}
