// The fake cam-proxy's Archive (cam-proxy's archive contract, docs/archive.md
// there; handed to cams as archive-api.md): create from a composition, an FTP
// clip or an SD recording as an archive job (201 when done at once, else 202
// and polling), list with the contract's filters, sort and paging, one item,
// PATCH, delete one or many, the video with Range, the thumbnail, the
// metadata, a stored ZIP, the status, and the `archive` stream messages.
import express, { type Express, type Request, type Response } from 'express';
import { randomBytes } from 'crypto';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { crc32 } from 'zlib';
import { compareItems, DEFAULT_RETENTION_DAYS, nameProblem, normalizeLabels, QUALITIES, retentionProblem, SORT_KEYS, type SortKey } from '../../server/archiveRules';
import type { FakeProxy } from './fakeProxy';

const DAY = 86_400_000;
export const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]);
// A file that starts like an MP4 (ftyp), for a composition without a clip.
const PLACEHOLDER_MP4 = Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from('ftypisom'), Buffer.alloc(4)]);

export interface FakeArchiveItem {
  id: number;
  cam: string;
  cameraName: string;
  name: string;
  labels: string[];
  retentionDays: number | null;
  createdAt: number;
  expiresAt: number | null;
  recordedFrom: number;
  recordedTo: number;
  durationS: number;
  quality: string;
  original: boolean;
  bytes: number;
  source: Record<string, unknown>;
  eventKinds: string[];
  found: string[];
  thumbnail: { from: string; at: number | null };
  createdBy: 'client' | 'admin';
}
interface Entry { item: FakeArchiveItem; body: Buffer; thumb: Buffer | null; metadata: Record<string, unknown> }
export interface FakeArchiveJob {
  id: string;
  cam: string;
  state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  phase: 'fetching' | 'copying' | 'finishing' | null;
  progress: number;
  bytes: number;
  size: number;
  archiveId?: number;
  item?: Record<string, unknown>;
  error?: string;
  detail?: string;
}

export interface FakeArchive {
  entries: Map<number, Entry>;
  jobs: Map<string, FakeArchiveJob>;
  enabled: boolean; // false: 503 archive_off for new clips
  free: number; // the data volume's free bytes
  diskSize: number;
  minFreeBytes: number;
  jobMs: number; // 0: a job finishes at once (201); else it runs this long (202)
  failNext: string | null; // the next job fails with this error
  zipChunkDelayMs: number; // tests: the ZIP is sent in pieces this far apart
  defaultThumb: Buffer; // a clip's thumbnail when no still is chosen (its "first frame")
  creates: { cam: string; body: unknown; onBehalfOf: string | undefined }[];
  writes: { method: string; path: string; onBehalfOf: string | undefined }[];
  add(cam: string, o?: Partial<FakeArchiveItem> & { body?: Buffer; thumb?: Buffer | null }): FakeArchiveItem;
}

// The UTC default name (a fake camera whose time was never read).
const stamp = (t: number) => new Date(t).toISOString().slice(0, 19).replace('T', ' ');
const fileSafe = (s: string) => s.replace(/[/\\:*?"<>|\u0000-\u001f\u007f]/g, '_');

// A stored ZIP (contract §5): CRC and sizes in the local headers, UTF-8 names.
export function storedZip(files: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0x21, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(f.data.length, 18);
    lh.writeUInt32LE(f.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, f.data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(f.data.length, 20);
    ch.writeUInt32LE(f.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + f.data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// The names of a ZIP's entries, from its central directory (tests).
export function zipNames(zip: Buffer): string[] {
  const names: string[] = [];
  const e = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (e < 0) return names;
  let p = zip.readUInt32LE(e + 16);
  for (let i = 0; i < zip.readUInt16LE(e + 10); i++) {
    const n = zip.readUInt16LE(p + 28), x = zip.readUInt16LE(p + 30), c = zip.readUInt16LE(p + 32);
    names.push(zip.subarray(p + 46, p + 46 + n).toString('utf8'));
    p += 46 + n + x + c;
  }
  return names;
}

export function installFakeArchive(app: Express, fake: FakeProxy, dir: string): FakeArchive {
  let nextId = 1;
  const a: FakeArchive = {
    entries: new Map(),
    jobs: new Map(),
    enabled: true,
    free: 100 * 2 ** 30,
    diskSize: 228 * 2 ** 30,
    minFreeBytes: 2 * 2 ** 30,
    jobMs: 0,
    failNext: null,
    zipChunkDelayMs: 0,
    defaultThumb: FAKE_JPEG,
    creates: [],
    writes: [],
    add(cam, o = {}) {
      const now = Date.now();
      const body = o.body ?? PLACEHOLDER_MP4;
      const recordedFrom = o.recordedFrom ?? now - 3_600_000;
      const retentionDays = o.retentionDays === undefined ? DEFAULT_RETENTION_DAYS : o.retentionDays;
      const createdAt = o.createdAt ?? now;
      const item: FakeArchiveItem = {
        id: nextId++,
        cam,
        cameraName: fake.cameraNames.get(cam) ?? cam,
        name: `${stamp(recordedFrom)} ${fake.cameraNames.get(cam) ?? cam}`,
        labels: [],
        createdAt,
        recordedTo: recordedFrom + 30_000,
        durationS: 30,
        quality: 'sd',
        original: false,
        bytes: body.length,
        source: { type: 'clip', clipId: 1, stream: 'sub' },
        eventKinds: [],
        found: [],
        thumbnail: { from: o.thumb === null ? 'none' : 'frame', at: null },
        createdBy: 'client',
        ...o,
        recordedFrom,
        retentionDays,
        expiresAt: retentionDays === null ? null : createdAt + retentionDays * DAY,
      } as FakeArchiveItem;
      delete (item as { body?: unknown }).body;
      delete (item as { thumb?: unknown }).thumb;
      a.entries.set(item.id, { item, body, thumb: o.thumb === null ? null : (o.thumb ?? a.defaultThumb), metadata: snapshot(item) });
      return item;
    },
  };

  const urls = (id: number) => ({ video: `/api/archive/${id}/video`, thumbnail: `/api/archive/${id}/thumbnail`, metadata: `/api/archive/${id}/metadata` });
  const out = (it: FakeArchiveItem) => ({ ...it, urls: urls(it.id) });
  const who = (req: Request) => {
    const v = req.get('x-on-behalf-of');
    return v && /^[\x21-\x7e]{1,254}$/.test(v) ? v : undefined;
  };
  const wrote = (req: Request) => a.writes.push({ method: req.method, path: req.path, onBehalfOf: who(req) });
  const bad = (res: Response, detail: string) => void res.status(400).json({ error: 'invalid', detail });

  // The window's events and analyses, as the job's end sees them (§2.6).
  function snapshot(it: FakeArchiveItem): Record<string, unknown> {
    const events = (fake.events.get(it.cam) ?? []).filter((e) => e.start <= it.recordedTo && (e.end ?? Infinity) >= it.recordedFrom - 5000);
    const checks = (fake.checks.get(it.cam) ?? []).filter((c) => c.stillTs >= it.recordedFrom && c.stillTs <= it.recordedTo);
    return {
      schema: 1,
      camera: { id: it.cam, name: it.cameraName, model: 'RLC-1224A' },
      window: { from: it.recordedFrom, to: it.recordedTo },
      events: events.map((e) => ({ id: e.id, kind: e.kind, source: e.source, start: e.start, end: e.end, recovered: false, analysis: e.analysis ?? null })),
      stillChecks: checks.map((c) => ({ id: c.id, stillTs: c.stillTs, provider: c.provider, objects: c.objects, summary: c.summary })),
      proxy: { version: 'fake' },
      archivedAt: it.createdAt,
    };
  }
  const metadataOf = (e: Entry) => {
    const { urls: _u, ...item } = out(e.item);
    return { ...e.metadata, item };
  };
  const push = (cam: string, action: string, ids: number[], items?: FakeArchiveItem[]) =>
    fake.push({ cam, type: 'archive', data: { action, ids, ...(items ? { items: items.map(out) } : {}) } });

  // --- Create (§2) ---
  app.post('/api/cameras/:cam/archive', express.json(), (req, res) => {
    const cam = req.params.cam as string;
    a.creates.push({ cam, body: req.body, onBehalfOf: who(req) });
    const b = (req.body ?? {}) as { source?: { type?: unknown; id?: unknown; clipId?: unknown }; name?: unknown; labels?: unknown; retentionDays?: unknown; thumbnailAt?: unknown };
    if (b.name !== undefined && nameProblem(b.name)) return bad(res, nameProblem(b.name)!);
    const labels = b.labels === undefined ? { ok: true as const, labels: [] } : normalizeLabels(b.labels);
    if (!labels.ok) return bad(res, labels.error);
    if (b.retentionDays !== undefined && retentionProblem(b.retentionDays)) return bad(res, retentionProblem(b.retentionDays)!);
    if (b.thumbnailAt !== undefined && !Number.isSafeInteger(b.thumbnailAt)) return bad(res, 'thumbnailAt is unix ms');
    // Any camera the clip names: the e2e fake serves Den and Barn, but lists only Den.
    const s = b.source ?? {};
    let body: Buffer;
    let window: { from: number; to: number };
    let quality: string;
    let original = false;
    let source: Record<string, unknown>;
    if (s.type === 'composition') {
      const job = typeof s.id === 'string' ? fake.compositions.get(s.id) : undefined;
      if (!job) return void res.status(404).json({ error: 'not_found', detail: 'no such composition' });
      if (job.state !== 'done') return void res.status(409).json({ error: 'not_ready', state: job.state });
      const clip = job.clipId !== undefined ? fake.clips.find((c) => c.id === job.clipId) : undefined;
      body = clip?.body ?? PLACEHOLDER_MP4;
      window = job.window ?? { from: Date.now() - job.durationS * 1000, to: Date.now() };
      quality = job.size ?? 'sd';
      source = { type: 'composition', jobId: s.id, anchor: job.at !== undefined ? 'at' : 'clip', ...(job.at !== undefined ? { at: job.at } : { clipId: job.clipId, span: null }), preS: job.preS ?? 0, postS: job.postS ?? 0, size: quality, badge: true };
    } else if (s.type === 'clip') {
      const clip = Number.isSafeInteger(s.clipId) ? fake.clips.find((c) => c.id === s.clipId && c.cam === cam) : undefined;
      if (!clip) return void res.status(404).json({ error: 'not_found', detail: 'no such clip' });
      body = clip.body;
      window = { from: clip.start, to: clip.end };
      quality = clip.stream === 'main' ? '4k' : 'sd';
      original = true;
      source = { type: 'clip', clipId: clip.id, stream: clip.stream };
    } else if (s.type === 'recording') {
      if (typeof s.id !== 'string') return bad(res, 'source.id is a recording');
      const list = fake.recordings.get(cam);
      if (!list) return void res.status(503).json({ error: 'camera_offline' });
      const rec = list.find((r) => r.id === s.id);
      if (!rec) return void res.status(404).json({ error: 'unknown_recording' });
      body = rec.body;
      window = { from: rec.start, to: rec.end };
      quality = rec.stream === 'main' ? '4k' : 'sd';
      original = true;
      source = { type: 'recording', recording: rec.id, stream: rec.stream };
    } else return bad(res, 'source is a composition, a clip or a recording');
    if (!a.enabled) return void res.status(503).json({ error: 'archive_off' });
    const needed = body.length + 2 ** 20;
    if (a.free - needed < a.minFreeBytes) return void res.status(507).json({ error: 'insufficient_space', needed, free: a.free, minFreeBytes: a.minFreeBytes });
    const running = [...a.jobs.values()].filter((j) => j.state === 'queued' || j.state === 'running').length;
    if (running >= 4) return void res.status(429).json({ error: 'busy' });

    const job: FakeArchiveJob = { id: randomBytes(16).toString('base64url'), cam, state: 'running', phase: 'copying', progress: 0, bytes: 0, size: body.length };
    a.jobs.set(job.id, job);
    const finish = () => {
      if (job.state === 'cancelled') return;
      if (a.failNext) {
        Object.assign(job, { state: 'failed', phase: null, error: a.failNext, detail: `the job failed: ${a.failNext}` });
        a.failNext = null;
        return;
      }
      const at = typeof b.thumbnailAt === 'number' ? b.thumbnailAt : null;
      const still = at !== null ? fake.stills.get(cam)?.get(at) : undefined;
      const kinds = [...new Set((fake.events.get(cam) ?? []).filter((e) => e.start <= window.to && (e.end ?? Infinity) >= window.from - 5000).map((e) => e.kind))];
      const found = [...new Set((fake.analyses.get(cam) ?? []).filter((x) => x.start >= window.from - 5000 && x.start <= window.to).flatMap((x) => x.summary.map((y) => y.category)))];
      const item = a.add(cam, {
        body,
        thumb: still ?? a.defaultThumb,
        ...(typeof b.name === 'string' ? { name: b.name.trim() } : {}),
        labels: labels.labels,
        retentionDays: b.retentionDays === undefined ? DEFAULT_RETENTION_DAYS : (b.retentionDays as number | null),
        recordedFrom: window.from,
        recordedTo: window.to,
        durationS: Math.round((window.to - window.from) / 100) / 10,
        quality,
        original,
        source,
        eventKinds: kinds,
        found,
        thumbnail: still ? { from: 'still', at } : { from: 'frame', at: null },
      });
      a.free -= body.length;
      Object.assign(job, { state: 'done', phase: null, progress: 1, bytes: body.length, archiveId: item.id, item: out(item) });
      push(cam, 'add', [item.id], [item]);
    };
    if (!a.jobMs) {
      finish();
      // Failed within the 3 s: the error's status, the job as the body (contract §2).
      const FAIL: Record<string, number> = { insufficient_space: 507, camera_offline: 503, unknown_recording: 404, source_gone: 404, fetch_failed: 502, store_failed: 500, cancelled: 409 };
      if (job.state === 'failed') return void res.status(FAIL[job.error ?? ''] ?? 500).json(job);
      return void res.status(201).json(job);
    }
    job.state = 'queued';
    setTimeout(() => Object.assign(job, { state: job.state === 'cancelled' ? 'cancelled' : 'running', progress: 0.5, bytes: Math.floor(body.length / 2) }), a.jobMs / 2);
    setTimeout(finish, a.jobMs);
    res.status(202).json(job);
  });
  app.get('/api/archive/jobs/:id', (req, res) => {
    const j = a.jobs.get(req.params.id as string);
    if (!j) return void res.status(404).json({ error: 'not_found' });
    res.json(j);
  });
  app.delete('/api/archive/jobs/:id', (req, res) => {
    const j = a.jobs.get(req.params.id as string);
    if (!j) return void res.status(404).json({ error: 'not_found' });
    wrote(req);
    if (j.state === 'queued' || j.state === 'running') Object.assign(j, { state: 'cancelled', error: 'cancelled' });
    res.status(204).end();
  });

  // --- List (§3), status (§6), ZIP (§5), bulk delete ---
  app.get('/api/archive', (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    const sort = (q.sort ?? 'created') as SortKey;
    if (!(SORT_KEYS as readonly string[]).includes(sort)) return bad(res, 'sort');
    const order = q.order ?? 'desc';
    if (order !== 'asc' && order !== 'desc') return bad(res, 'order');
    const limit = q.limit === undefined ? 100 : Number(q.limit), offset = q.offset === undefined ? 0 : Number(q.offset);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500 || !Number.isInteger(offset) || offset < 0) return bad(res, 'limit 1 to 500, offset 0 or more');
    const want = q.labels ? q.labels.split(',').map((l) => l.toLowerCase()) : [];
    const qualities = q.quality ? q.quality.split(',') : null;
    if (qualities && !qualities.every((x) => (QUALITIES as readonly string[]).includes(x))) return bad(res, 'quality');
    const list = [...a.entries.values()]
      .map((e) => e.item)
      .filter((it) => (!q.cam || it.cam === q.cam) && want.every((l) => it.labels.some((x) => x.toLowerCase() === l)) && (!q.q || it.name.toLowerCase().includes(q.q.toLowerCase())) && (!qualities || qualities.includes(it.quality)) && (!q.from || it.recordedFrom >= Number(q.from)) && (!q.to || it.recordedFrom <= Number(q.to)))
      .sort((x, y) => compareItems(x, y, sort, order));
    res.json({ total: list.length, offset, limit, items: list.slice(offset, offset + limit).map(out) });
  });
  app.get('/api/archive/status', (_req, res) => {
    const items = [...a.entries.values()].map((e) => e.item);
    const bytes = items.reduce((n, x) => n + x.bytes, 0);
    const counts = new Map<string, number>();
    for (const l of ['Pet', 'Person', 'Vehicle', 'SD', '4K']) counts.set(l, 0);
    for (const it of items) for (const l of it.labels) counts.set(l, (counts.get(l) ?? 0) + 1);
    const created = items.map((x) => x.createdAt);
    const percent = Math.round((bytes / a.diskSize) * 1000) / 10;
    res.json({
      enabled: a.enabled, count: items.length, bytes, forever: items.filter((x) => x.retentionDays === null).length,
      oldestCreatedAt: created.length ? Math.min(...created) : null, newestCreatedAt: created.length ? Math.max(...created) : null,
      disk: { free: a.free, size: a.diskSize }, percentOfDisk: percent, warnPercent: 50, warning: percent > 50, minFreeBytes: a.minFreeBytes,
      nextCleanupAt: Date.now() + 6 * 3_600_000, expiringAtNextCleanup: 0, lastCleanup: null,
      labels: [...counts].map(([label, count]) => ({ label, count })),
    });
  });
  app.get('/api/archive/zip', async (req, res) => {
    const raw = String(req.query.ids ?? '');
    if (!/^\d{1,12}(,\d{1,12}){0,199}$/.test(raw)) return bad(res, 'ids is 1 to 200 ids');
    const ids = [...new Set(raw.split(',').map(Number))];
    const missing = ids.filter((id) => !a.entries.has(id));
    if (missing.length) return void res.status(404).json({ error: 'not_found', missing });
    const files = ids.flatMap((id) => {
      const e = a.entries.get(id)!;
      const base = `${fileSafe(e.item.name)} (${id})`;
      return [{ name: `${base}.mp4`, data: e.body }, { name: `${base}.json`, data: Buffer.from(JSON.stringify(metadataOf(e), null, 2)) }, ...(e.thumb ? [{ name: `${base}.jpg`, data: e.thumb }] : [])];
    });
    const zip = storedZip(files);
    const first = a.entries.get(ids[0])!.item;
    const t = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15).replace('T', '-');
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': String(zip.length), 'Content-Disposition': `attachment; filename="archive-${first.cam}-${t}.zip"` });
    if (!a.zipChunkDelayMs) return void res.end(zip);
    // In pieces, the last one late: a relay that buffers shows nothing until then.
    const half = Math.floor(zip.length / 2);
    res.write(zip.subarray(0, half));
    await new Promise((r) => setTimeout(r, a.zipChunkDelayMs));
    res.end(zip.subarray(half));
  });
  app.post('/api/archive/delete', express.json(), (req, res) => {
    const ids = (req.body as { ids?: unknown } | undefined)?.ids;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 500 || !ids.every((x) => Number.isSafeInteger(x))) return bad(res, 'ids is a list of 1 to 500 ids');
    wrote(req);
    const deleted: number[] = [], notFound: number[] = [];
    const byCam = new Map<string, number[]>();
    for (const id of ids as number[]) {
      const e = a.entries.get(id);
      if (!e) {
        notFound.push(id);
        continue;
      }
      a.entries.delete(id);
      a.free += e.item.bytes;
      deleted.push(id);
      byCam.set(e.item.cam, [...(byCam.get(e.item.cam) ?? []), id]);
    }
    for (const [cam, list] of byCam) push(cam, 'delete', list);
    res.json({ deleted, notFound });
  });

  // --- One item (§4) ---
  const entryOf = (req: Request, res: Response): Entry | undefined => {
    const id = String(req.params.id);
    if (!/^\d{1,12}$/.test(id)) return void bad(res, 'id');
    const e = a.entries.get(Number(id));
    if (!e) return void res.status(404).json({ error: 'not_found' });
    return e;
  };
  app.get('/api/archive/:id', (req, res) => {
    const e = entryOf(req, res);
    if (e) res.json(out(e.item));
  });
  app.patch('/api/archive/:id', express.json(), (req, res) => {
    const e = entryOf(req, res);
    if (!e) return;
    const b = (req.body ?? {}) as { name?: unknown; labels?: unknown; retentionDays?: unknown };
    if (b.name !== undefined && nameProblem(b.name)) return bad(res, nameProblem(b.name)!);
    const labels = b.labels === undefined ? null : normalizeLabels(b.labels);
    if (labels && !labels.ok) return bad(res, labels.error);
    if (b.retentionDays !== undefined && retentionProblem(b.retentionDays)) return bad(res, retentionProblem(b.retentionDays)!);
    wrote(req);
    const before = JSON.stringify(e.item);
    if (typeof b.name === 'string') e.item.name = b.name.trim();
    if (labels?.ok) e.item.labels = labels.labels;
    if (b.retentionDays !== undefined) {
      e.item.retentionDays = b.retentionDays as number | null;
      e.item.expiresAt = e.item.retentionDays === null ? null : e.item.createdAt + e.item.retentionDays * DAY;
    }
    if (JSON.stringify(e.item) !== before) push(e.item.cam, 'update', [e.item.id], [e.item]);
    res.json(out(e.item));
  });
  app.delete('/api/archive/:id', (req, res) => {
    const e = entryOf(req, res);
    if (!e) return;
    wrote(req);
    a.entries.delete(e.item.id);
    a.free += e.item.bytes;
    push(e.item.cam, 'delete', [e.item.id]);
    res.status(204).end();
  });
  app.get('/api/archive/:id/video', (req, res) => {
    const e = entryOf(req, res);
    if (!e) return;
    const file = join(dir, `archive-${e.item.id}.mp4`);
    writeFileSync(file, e.body);
    const headers: Record<string, string> = { 'Content-Type': 'video/mp4', 'Cache-Control': 'private, max-age=604800, immutable' };
    if (req.query.download === '1') {
      const name = `${fileSafe(e.item.name)}.mp4`;
      headers['Content-Disposition'] = `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
    }
    res.sendFile(file, { headers });
  });
  app.get('/api/archive/:id/thumbnail', (req, res) => {
    const e = entryOf(req, res);
    if (!e) return;
    if (!e.thumb) return void res.status(404).json({ error: 'not_found' });
    res.type('image/jpeg').setHeader('Cache-Control', 'private, max-age=604800, immutable');
    res.send(e.thumb);
  });
  app.get('/api/archive/:id/metadata', (req, res) => {
    const e = entryOf(req, res);
    if (e) res.json(metadataOf(e));
  });
  return a;
}
