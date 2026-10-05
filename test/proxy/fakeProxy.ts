// A small stand-in for cam-proxy (github.com/klaushofrichter/cam-proxy),
// following its openapi.yaml for the routes cams uses: the event stream,
// clips, stills, previews, SD recordings, still checks, the camera name and
// the Archive (./fakeArchive.ts). Tests set its data and switches
// directly; e2e runs it as a process (bottom of the file).
import express, { type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { mkdtempSync, writeFileSync } from 'fs';
import http from 'http';
import { createHash, randomBytes } from 'crypto';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { cameraNameProblem } from '../../server/cameraName';
import { generateMaxS } from '../../server/clipLimits';
import { installFakeArchive, type FakeArchive } from './fakeArchive';

// cam-proxy's own wording of a length (src/compose/plan.ts there), not cams's.
const proxySeconds = (s: number) => (s < 60 ? `${s} s` : `${s} s (${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')})`);

export interface FakeClip { id: number; cam: string; start: number; end: number; stream: string; events: number[]; body: Buffer; snapshot?: Buffer }
export interface FakeMessage { id: number; ts: number; cam: string; type: string; data: Record<string, unknown> }
export interface FakeBox { x0: number; y0: number; x1: number; y1: number }
// An analysis as cam-proxy stores it (spec 2026-09-30-analytics-in-cams-design):
// the stream message's shape, plus the full object list.
// An event as cam-proxy's GET /events lists it (one per AI type and motion).
export interface FakeEvent { id: number; kind: string; source: string; start: number; end: number | null; endReason: string | null; analysis: unknown }
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

// A still check (cams #179, cam-proxy's still checks API): Vision on a second
// picked by hand. `image` is the analysed JPEG, copied when it was made.
export interface FakeCheck {
  id: number;
  stillTs: number;
  provider: string;
  summary: { category: string; subtype: string; score: number; box: FakeBox }[];
  objects: { mid?: string; name: string; score: number; box: FakeBox }[];
  requestedAt: number;
  tookMs: number;
  image: Buffer | null;
}
// What GET /analytics answers (the budget; `noKey`/`checksOff` say why it is off).
export interface FakeAnalytics {
  enabled: boolean;
  noKey: boolean;
  paused: { reason: 'bad_key' | 'quota'; until: number | null } | null;
  month: { calls: number; limit: number };
  today: { calls: number; cap: number };
  checks: { today: number; cap: number };
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
  previewPresent: Map<number, boolean[]>; // tests: minute → its tiles' presence (default all 60)
  previewCurrent: number | null; // tests: the minute being collected; like cam-proxy, its sprite answers no-store
  messages: FakeMessage[];
  oldestId: number; // resuming from an id before this answers `reset`
  offline: boolean; // every request is answered by closing the connection
  requests: { path: string; auth: string | undefined; query: Record<string, unknown> }[];
  publicUrl: string | null; // what /api/cameras reports as the proxy's web address
  camerasBody?: unknown; // tests: answer /api/cameras with this instead
  loginLinks: number; // one-time admin UI links minted (POST /control/login-links)
  cameraNames: Map<string, string>; // proxy camera id → the camera's name (in /api/cameras; PUT /control/camera/name)
  cameraAddresses: Map<string, string>; // proxy camera id → its camera.host (`address` in /api/cameras; cam-proxy pi-config spec §2)
  nameOverride: { status: number; body: unknown } | null; // tests: PUT /control/camera/name answers this (after checking the name)
  nameRequests: { cam: string; name: unknown }[]; // PUT /control/camera/name bodies (its control API is cam1's, like a one-camera proxy)
  // A composition, with what it was made of (the Archive stores its clip's file).
  compositions: Map<string, FakeComposition>;
  archive: FakeArchive; // the Archive (cam-proxy's archive contract)
  composeRequests: unknown[];
  composeDelayMs: number; // a composition goes running → done over this long
  stillDelayMs: number; // tests: each still image answers this late
  maxStillsInFlight: number; // the most still images served at once (with stillDelayMs)
  maxStillListsInFlight: number; // the most still lists (GET /stills) answered at once (with stillDelayMs)
  streamStatus: number | null; // tests: /api/stream answers this error status
  events: Map<string, FakeEvent[]>; // proxy camera id → its events
  eventsStatus: number | null; // tests: /events answers this error
  analyses: Map<string, FakeAnalysis[]>; // proxy camera id → its analyses
  analysesStatus: number | null; // tests: /analyses answers this error (404: an older proxy)
  analysesDelayMs: number; // tests: /analyses answers this late
  analysesStall: boolean; // tests: /analyses sends its headers and the body's start, then nothing
  knownTypes: string[] | null; // tests: the stream refuses other types (an older proxy)
  recordings: Map<string, FakeRecording[]>; // proxy camera id → its SD recordings; a camera without an entry answers 503 camera_offline
  recordingsOverride: { status: number; body: unknown } | null; // tests: every recordings route answers this (after checking its input)
  recordingsBusy: number; // tests: the next this many recordings list requests answer 503 recordings_unavailable busy (Retry-After: 1)
  recordingDropAfter: number | null; // tests: a file sends its headers and this many bytes, then the connection drops
  recordingStallAfter: number | null; // tests: a file sends its headers and this many bytes, then nothing (the connection stays open)
  recordingDelayMs: number; // tests: a file's headers wait this long (the real proxy queues downloads per camera)
  recordingFetches: string[]; // ids of the files served by GET (not HEAD)
  checks: Map<string, FakeCheck[]>; // proxy camera id → its still checks
  analytics: FakeAnalytics; // every camera's budget (a real proxy has one camera)
  analyticsStatus: number | null; // tests: GET /analytics and the still-check routes answer this (404: an older proxy)
  checkAnswers: Map<string, { summary: FakeCheck['summary']; objects: FakeCheck['objects'] }>; // `${cam}|${at}` → Vision's answer (default: nothing relevant, a ceiling fan)
  checkFailure: { status: number; body: unknown } | null; // tests: the next new check's call fails like this (counted, nothing stored)
  checkDelayMs: number; // tests: a new check's Vision call takes this long
  checkCalls: number; // Vision calls made for checks
  camFilter: boolean; // tests: false = ignore ?cam= and send every camera's messages
  features: string[] | null; // `features` on every /api/cameras item; null: a cam-proxy from before multi-camera P1 (no field, ?cam= is one whole id)
  streamConnections(): number;
  push(m: Omit<FakeMessage, 'id' | 'ts'> & { ts?: number }): FakeMessage;
  dropStreams(): void; // ends every open stream (a proxy restart)
  stop(): Promise<void>;
}

export interface FakeComposition { state: 'queued' | 'running' | 'done'; progress: number; durationS: number; clipId?: number; at?: number; preS?: number; postS?: number; size?: string; window?: { from: number; to: number } }

export const FAKE_TOKEN = 'fake-proxy-client-token-'.padEnd(48, 'z');
export const FAKE_ADMIN_TOKEN = 'fake-proxy-admin-token-'.padEnd(48, 'a');

export const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]);

export async function startFakeProxy(opts: { port?: number; token?: string } = {}): Promise<FakeProxy> {
  const token = opts.token ?? FAKE_TOKEN;
  const dir = mkdtempSync(join(tmpdir(), 'cams-fakeproxy-'));
  const app = express();
  const streams = new Set<Response>();
  // Like the real one: live pushes honour ?types and ?cam (a list, spec 2026-10-05 §6.2).
  const streamFilters = new Map<Response, { types?: string[]; cams?: Set<string> }>();
  const wanted = (f: { types?: string[]; cams?: Set<string> } | undefined, m: FakeMessage) => (!f?.types || f.types.includes(m.type)) && (!fake.camFilter || !f?.cams || f.cams.has(m.cam));
  const sockets = new Set<import('net').Socket>();
  let nextId = 1;

  const fake: FakeProxy = {
    url: '',
    token,
    clips: [],
    stills: new Map(),
    previews: new Map(),
    previewPresent: new Map(),
    previewCurrent: null,
    messages: [],
    oldestId: 1,
    offline: false,
    requests: [],
    publicUrl: null,
    loginLinks: 0,
    cameraNames: new Map([['cam1', 'Den']]),
    cameraAddresses: new Map([['cam1', '192.0.2.10']]),
    nameOverride: null,
    nameRequests: [],
    compositions: new Map(),
    archive: undefined as unknown as FakeArchive, // installed below
    composeRequests: [],
    composeDelayMs: 300,
    stillDelayMs: 0,
    maxStillsInFlight: 0,
    maxStillListsInFlight: 0,
    streamStatus: null,
    events: new Map(),
    eventsStatus: null,
    analyses: new Map(),
    analysesStatus: null,
    analysesDelayMs: 0,
    analysesStall: false,
    knownTypes: null,
    recordings: new Map(),
    recordingsOverride: null,
    recordingsBusy: 0,
    recordingDropAfter: null,
    recordingStallAfter: null,
    recordingDelayMs: 0,
    recordingFetches: [],
    checks: new Map(),
    analytics: { enabled: true, noKey: false, paused: null, month: { calls: 14, limit: 1000 }, today: { calls: 2, cap: 30 }, checks: { today: 0, cap: 10 } },
    analyticsStatus: null,
    checkAnswers: new Map(),
    checkFailure: null,
    checkDelayMs: 0,
    checkCalls: 0,
    camFilter: true,
    features: ['sse-cam-list'],
    streamConnections: () => streams.size,
    push(m) {
      const msg: FakeMessage = { id: nextId++, ts: m.ts ?? Date.now(), cam: m.cam, type: m.type, data: m.data };
      fake.messages.push(msg);
      for (const res of streams) if (wanted(streamFilters.get(res), msg)) write(res, msg);
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
  // The camera's name (cam-proxy, design camera-name-design.md "API
  // contract"): checked with the camera's rules, written, read back; a change
  // is one `camera` stream message {cam, name}.
  app.put('/control/camera/name', express.json(), (req, res) => {
    const cam = 'cam1'; // a real cam-proxy serves one camera
    const name = (req.body as { name?: unknown } | undefined)?.name;
    fake.nameRequests.push({ cam, name });
    const problem = cameraNameProblem(name);
    if (problem) return void res.status(400).json({ error: 'invalid_name', reason: problem });
    if (fake.nameOverride) return void res.status(fake.nameOverride.status).json(fake.nameOverride.body);
    if (fake.cameraNames.get(cam) !== name) {
      fake.cameraNames.set(cam, name as string);
      fake.push({ cam, type: 'camera', data: { name } });
    }
    res.json({ name: fake.cameraNames.get(cam) });
  });

  app.get('/api/stream', (req, res) => {
    if (fake.streamStatus) return void res.status(fake.streamStatus).json({ error: 'upstream' });
    const types = typeof req.query.types === 'string' ? req.query.types.split(',') : undefined;
    // Like the real one: an unknown type is refused (a cam-proxy before `analysis` existed).
    const unknown = fake.knownTypes && types?.find((t) => !fake.knownTypes!.includes(t));
    if (unknown) return void res.status(400).json({ error: 'invalid', detail: `unknown type: ${unknown}` });
    // An old proxy (features null) compares ?cam= as one whole id.
    const camList = typeof req.query.cam === 'string' && req.query.cam ? new Set(fake.features ? req.query.cam.split(',') : [req.query.cam]) : undefined;
    const filter = { types, cams: camList };
    const since = req.query.since !== undefined ? Number(req.query.since) : req.get('last-event-id') ? Number(req.get('last-event-id')) : undefined;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    res.write('retry: 3000\n\n');
    if (since !== undefined) {
      if (since < fake.oldestId - 1) res.write(`event: reset\ndata: ${JSON.stringify({ oldestId: fake.oldestId })}\n\n`);
      else for (const m of fake.messages) if (m.id > since && wanted(filter, m)) write(res, m);
    }
    streams.add(res);
    streamFilters.set(res, filter);
    req.on('close', () => {
      streams.delete(res);
      streamFilters.delete(res);
    });
  });

  const range = (q: Record<string, unknown>): [number, number] | undefined => {
    const from = Number(q.from), to = Number(q.to);
    return /^\d{1,15}$/.test(String(q.from)) && /^\d{1,15}$/.test(String(q.to)) && to >= from ? [from, to] : undefined;
  };
  // The camera list, as the real one reports it (only what cams reads).
  app.get('/api/cameras', (_req, res) => {
    res.json(fake.camerasBody !== undefined ? fake.camerasBody : [...fake.cameraNames].map(([id, name]) => ({ id, name, online: true, lastEventTs: null, stream: null, publicUrl: fake.publicUrl, address: fake.cameraAddresses.get(id) ?? null, ...(fake.features && { features: fake.features }) })));
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
  // Composed clips (cam-proxy spec 2026-09-28), like the real API: the clip
  // must be known, and the rolls apply to `span` (the recording the viewer
  // chose) or else to the clip, with cam-proxy's limits (300 s, 120 s at
  // 1080p; its compositionWindow) and its refusals.
  app.post('/api/cameras/:cam/compositions', express.json(), (req, res) => {
    fake.composeRequests.push(req.body);
    const b = req.body as { clipId?: unknown; at?: unknown; span?: { start?: unknown; end?: unknown }; preS?: unknown; postS?: unknown; size?: unknown; badge?: unknown; dryRun?: unknown };
    if (typeof b.preS !== 'number' || typeof b.postS !== 'number' || typeof b.badge !== 'boolean' || !['sd', '360p', '720p', '1080p'].includes(String(b.size))) {
      return void res.status(400).json({ error: 'invalid', detail: 'clipId or at, preS, postS (seconds), size (sd, 360p, 720p, 1080p) and badge (true/false) are required' });
    }
    if ((b.clipId === undefined) === (b.at === undefined)) return void res.status(400).json({ error: 'invalid', detail: 'exactly one of clipId (a clip) or at (a second, unix ms)' });
    if (b.at !== undefined) return void composeAround(req.params.cam, b, res);
    if (!Number.isSafeInteger(b.clipId)) return void res.status(400).json({ error: 'invalid', detail: 'clipId is a whole number' });
    // cam-proxy's spanOf: {start, end} in unix ms, start before end, at most a day apart.
    let given: { start: number; end: number } | undefined;
    if (b.span !== undefined) {
      const o = (b.span ?? {}) as { start?: unknown; end?: unknown };
      const ok = typeof b.span === 'object' && Number.isSafeInteger(o.start) && Number.isSafeInteger(o.end) && (o.end as number) > (o.start as number) && (o.end as number) - (o.start as number) <= 86_400_000;
      if (!ok) return void res.status(400).json({ error: 'invalid', detail: 'span is {start, end} in unix ms, start before end, at most a day apart' });
      given = { start: o.start as number, end: o.end as number };
    }
    const clip = fake.clips.find((c) => c.id === b.clipId && c.cam === req.params.cam);
    if (!clip) return void res.status(404).json({ error: 'not_found' });
    if (given && Math.min(given.end, clip.end) - Math.max(given.start, clip.start) < 1000) return void res.status(400).json({ error: 'invalid', detail: 'span must overlap the clip by at least 1 s' });
    const span = given ?? clip;
    const pre = b.preS, post = b.postS;
    if (![pre, post].every((v) => Number.isInteger(v) && Math.abs(v) <= 3600)) return void res.status(400).json({ error: 'invalid', detail: 'pre-roll and post-roll are whole seconds from -3600 to 3600' });
    const start = span.start - pre * 1000, rawEnd = span.end + post * 1000;
    if (Math.min(rawEnd, span.end) - Math.max(start, span.start) < 1000) return void res.status(400).json({ error: 'invalid', detail: 'at least 1 s of the clip must remain' });
    const durationS = Math.round((rawEnd - start) / 1000);
    const maxS = generateMaxS(String(b.size));
    if (durationS > maxS) return void res.status(400).json({ error: 'invalid', detail: `at most ${proxySeconds(maxS)}` });
    startJob(durationS, res, { clipId: clip.id, preS: pre, postS: post, size: String(b.size), window: { from: start, to: rawEnd } });
  });
  const startJob = (durationS: number, res: express.Response, made: Omit<FakeComposition, 'state' | 'progress' | 'durationS'> = {}) => {
    const id = randomBytes(16).toString('base64url');
    const job: FakeComposition = { state: 'running', progress: 0, durationS, ...made };
    fake.compositions.set(id, job);
    const steps = 4;
    for (let k = 1; k <= steps; k++) {
      setTimeout(() => {
        if (!fake.compositions.has(id)) return;
        job.progress = k / steps;
        if (k === steps) job.state = 'done';
      }, (fake.composeDelayMs * k) / steps);
    }
    res.status(201).json({ id, state: job.state, progress: job.progress, durationS });
  };
  // Around a second (cam-proxy still-checks spec §13): the window
  // [at - pre, at + 1 s + post], each second a clip that covers it, else its
  // still, else a card; nothing but cards is a 409; a dry run answers the
  // plan. cam-proxy's own words.
  const composeAround = (cam: string, b: { at?: unknown; span?: unknown; preS?: unknown; postS?: unknown; size?: unknown; dryRun?: unknown }, res: express.Response) => {
    const bad = (detail: string) => void res.status(400).json({ error: 'invalid', detail });
    const at = b.at, now = Date.now();
    if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0) return bad('at is a whole number (unix ms)');
    if (at % 1000 !== 0) return bad('at is a whole second');
    if (at > now) return bad('at is in the future');
    if (at < Math.floor((now - 7 * 86_400_000) / 86_400_000) * 86_400_000) return bad('at is older than the stills and clips kept (7 days)');
    if (b.span !== undefined) return bad('span goes with clipId, not with at');
    if (b.dryRun !== undefined && typeof b.dryRun !== 'boolean') return bad('dryRun is true or false');
    const pre = b.preS as number, post = b.postS as number;
    if (![pre, post].every((v) => Number.isInteger(v) && v >= 0 && v <= 3600)) return bad('around a second, pre-roll and post-roll are whole seconds from 0 to 3600');
    const durationS = pre + 1 + post, maxS = generateMaxS(String(b.size));
    if (durationS > maxS) return bad(`at most ${proxySeconds(maxS)}`);
    const start = at - pre * 1000, end = at + (post + 1) * 1000;
    if (end > now) return bad(`the window ends in the future (${Math.ceil((end - now) / 1000)} s from now)`);
    const clips = fake.clips.filter((c) => c.cam === cam).sort((x, y) => x.start - y.start || x.id - y.id);
    const stills = fake.stills.get(cam);
    const seconds = { clip: 0, still: 0, card: 0 };
    const used = new Map<number, FakeClip>();
    for (let t = start; t < end; t += 1000) {
      const c = clips.find((x) => t >= x.start && t + 1000 <= x.end + 500);
      if (c) {
        seconds.clip++;
        used.set(c.id, c);
      } else if (stills?.has(t)) seconds.still++;
      else seconds.card++;
    }
    if (!seconds.clip && !seconds.still) return void res.status(409).json({ error: 'nothing_to_compose', detail: 'no clip or still covers any second of this window' });
    if (b.dryRun) return void res.json({ start, end, durationS, seconds, clips: [...used.values()].map((c) => ({ start: c.start, end: c.end })) });
    startJob(durationS, res, { at, clipId: [...used.keys()][0], preS: pre, postS: post, size: String(b.size), window: { from: start, to: end } });
  };
  app.get('/api/cameras/:cam/compositions/:file', (req, res) => {
    const m = /^([A-Za-z0-9_-]{22})(\.mp4)?$/.exec(req.params.file);
    const job = m && fake.compositions.get(m[1]);
    if (!m || !job) return void res.status(404).json({ error: 'not_found' });
    if (!m[2]) return void res.json({ id: m[1], state: job.state, progress: job.progress, durationS: job.durationS });
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
  // Events, newest first, like cam-proxy's (from/to on the start, kind, limit).
  app.get('/api/cameras/:cam/events', (req, res) => {
    if (fake.eventsStatus) return void res.status(fake.eventsStatus).json({ error: 'upstream' });
    const q = req.query;
    const num = (v: unknown) => (v === undefined ? undefined : /^\d{1,15}$/.test(String(v)) ? Number(v) : NaN);
    const from = num(q.from), to = num(q.to), limit = num(q.limit);
    if ([from, to, limit].some((v) => Number.isNaN(v))) return void res.status(400).json({ error: 'invalid' });
    res.json(
      (fake.events.get(req.params.cam) ?? [])
        .filter((e) => (from === undefined || e.start >= from) && (to === undefined || e.start <= to) && (q.kind === undefined || e.kind === q.kind))
        .sort((a, b) => b.start - a.start || b.id - a.id)
        .slice(0, Math.min(Math.max(1, limit ?? 1000), 1000)) // clamped, like the real one
        .map((e) => {
          // Like the real one, each event with its latest analysis (one stored by a test hook too).
          const a = e.analysis ? null : [...(fake.analyses.get(req.params.cam) ?? [])].reverse().find((x) => x.eventId === e.id);
          return a ? { ...e, analysis: { provider: a.provider, status: a.status, reason: a.reason, stillTs: a.stillTs, objects: a.objects, summary: a.summary } } : e;
        }),
    );
  });
  app.get('/api/cameras/:cam/events/:id/analysis', (req, res) => {
    const a = (fake.analyses.get(req.params.cam) ?? []).find((x) => x.eventId === Number(req.params.id));
    if (!a) return void res.status(404).json({ error: 'not_found' });
    res.json({ eventId: a.eventId, provider: a.provider, status: a.status, reason: a.reason, stillTs: a.stillTs, requestedAt: a.start, tookMs: 300, objects: a.objects, summary: a.summary, raw: { secret: 'raw' } });
  });

  // Still checks (cams #179), cam-proxy's contract: POST checks a second
  // (reused when stored or analysed with its event), GET lists a range, one
  // in full, its image; GET /analytics is the budget. The linked events are
  // computed on every read, like the real one.
  const checkLinks = (cam: string, ts: number, summary: { category: string }[]) =>
    (fake.events.get(cam) ?? [])
      .filter((e) => e.start <= ts && ts <= (e.end ?? e.start + 30 * 60_000))
      .sort((a, b) => a.start - b.start || a.id - b.id)
      .map((e) => ({ id: e.id, kind: e.kind, confirmed: ['person', 'vehicle', 'pet'].includes(e.kind) && summary.some((x) => x.category === e.kind) }));
  const checkOut = (cam: string, c: FakeCheck, full: boolean) => ({
    id: c.id,
    stillTs: c.stillTs,
    provider: c.provider,
    summary: c.summary,
    ...(full ? { objects: c.objects } : {}),
    events: checkLinks(cam, c.stillTs, c.summary),
    imageUrl: c.image ? `/api/cameras/${cam}/still-checks/${c.id}.jpg` : null,
    ...(full ? { requestedAt: c.requestedAt, tookMs: c.tookMs } : {}),
  });
  let checkRunning: number | null = null;
  let nextCheckId = 1;
  app.get('/api/cameras/:cam/analytics', (req, res) => {
    if (fake.analyticsStatus) return void res.status(fake.analyticsStatus).json({ error: 'not_found' });
    const a = fake.analytics;
    res.json({ enabled: a.enabled && !a.noKey, paused: a.paused, month: a.month, today: a.today, checks: a.checks });
  });
  app.post('/api/cameras/:cam/still-checks', express.json(), async (req, res) => {
    if (fake.analyticsStatus) return void res.status(fake.analyticsStatus).json({ error: 'not_found' });
    const cam = req.params.cam;
    const at = (req.body as { at?: unknown } | undefined)?.at;
    if (at === undefined) return void res.status(400).json({ error: 'invalid', detail: 'at (unix ms) is required' });
    if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0) return void res.status(400).json({ error: 'invalid', detail: 'at is a whole number (unix ms)' });
    if (at % 1000 !== 0) return void res.status(400).json({ error: 'invalid', detail: 'at is a whole second' });
    if (at > Date.now()) return void res.status(400).json({ error: 'invalid', detail: 'at is in the future' });
    if (at < Date.now() - 8 * 86_400_000) return void res.status(400).json({ error: 'invalid', detail: 'at is older than the stills kept (7 days)' });
    const stored = (fake.checks.get(cam) ?? []).find((c) => c.stillTs === at);
    if (stored) return void res.json({ reused: true, source: 'check', check: checkOut(cam, stored, true) });
    const auto = (fake.analyses.get(cam) ?? []).find((a) => a.stillTs === at && a.status === 'ok');
    if (auto) {
      return void res.json({
        reused: true,
        source: 'event',
        check: { id: null, eventId: auto.eventId, stillTs: at, provider: auto.provider, summary: auto.summary, objects: auto.objects, events: checkLinks(cam, at, auto.summary), imageUrl: `/api/cameras/${cam}/events/${auto.eventId}/analysis.jpg`, requestedAt: auto.start, tookMs: 300 },
      });
    }
    const a = fake.analytics;
    if (!a.enabled || a.noKey || a.checks.cap === 0) return void res.status(409).json({ error: 'analytics_off', reason: !a.enabled ? 'off' : a.noKey ? 'no_key' : 'checks_off' });
    const still = fake.stills.get(cam)?.get(at);
    if (!still) return void res.status(404).json({ error: 'no_still' });
    if (checkRunning !== null) return void res.status(429).json({ error: 'busy' });
    if (a.paused) return void res.status(503).json({ error: 'analytics_paused', reason: a.paused.reason, until: a.paused.until });
    if (a.month.calls >= a.month.limit) return void res.status(429).json({ error: 'limit', reason: 'month' });
    if (a.today.cap > 0 && a.today.calls >= a.today.cap) return void res.status(429).json({ error: 'limit', reason: 'day' });
    if (a.checks.today >= a.checks.cap) return void res.status(429).json({ error: 'limit', reason: 'checks' });
    checkRunning = at;
    try {
      if (fake.checkDelayMs) await new Promise((r) => setTimeout(r, fake.checkDelayMs));
      fake.checkCalls++;
      a.month.calls++;
      a.today.calls++;
      a.checks.today++;
      const failure = fake.checkFailure;
      if (failure) {
        fake.checkFailure = null;
        return void res.status(failure.status).json(failure.body);
      }
      const answer = fake.checkAnswers.get(`${cam}|${at}`) ?? { summary: [], objects: [{ mid: '/m/0fan', name: 'Ceiling fan', score: 0.6, box: { x0: 0, y0: 0, x1: 0.2, y1: 0.2 } }] };
      const check: FakeCheck = { id: nextCheckId++, stillTs: at, provider: 'google-vision', summary: answer.summary, objects: answer.objects, requestedAt: Date.now(), tookMs: 597, image: still };
      fake.checks.set(cam, [...(fake.checks.get(cam) ?? []), check]);
      const body = checkOut(cam, check, true);
      fake.push({ cam, type: 'still-check', data: body });
      res.status(201).json({ reused: false, check: body });
    } finally {
      checkRunning = null;
    }
  });
  app.get('/api/cameras/:cam/still-checks', (req, res) => {
    if (fake.analyticsStatus) return void res.status(fake.analyticsStatus).json({ error: 'not_found' });
    const r = range(req.query);
    if (!r) return void res.status(400).json({ error: 'invalid', detail: 'from and to (unix ms) are required' });
    if (r[1] - r[0] > 31 * 86_400_000) return void res.status(400).json({ error: 'invalid', detail: 'at most 31 days per request' });
    const cam = req.params.cam;
    res.json((fake.checks.get(cam) ?? []).filter((c) => c.stillTs >= r[0] && c.stillTs <= r[1]).sort((a, b) => a.stillTs - b.stillTs).map((c) => checkOut(cam, c, false)));
  });
  app.get('/api/cameras/:cam/still-checks/:file', (req, res) => {
    if (fake.analyticsStatus) return void res.status(fake.analyticsStatus).json({ error: 'not_found' });
    const m = /^(\d{1,12})(\.jpg)?$/.exec(req.params.file);
    if (!m) return void res.status(400).json({ error: 'invalid', detail: 'a check is <id>, its image <id>.jpg' });
    const cam = req.params.cam;
    const c = (fake.checks.get(cam) ?? []).find((x) => x.id === Number(m[1]));
    if (!c) return void res.status(404).json({ error: 'not_found' });
    if (!m[2]) return void res.json({ ...checkOut(cam, c, true), raw: { secret: 'raw' } });
    if (!c.image) return void res.status(404).json({ error: 'not_found' });
    res.type('image/jpeg').setHeader('Cache-Control', 'private, max-age=604800, immutable');
    res.send(c.image);
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
      res.json(keys.map((minute) => ({ minute, cols: 10, rows: 6, tileW: 160, tileH: 90, intervalS: 1, present: fake.previewPresent.get(minute) ?? Array(60).fill(true), url: `/api/cameras/${req.params.cam}/previews/${minute}.jpg` })));
    });
    app.get(`/api/cameras/:cam/${kind}/:file`, (req, res) => {
      const m = /^(\d{1,15})\.jpg$/.exec(req.params.file);
      if (!m) return void res.status(400).json({ error: 'invalid' });
      const jpeg = fake[kind].get(req.params.cam)?.get(Number(m[1]));
      if (!jpeg) return void res.status(404).json({ error: 'not_found' });
      const current = kind === 'previews' && Number(m[1]) === fake.previewCurrent;
      res.type('image/jpeg').setHeader('Cache-Control', current ? 'no-store' : 'private, max-age=604800, immutable');
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
  // `date=YYYY-MM-DD` (cam-proxy v2026.10.02.4): one camera-local day by the
  // names' date, plus a recording from the day before that runs past midnight
  // into it (its end time of day is earlier than its start). Not with from/to.
  const recordingOnDay = (id: string, date: string): boolean => {
    const m = /_(?:DST)?(\d{8})_(\d{6})_(\d{6})_/.exec(id);
    if (!m) return false;
    const day = `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}`;
    if (day === date) return true;
    const prev = new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    return day === prev && m[3] < m[2];
  };
  const validDate = (d: unknown): d is string => {
    if (typeof d !== 'string' || !/^20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(d)) return false;
    return new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
  };
  app.get('/api/cameras/:cam/recordings', (req, res) => {
    const stream = req.query.stream;
    const dated = req.query.date !== undefined;
    const r = dated ? undefined : range(req.query);
    if (dated && (req.query.from !== undefined || req.query.to !== undefined)) return void res.status(400).json({ error: 'invalid', detail: 'date excludes from and to' });
    if (dated ? !validDate(req.query.date) || (stream !== 'sub' && stream !== 'main') : !r || (stream !== 'sub' && stream !== 'main')) return void res.status(400).json({ error: 'invalid', detail: 'date or from and to, and stream' });
    if (r && r[1] - r[0] > 48 * 3_600_000) return void res.status(400).json({ error: 'invalid', detail: 'at most 48 hours' });
    if (fake.recordingsBusy > 0 && !fake.recordingsOverride) {
      fake.recordingsBusy--;
      res.setHeader('Retry-After', '1');
      return void res.status(503).json({ error: 'recordings_unavailable', reason: 'busy' });
    }
    const list = recordingsOf(req.params.cam, res);
    if (!list) return;
    const date = String(req.query.date);
    res.json(
      list
        .filter((x) => x.stream === stream && (dated ? recordingOnDay(x.id, date) : x.start <= r![1] && x.end >= r![0]))
        .sort((a, b) => a.start - b.start)
        .map((x) => ({ id: x.id, start: x.start, end: x.end, stream: x.stream, size: x.body.length, kinds: x.kinds ?? [], clipId: x.clipId ?? null })),
    );
  });
  // Not modelled: the real proxy's bytes=0- on an uncached file (200) and 416
  // without a download; cams sends no Range. The ETag is stable per file.
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
    const headers = {
      'Content-Type': 'video/mp4',
      'Cache-Control': 'private, max-age=604800, immutable',
      ETag: `"${createHash('sha1').update(rec.body).digest('hex').slice(0, 16)}"`,
    };
    if (req.method === 'GET' && fake.recordingDropAfter !== null) {
      res.writeHead(200, { ...headers, 'Accept-Ranges': 'bytes', 'Content-Length': String(rec.body.length) });
      res.write(rec.body.subarray(0, fake.recordingDropAfter));
      return void setTimeout(() => res.socket?.destroy(), 20);
    }
    if (req.method === 'GET' && fake.recordingStallAfter !== null) {
      res.writeHead(200, { ...headers, 'Accept-Ranges': 'bytes', 'Content-Length': String(rec.body.length) });
      return void res.write(rec.body.subarray(0, fake.recordingStallAfter));
    }
    const file = join(dir, `rec-${randomBytes(8).toString('hex')}.mp4`);
    writeFileSync(file, rec.body);
    res.sendFile(file, { etag: false, headers });
  });

  fake.archive = installFakeArchive(app, fake, dir);

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
    const { FAKE_PROXY_PORT, FAKE_PROXY_TOKEN, seed } = await import('../../e2e/fakeProxyData.js');
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
    // e2e only: POST /preview-minute {minute, tiles, current} gives Den's
    // minute a sprite (if it has none) and lists its first `tiles` tiles as present, and (current) answer its
    // sprite no-store, like cam-proxy's minute being collected. tiles 60 and
    // current false put it back.
    hooks.post('/preview-minute', (req, res) => {
      const b = req.body as { minute?: unknown; tiles?: unknown; current?: unknown };
      if (!Number.isSafeInteger(b.minute) || !Number.isSafeInteger(b.tiles) || typeof b.current !== 'boolean') return void res.status(400).json({ error: 'minute, tiles and current' });
      const minute = b.minute as number, tiles = b.tiles as number;
      const sprites = fake.previews.get('cam1') ?? new Map<number, Buffer>();
      if (!sprites.has(minute)) sprites.set(minute, media.sprite); // Den's minute, as /analyses gives one
      fake.previews.set('cam1', sprites);
      if (tiles >= 60) fake.previewPresent.delete(minute);
      else fake.previewPresent.set(minute, Array.from({ length: 60 }, (_, i) => i < tiles));
      fake.previewCurrent = b.current ? minute : fake.previewCurrent === minute ? null : fake.previewCurrent;
      res.json({ ok: true });
    });
    // e2e only: POST /analyses {cam, analysis} stores an analysis (for
    // /analyses, the full record and its event in /events) and gives its
    // still's minute one still per second and a sprite, so the Timeline can
    // show it.
    hooks.post('/analyses', (req, res) => {
      const b = req.body as { cam?: unknown; analysis?: FakeAnalysis };
      const a = b.analysis;
      if (typeof b.cam !== 'string' || !a || !Number.isSafeInteger(a.eventId) || !Number.isSafeInteger(a.start) || (a.stillTs !== null && !Number.isSafeInteger(a.stillTs))) return void res.status(400).json({ error: 'cam and analysis (stillTs a number or null)' });
      fake.analyses.set(b.cam, [...(fake.analyses.get(b.cam) ?? []).filter((x) => x.eventId !== a.eventId), a]);
      if (a.stillTs !== null) {
        const minute = Math.floor(a.stillTs / 60_000) * 60_000;
        const stills = fake.stills.get(b.cam) ?? new Map<number, Buffer>();
        // Seeded stills (a card's detection still) stay as they are.
        for (let s = 0; s < 60; s++) if (!stills.has(minute + s * 1000)) stills.set(minute + s * 1000, media.jpeg);
        fake.stills.set(b.cam, stills);
        const previews = fake.previews.get(b.cam) ?? new Map<number, Buffer>();
        previews.set(minute, media.sprite);
        fake.previews.set(b.cam, previews);
      }
      res.json({ ok: true });
    });
    // e2e only: POST /stills-minute {cam, minute} gives a minute one still
    // per second and a sprite (a second to check, cams #179).
    hooks.post('/stills-minute', (req, res) => {
      const b = req.body as { cam?: unknown; minute?: unknown };
      if (typeof b.cam !== 'string' || !Number.isSafeInteger(b.minute) || (b.minute as number) % 60_000 !== 0) return void res.status(400).json({ error: 'cam and minute' });
      const minute = b.minute as number;
      const stills = fake.stills.get(b.cam) ?? new Map<number, Buffer>();
      for (let s = 0; s < 60; s++) if (!stills.has(minute + s * 1000)) stills.set(minute + s * 1000, media.jpeg);
      fake.stills.set(b.cam, stills);
      const previews = fake.previews.get(b.cam) ?? new Map<number, Buffer>();
      previews.set(minute, media.sprite);
      fake.previews.set(b.cam, previews);
      res.json({ ok: true });
    });
    // e2e only: POST /check-answer {cam, at, summary, objects}: what Vision
    // answers when that second is checked.
    hooks.post('/check-answer', (req, res) => {
      const b = req.body as { cam?: unknown; at?: unknown; summary?: unknown; objects?: unknown };
      if (typeof b.cam !== 'string' || !Number.isSafeInteger(b.at) || !Array.isArray(b.summary) || !Array.isArray(b.objects)) return void res.status(400).json({ error: 'cam, at, summary and objects' });
      fake.checkAnswers.set(`${b.cam}|${b.at as number}`, { summary: b.summary as FakeCheck['summary'], objects: b.objects as FakeCheck['objects'] });
      res.json({ ok: true });
    });
    // e2e only: POST /ftp-clip {cam, start, end} adds an FTP clip (a second
    // covered by a clip for "Save clip around this", #179 phase 3).
    hooks.post('/ftp-clip', (req, res) => {
      const b = req.body as { cam?: unknown; start?: unknown; end?: unknown };
      if (typeof b.cam !== 'string' || !Number.isSafeInteger(b.start) || !Number.isSafeInteger(b.end) || (b.end as number) <= (b.start as number)) return void res.status(400).json({ error: 'cam, start and end' });
      const id = Math.max(0, ...fake.clips.map((c) => c.id)) + 1;
      fake.clips.push({ id, cam: b.cam, start: b.start as number, end: b.end as number, stream: 'sub', events: [], body: Buffer.alloc(16) });
      res.json({ id });
    });
    // e2e only: POST /stills-clear {cam, from, to} deletes the stills in
    // [from, to) (retention took them: nothing around a second, #179 phase 3).
    hooks.post('/stills-clear', (req, res) => {
      const b = req.body as { cam?: unknown; from?: unknown; to?: unknown };
      if (typeof b.cam !== 'string' || !Number.isSafeInteger(b.from) || !Number.isSafeInteger(b.to)) return void res.status(400).json({ error: 'cam, from and to' });
      const stills = fake.stills.get(b.cam);
      for (const t of [...(stills?.keys() ?? [])]) if (t >= (b.from as number) && t < (b.to as number)) stills!.delete(t);
      res.json({ ok: true });
    });
    hooks.listen(FAKE_PROXY_PORT - 2, '127.0.0.1');
    process.stdout.write(`fake cam-proxy on ${fake.url} (test hooks on ${FAKE_PROXY_PORT - 2})\n`);
  })();
}
