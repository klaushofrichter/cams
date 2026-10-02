// A small stand-in for cam-proxy (github.com/klaushofrichter/cam-proxy),
// following its openapi.yaml for the routes cams uses: the event stream,
// clips, stills, previews and SD recordings. Tests set its data and switches
// directly; e2e runs it as a process (bottom of the file).
import express, { type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { mkdtempSync, writeFileSync } from 'fs';
import http from 'http';
import { randomBytes } from 'crypto';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';

export interface FakeClip { id: number; cam: string; start: number; end: number; stream: string; events: number[]; body: Buffer; snapshot?: Buffer }
export interface FakeMessage { id: number; ts: number; cam: string; type: string; data: Record<string, unknown> }
export interface FakeBox { x0: number; y0: number; x1: number; y1: number }
// An analysis as cam-proxy stores it (spec 2026-09-30-analytics-in-cams-design):
// the stream message's shape, plus the full object list.
export interface FakeAnalysis {
  eventId: number;
  kind: string;
  start: number;
  end: number | null;
  provider: string;
  status: string;
  reason: string | null;
  stillTs: number | null;
  summary: { category: string; subtype: string; score: number; box: FakeBox }[];
  objects: { name: string; score: number; box: FakeBox }[];
}

// An SD-card recording as cam-proxy's recordings API lists it (cam-proxy spec
// 2026-10-02-baichuan-recordings-design, section 2). `id` is the camera's file
// name without the folder; the listed `size` is the body's length.
export interface FakeRecording { id: string; start: number; end: number; stream: 'sub' | 'main'; body: Buffer; kinds?: string[]; clipId?: number | null }

export interface FakeProxy {
  url: string;
  token: string;
  clips: FakeClip[];
  stills: Map<string, Map<number, Buffer>>; // cam → ts → jpeg
  previews: Map<string, Map<number, Buffer>>; // cam → minute → sprite
  messages: FakeMessage[];
  oldestId: number; // resuming from an id before this answers `reset`
  offline: boolean; // every request is answered by closing the connection
  requests: { path: string; auth: string | undefined; query: Record<string, unknown> }[];
  publicUrl: string | null; // what /api/cameras reports as the proxy's web address
  camerasBody?: unknown; // tests: answer /api/cameras with this instead
  loginLinks: number; // one-time admin UI links minted (POST /control/login-links)
  compositions: Map<string, { state: 'queued' | 'running' | 'done'; progress: number; durationS: number }>;
  composeRequests: unknown[];
  composeDelayMs: number; // a composition goes running → done over this long
  stillDelayMs: number; // tests: each still image answers this late
  maxStillsInFlight: number; // the most still images served at once (with stillDelayMs)
  maxStillListsInFlight: number; // the most still lists (GET /stills) answered at once (with stillDelayMs)
  streamStatus: number | null; // tests: /api/stream answers this error status
  analyses: Map<string, FakeAnalysis[]>; // proxy camera id → its analyses
  analysesStatus: number | null; // tests: /analyses answers this error (404: an older proxy)
  analysesDelayMs: number; // tests: /analyses answers this late
  analysesStall: boolean; // tests: /analyses sends its headers and the body's start, then nothing
  knownTypes: string[] | null; // tests: the stream refuses other types (an older proxy)
  recordings: Map<string, FakeRecording[]>; // proxy camera id → its SD recordings; a camera without an entry answers 503 camera_offline
  recordingsOverride: { status: number; body: unknown } | null; // tests: every recordings route answers this (after checking its input)
  recordingDropAfter: number | null; // tests: a file sends its headers and this many bytes, then the connection drops
  recordingStallAfter: number | null; // tests: a file sends its headers and this many bytes, then nothing (the connection stays open)
  recordingDelayMs: number; // tests: a file's headers wait this long (the real proxy queues downloads per camera)
  recordingFetches: string[]; // ids of the files served by GET (not HEAD)
  streamConnections(): number;
  push(m: Omit<FakeMessage, 'id' | 'ts'> & { ts?: number }): FakeMessage;
  dropStreams(): void; // ends every open stream (a proxy restart)
  stop(): Promise<void>;
}

export const FAKE_TOKEN = 'fake-proxy-client-token-'.padEnd(48, 'z');
export const FAKE_ADMIN_TOKEN = 'fake-proxy-admin-token-'.padEnd(48, 'a');
export const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]);

export async function startFakeProxy(opts: { port?: number; token?: string } = {}): Promise<FakeProxy> {
  const token = opts.token ?? FAKE_TOKEN;
  const dir = mkdtempSync(join(tmpdir(), 'cams-fakeproxy-'));
  const app = express();
  const streams = new Set<Response>();
  const streamTypes = new Map<Response, string[] | undefined>(); // like the real one: live pushes honour ?types
  const sockets = new Set<import('net').Socket>();
  let nextId = 1;

  const fake: FakeProxy = {
    url: '',
    token,
    clips: [],
    stills: new Map(),
    previews: new Map(),
    messages: [],
    oldestId: 1,
    offline: false,
    requests: [],
    publicUrl: null,
    loginLinks: 0,
    compositions: new Map(),
    composeRequests: [],
    composeDelayMs: 300,
    stillDelayMs: 0,
    maxStillsInFlight: 0,
    maxStillListsInFlight: 0,
    streamStatus: null,
    analyses: new Map(),
    analysesStatus: null,
    analysesDelayMs: 0,
    analysesStall: false,
    knownTypes: null,
    recordings: new Map(),
    recordingsOverride: null,
    recordingDropAfter: null,
    recordingStallAfter: null,
    recordingDelayMs: 0,
    recordingFetches: [],
    streamConnections: () => streams.size,
    push(m) {
      const msg: FakeMessage = { id: nextId++, ts: m.ts ?? Date.now(), cam: m.cam, type: m.type, data: m.data };
      fake.messages.push(msg);
      for (const res of streams) {
        const types = streamTypes.get(res);
        if (!types || types.includes(msg.type)) write(res, msg);
      }
      return msg;
    },
    dropStreams() {
      for (const res of streams) res.destroy();
      streams.clear();
    },
    async stop() {
      fake.dropStreams();
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };

  const write = (res: Response, m: FakeMessage) => res.write(`id: ${m.id}\nevent: ${m.type}\ndata: ${JSON.stringify({ cam: m.cam, ...m.data })}\n\n`);

  // Far above any test's use; keeps the fake like the real service.
  app.use(rateLimit({ windowMs: 60_000, limit: 100_000, standardHeaders: false, legacyHeaders: false }));
  app.use((req, res, next) => {
    if (fake.offline) return void req.socket.destroy();
    fake.requests.push({ path: req.path, auth: req.get('authorization'), query: { ...req.query } });
    if (req.path === '/health') return next();
    // The control API takes the admin token only, like the real one.
    if (req.path.startsWith('/control/')) {
      if (req.get('authorization') !== `Bearer ${FAKE_ADMIN_TOKEN}`) return void res.status(req.get('authorization') ? 403 : 401).json({ error: 'unauthorized' });
      return next();
    }
    if (req.get('authorization') !== `Bearer ${fake.token}`) return void res.status(401).json({ error: 'unauthorized' });
    next();
  });
  app.get('/health', (_req, res) => void res.json({ ok: true, version: 'fake' }));
  app.post('/control/login-links', (_req, res) => void res.status(201).json({ code: `fake-code-${++fake.loginLinks}`, expiresInS: 60 }));

  app.get('/api/stream', (req, res) => {
    if (fake.streamStatus) return void res.status(fake.streamStatus).json({ error: 'upstream' });
    const types = typeof req.query.types === 'string' ? req.query.types.split(',') : undefined;
    // Like the real one: an unknown type is refused (a cam-proxy before `analysis` existed).
    const unknown = fake.knownTypes && types?.find((t) => !fake.knownTypes!.includes(t));
    if (unknown) return void res.status(400).json({ error: 'invalid', detail: `unknown type: ${unknown}` });
    const since = req.query.since !== undefined ? Number(req.query.since) : req.get('last-event-id') ? Number(req.get('last-event-id')) : undefined;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    res.write('retry: 3000\n\n');
    if (since !== undefined) {
      if (since < fake.oldestId - 1) res.write(`event: reset\ndata: ${JSON.stringify({ oldestId: fake.oldestId })}\n\n`);
      else for (const m of fake.messages) if (m.id > since && (!types || types.includes(m.type))) write(res, m);
    }
    streams.add(res);
    streamTypes.set(res, types);
    req.on('close', () => {
      streams.delete(res);
      streamTypes.delete(res);
    });
  });

  const range = (q: Record<string, unknown>): [number, number] | undefined => {
    const from = Number(q.from), to = Number(q.to);
    return /^\d+$/.test(String(q.from)) && /^\d+$/.test(String(q.to)) && to >= from ? [from, to] : undefined;
  };
  // The camera list, as the real one reports it (only what cams reads).
  app.get('/api/cameras', (_req, res) => {
    res.json(fake.camerasBody !== undefined ? fake.camerasBody : [{ id: 'cam1', name: 'Den', online: true, lastEventTs: null, stream: null, publicUrl: fake.publicUrl }]);
  });
  // Like the real one: the oldest clip, still and preview it holds.
  app.get('/api/cameras/:cam/extent', (req, res) => {
    const cam = req.params.cam;
    const min = (xs: number[]) => (xs.length ? Math.min(...xs) : null);
    res.json({
      clips: min(fake.clips.filter((c) => c.cam === cam).map((c) => c.start)),
      stills: min([...(fake.stills.get(cam)?.keys() ?? [])]),
      previews: min([...(fake.previews.get(cam)?.keys() ?? [])]),
    });
  });
  app.get('/api/cameras/:cam/clips', (req, res) => {
    const r = range(req.query);
    if (!r) return void res.status(400).json({ error: 'invalid' });
    if (r[1] - r[0] > 31 * 86_400_000) return void res.status(400).json({ error: 'invalid', detail: 'at most 31 days' });
    const base = `/api/cameras/${req.params.cam}/clips`;
    res.json(
      fake.clips
        .filter((c) => c.cam === req.params.cam && c.start <= r[1] && c.end >= r[0])
        .sort((a, b) => a.start - b.start)
        .map((c) => ({ id: c.id, start: c.start, end: c.end, stream: c.stream, size: c.body.length, events: c.events, url: `${base}/${c.id}.mp4`, snapshotUrl: c.snapshot ? `${base}/${c.id}.jpg` : null })),
    );
  });
  app.get('/api/cameras/:cam/clips/:file', (req, res) => {
    const m = /^(\d+)\.(mp4|jpg)$/.exec(req.params.file);
    const clip = m && fake.clips.find((c) => c.id === Number(m[1]) && c.cam === req.params.cam);
    const body = clip && (m![2] === 'mp4' ? clip.body : clip.snapshot);
    if (!body) return void res.status(404).json({ error: 'not_found' });
    const file = join(dir, `${clip!.id}.${m![2]}`);
    writeFileSync(file, body);
    res.setHeader('Cache-Control', 'private, max-age=604800, immutable');
    res.sendFile(file, { headers: { 'Content-Type': m![2] === 'mp4' ? 'video/mp4' : 'image/jpeg' } });
  });
  // Composed clips (cam-proxy spec 2026-09-28), like the real API.
  app.post('/api/cameras/:cam/compositions', express.json(), (req, res) => {
    fake.composeRequests.push(req.body);
    const id = randomBytes(16).toString('base64url');
    const job = { state: 'running' as 'queued' | 'running' | 'done', progress: 0, durationS: 30 };
    fake.compositions.set(id, job);
    const steps = 4;
    for (let k = 1; k <= steps; k++) {
      setTimeout(() => {
        if (!fake.compositions.has(id)) return;
        job.progress = k / steps;
        if (k === steps) job.state = 'done';
      }, (fake.composeDelayMs * k) / steps);
    }
    res.status(201).json({ id, ...job });
  });
  app.get('/api/cameras/:cam/compositions/:file', (req, res) => {
    const m = /^([A-Za-z0-9_-]{22})(\.mp4)?$/.exec(req.params.file);
    const job = m && fake.compositions.get(m[1]);
    if (!m || !job) return void res.status(404).json({ error: 'not_found' });
    if (!m[2]) return void res.json({ id: m[1], ...job });
    if (job.state !== 'done') return void res.status(409).json({ error: 'not_ready' });
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from('ftypisom'), Buffer.alloc(4)]);
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.get('range') ?? '');
    res.type('video/mp4').setHeader('Accept-Ranges', 'bytes');
    if (!range) return void res.send(mp4);
    const from = Number(range[1]), to = range[2] ? Math.min(Number(range[2]), mp4.length - 1) : mp4.length - 1;
    res.status(206).setHeader('Content-Range', `bytes ${from}-${to}/${mp4.length}`);
    res.send(mp4.subarray(from, to + 1));
  });
  app.delete('/api/cameras/:cam/compositions/:id', (req, res) => {
    if (!fake.compositions.delete(req.params.id)) return void res.status(404).json({ error: 'not_found' });
    res.status(204).end();
  });
  // The day's analyses and one analysis in full, like cam-proxy's API.
  app.get('/api/cameras/:cam/analyses', async (req, res) => {
    if (fake.analysesDelayMs) await new Promise((r) => setTimeout(r, fake.analysesDelayMs));
    if (fake.analysesStall) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return void res.write('[');
    }
    if (fake.analysesStatus) return void res.status(fake.analysesStatus).json({ error: 'not_found' });
    const r = range(req.query);
    if (!r) return void res.status(400).json({ error: 'invalid' });
    if (r[1] - r[0] > 86_400_000) return void res.status(400).json({ error: 'invalid', detail: 'at most one day per request' });
    res.json(
      (fake.analyses.get(req.params.cam) ?? [])
        .filter((a) => a.start >= r[0] && a.start <= r[1])
        .sort((a, b) => a.start - b.start)
        .map(({ objects: _objects, ...a }) => a),
    );
  });
  app.get('/api/cameras/:cam/events/:id/analysis', (req, res) => {
    const a = (fake.analyses.get(req.params.cam) ?? []).find((x) => x.eventId === Number(req.params.id));
    if (!a) return void res.status(404).json({ error: 'not_found' });
    res.json({ eventId: a.eventId, provider: a.provider, status: a.status, reason: a.reason, stillTs: a.stillTs, requestedAt: a.start, tookMs: 300, objects: a.objects, summary: a.summary, raw: { secret: 'raw' } });
  });

  let inFlight = 0;
  let listsInFlight = 0;
  const images = (kind: 'stills' | 'previews') => {
    app.get(`/api/cameras/:cam/${kind}`, (req, res) => {
      const r = range(req.query);
      if (!r) return void res.status(400).json({ error: 'invalid' });
      if (r[1] - r[0] > 86_400_000) return void res.status(400).json({ error: 'invalid', detail: 'at most one day per request' });
      const keys = [...(fake[kind].get(req.params.cam)?.keys() ?? [])].filter((k) => k >= r[0] && k <= r[1]).sort((a, b) => a - b);
      if (kind === 'stills' && fake.stillDelayMs) {
        listsInFlight++;
        fake.maxStillListsInFlight = Math.max(fake.maxStillListsInFlight, listsInFlight);
        return void setTimeout(() => {
          listsInFlight--;
          res.json(keys);
        }, fake.stillDelayMs);
      }
      if (kind === 'stills') return void res.json(keys);
      res.json(keys.map((minute) => ({ minute, cols: 10, rows: 6, tileW: 160, tileH: 90, intervalS: 1, present: Array(60).fill(true), url: `/api/cameras/${req.params.cam}/previews/${minute}.jpg` })));
    });
    app.get(`/api/cameras/:cam/${kind}/:file`, (req, res) => {
      const m = /^(\d{1,15})\.jpg$/.exec(req.params.file);
      if (!m) return void res.status(400).json({ error: 'invalid' });
      const jpeg = fake[kind].get(req.params.cam)?.get(Number(m[1]));
      if (!jpeg) return void res.status(404).json({ error: 'not_found' });
      res.type('image/jpeg').setHeader('Cache-Control', 'private, max-age=604800, immutable');
      if (kind !== 'stills' || !fake.stillDelayMs) return void res.send(jpeg);
      inFlight++;
      fake.maxStillsInFlight = Math.max(fake.maxStillsInFlight, inFlight);
      setTimeout(() => {
        inFlight--;
        res.send(jpeg);
      }, fake.stillDelayMs);
    });
  };
  images('stills');
  images('previews');

  // SD recordings (cam-proxy spec 2026-10-02-baichuan-recordings-design,
  // section 2). Input is checked first, as the real one does; then the
  // override; then a camera without recordings answers like an offline one.
  const REC_ID = /^Rec[MS][0-9A-Za-z]{2}_(DST)?\d{8}_\d{6}_\d{6}_[0-9A-Za-z_]+\.mp4$/;
  // Known = listed by /api/cameras, as the real proxy knows its configured cameras.
  const knownCam = (cam: string): boolean => {
    const body = fake.camerasBody !== undefined ? fake.camerasBody : [{ id: 'cam1' }];
    return Array.isArray(body) && body.some((c) => (c as { id?: unknown } | null)?.id === cam);
  };
  const recordingsOf = (cam: string, res: Response): FakeRecording[] | undefined => {
    if (fake.recordingsOverride) return void res.status(fake.recordingsOverride.status).json(fake.recordingsOverride.body);
    const list = fake.recordings.get(cam);
    if (!list && !knownCam(cam)) return void res.status(404).json({ error: 'not_found' });
    if (!list) return void res.status(503).json({ error: 'camera_offline' });
    return list;
  };
  app.get('/api/cameras/:cam/recordings/days', (req, res) => {
    const month = String(req.query.month ?? '');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return void res.status(400).json({ error: 'invalid', detail: 'month must be YYYY-MM' });
    const list = recordingsOf(req.params.cam, res);
    if (!list) return;
    const ymd = month.replace('-', '');
    const days = new Set<number>();
    for (const r of list) {
      const d = /_(?:DST)?(\d{8})_/.exec(r.id)?.[1];
      if (d?.startsWith(ymd)) days.add(Number(d.slice(6, 8)));
    }
    res.json({ month, days: [...days].sort((a, b) => a - b) });
  });
  app.get('/api/cameras/:cam/recordings', (req, res) => {
    const r = range(req.query);
    const stream = req.query.stream;
    if (!r || (stream !== 'sub' && stream !== 'main')) return void res.status(400).json({ error: 'invalid', detail: 'from, to and stream' });
    if (r[1] - r[0] > 48 * 3_600_000) return void res.status(400).json({ error: 'invalid', detail: 'at most 48 hours' });
    const list = recordingsOf(req.params.cam, res);
    if (!list) return;
    res.json(
      list
        .filter((x) => x.stream === stream && x.start <= r[1] && x.end >= r[0])
        .sort((a, b) => a.start - b.start)
        .map((x) => ({ id: x.id, start: x.start, end: x.end, stream: x.stream, size: x.body.length, kinds: x.kinds ?? [], clipId: x.clipId ?? null })),
    );
  });
  // Not modelled: the real proxy's Range/ETag behaviour (bytes=0- on an uncached
  // file answers 200, a stable ETag, 416 without a download); cams sends no Range.
  // GET and HEAD (Express answers HEAD with the GET route; sendFile honours it).
  app.get('/api/cameras/:cam/recordings/:id', async (req, res) => {
    const id = req.params.id;
    if (id.length > 128 || !REC_ID.test(id)) return void res.status(400).json({ error: 'invalid', detail: 'malformed id' });
    const list = recordingsOf(req.params.cam, res);
    if (!list) return;
    const rec = list.find((x) => x.id === id);
    if (!rec) return void res.status(404).json({ error: 'unknown_recording' });
    if (req.method === 'GET') fake.recordingFetches.push(id);
    if (fake.recordingDelayMs > 0) await new Promise((r) => setTimeout(r, fake.recordingDelayMs));
    if (req.method === 'GET' && fake.recordingDropAfter !== null) {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(rec.body.length) });
      res.write(rec.body.subarray(0, fake.recordingDropAfter));
      return void setTimeout(() => res.socket?.destroy(), 20);
    }
    if (req.method === 'GET' && fake.recordingStallAfter !== null) {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(rec.body.length) });
      return void res.write(rec.body.subarray(0, fake.recordingStallAfter));
    }
    const file = join(dir, `rec-${randomBytes(8).toString('hex')}.mp4`);
    writeFileSync(file, rec.body);
    res.setHeader('Cache-Control', 'private, max-age=604800, immutable');
    res.sendFile(file, { headers: { 'Content-Type': 'video/mp4' } });
  });

  const server = http.createServer(app);
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(opts.port ?? 0, '127.0.0.1', () => r()));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}

// e2e: `npx tsx test/proxy/fakeProxy.ts` (playwright.config.ts), seeded by
// e2e/fakeProxyData.ts.
if (require.main === module) {
  void (async () => {
    const { FAKE_PROXY_PORT, FAKE_PROXY_TOKEN, seed } = await import('../../e2e/fakeProxyData');
    const fake = await startFakeProxy({ port: FAKE_PROXY_PORT, token: FAKE_PROXY_TOKEN });
    const media = seed(fake);
    // e2e only: POST /push {cam, type, data} makes the fake send a stream
    // message (live events, Klaus 2026-09-28). A separate local port, so the
    // fake's own API keeps its token check.
    const hooks = express();
    hooks.use(express.json());
    hooks.post('/push', (req, res) => {
      const b = req.body as { cam?: unknown; type?: unknown; data?: unknown };
      if (typeof b.cam !== 'string' || typeof b.type !== 'string' || typeof b.data !== 'object' || !b.data) return void res.status(400).json({ error: 'cam, type and data' });
      res.json(fake.push({ cam: b.cam, type: b.type, data: b.data as Record<string, unknown> }));
    });
    // e2e only: POST /analyses {cam, analysis} stores an analysis (for
    // /analyses and the full record) and gives its still's minute one still
    // per second and a sprite, so the Timeline can show it.
    hooks.post('/analyses', (req, res) => {
      const b = req.body as { cam?: unknown; analysis?: FakeAnalysis };
      const a = b.analysis;
      if (typeof b.cam !== 'string' || !a || !Number.isSafeInteger(a.eventId) || !Number.isSafeInteger(a.start) || (a.stillTs !== null && !Number.isSafeInteger(a.stillTs))) return void res.status(400).json({ error: 'cam and analysis (stillTs a number or null)' });
      fake.analyses.set(b.cam, [...(fake.analyses.get(b.cam) ?? []).filter((x) => x.eventId !== a.eventId), a]);
      if (a.stillTs !== null) {
        const minute = Math.floor(a.stillTs / 60_000) * 60_000;
        const stills = fake.stills.get(b.cam) ?? new Map<number, Buffer>();
        for (let s = 0; s < 60; s++) stills.set(minute + s * 1000, media.jpeg);
        fake.stills.set(b.cam, stills);
        const previews = fake.previews.get(b.cam) ?? new Map<number, Buffer>();
        previews.set(minute, media.sprite);
        fake.previews.set(b.cam, previews);
      }
      res.json({ ok: true });
    });
    hooks.listen(FAKE_PROXY_PORT - 2, '127.0.0.1');
    process.stdout.write(`fake cam-proxy on ${fake.url} (test hooks on ${FAKE_PROXY_PORT - 2})\n`);
  })();
}
