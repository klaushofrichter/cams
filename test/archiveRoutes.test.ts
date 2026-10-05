// The Archive relay (cam-proxy's archive contract; cams spec
// 2026-10-05-archive-design): every call to the camera's cam-proxy with its
// client token, the lists of several proxies merged, writes on behalf of the
// signed-in person, video ranges and the ZIP streamed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import request from 'supertest';
import { createApp } from '../server/app';
import { setCameras } from '../server/cameraRegistry';
import { resetProxyClients } from '../server/proxy/client';
import { RecordingError } from '../server/recordings/errors';
import { getRecordings } from '../server/recordings/service';
import { SESSION_COOKIE, signSession } from '../server/session';
import { FAKE_JPEG, zipNames } from './proxy/fakeArchive';
import { FAKE_TOKEN, startFakeProxy, type FakeProxy } from './proxy/fakeProxy';

const EMAIL = 'klaus@klaushofrichter.net';
const auth = `${SESSION_COOKIE}=${signSession(EMAIL)}`;
const EVENT = '20260928-140000-140020';
const SPAN = { start: Date.parse('2026-09-28T14:00:00-05:00'), end: Date.parse('2026-09-28T14:00:20-05:00') };
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from('ftypisom'), Buffer.alloc(200, 7)]);
let a: FakeProxy; // den (cam1) and barn share it
let b: FakeProxy; // cam2's own
let old: FakeProxy; // an older cam-proxy: no archive

beforeEach(async () => {
  [a, b, old] = await Promise.all([startFakeProxy(), startFakeProxy(), startFakeProxy()]);
  a.cameraNames.set('barn', 'Barn');
  setCameras([
    { id: 'den', name: 'Den', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p', proxy: { url: a.url, token: FAKE_TOKEN, camera: 'cam1' } },
    { id: 'barn', name: 'Barn', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p', proxy: { url: a.url, token: FAKE_TOKEN } },
    { id: 'cam2', name: 'Cam 2', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p', proxy: { url: b.url, token: FAKE_TOKEN, camera: 'cam1' } },
    { id: 'shed', name: 'Shed', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p' },
  ]);
  resetProxyClients();
  vi.spyOn(getRecordings(), 'proxyClipOf').mockImplementation(async (_cam, id) => (id === EVENT ? { id: 7, event: SPAN } : null));
  a.clips.push({ id: 7, cam: 'cam1', start: SPAN.start, end: SPAN.end, stream: 'sub', events: [], body: MP4 });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([a.stop(), b.stop(), old.stop()]);
  setCameras([]);
});

const app = () => request(createApp());
const get = (path: string) => app().get(path).set('Cookie', auth);
const send = (method: 'post' | 'patch' | 'delete', path: string, body?: object) => app()[method](path).set('Cookie', auth).send(body);

async function composition(cam = 'den'): Promise<string> {
  const r = await send('post', `/api/cameras/${cam}/compositions`, { eventId: EVENT, preS: 0, postS: 5, size: '720p', badge: true });
  expect(r.status).toBe(201);
  await vi.waitFor(() => expect(a.compositions.get(r.body.id)?.state).toBe('done'));
  return r.body.id as string;
}

describe('the Archive relay: auth and checks', () => {
  it('needs a signed-in user, and the same origin for writes', async () => {
    expect((await app().get('/api/archive')).status).toBe(401);
    expect((await app().get('/api/archive/den/items/1/video')).status).toBe(401);
    const cross = await app().post('/api/archive/den/delete').set('Cookie', auth).set('Origin', 'https://evil.example').send({ ids: [1] });
    expect(cross.status).toBe(403);
  });

  it('answers 404 for a camera without a proxy and an unknown archive, 400 for a bad id', async () => {
    expect((await send('post', '/api/cameras/shed/archive', { source: { type: 'event', eventId: EVENT, quality: 'sub' } })).body).toEqual({ error: 'no_proxy' });
    expect((await get('/api/archive/shed/items/1')).body).toEqual({ error: 'unknown_archive' });
    expect((await get('/api/archive/barn/items/1')).body).toEqual({ error: 'unknown_archive' }); // barn reaches den's proxy: its archive is den's
    expect((await get('/api/archive/den/items/1x')).status).toBe(400);
    expect((await get('/api/archive/den/items/0')).status).toBe(400);
  });
});

describe('create (contract §2)', () => {
  it('archives a composition cams started: 201 with the item, as cams’s own, on behalf of the person', async () => {
    const job = await composition();
    const r = await send('post', '/api/cameras/den/archive', { source: { type: 'composition', id: job }, name: '  Fox at the door ', labels: ['pet', 'Fox', 'fox', 'sd'], retentionDays: null, thumbnailAt: 1000 });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ state: 'done', via: 'den', archiveId: 1, item: { via: 'den', id: 1, cam: 'cam1', camera: 'den', name: 'Fox at the door', labels: ['Pet', 'Fox', 'SD'], retentionDays: null, expiresAt: null, quality: '720p', urls: { video: '/api/archive/den/items/1/video', thumbnail: '/api/archive/den/items/1/thumbnail', metadata: '/api/archive/den/items/1/metadata', download: '/api/archive/den/items/1/video?download=1' } } });
    expect(a.archive.creates.at(-1)).toEqual({ cam: 'cam1', body: { source: { type: 'composition', id: job }, name: 'Fox at the door', labels: ['Pet', 'Fox', 'SD'], retentionDays: null, thumbnailAt: 1000 }, onBehalfOf: EMAIL });
    expect(a.requests.at(-1)?.auth).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(JSON.stringify(r.body)).not.toContain(a.url);
  });

  it('sends the session’s email as X-On-Behalf-Of, never one the browser sent', async () => {
    const job = await composition();
    const r = await app().post('/api/cameras/den/archive').set('Cookie', auth).set('X-On-Behalf-Of', 'evil@x').send({ source: { type: 'composition', id: job } });
    expect(r.status).toBe(201);
    expect(a.archive.creates.at(-1)?.onBehalfOf).toBe(EMAIL);
    await app().delete(`/api/archive/den/items/${r.body.archiveId}`).set('Cookie', auth).set('X-On-Behalf-Of', 'evil@x');
    expect(a.archive.writes.at(-1)).toMatchObject({ method: 'DELETE', onBehalfOf: EMAIL });
  });

  it('refuses a composition it didn’t start, without asking the proxy', async () => {
    const r = await send('post', '/api/cameras/den/archive', { source: { type: 'composition', id: 'A'.repeat(22) } });
    expect(r.status).toBe(404);
    expect(a.archive.creates).toHaveLength(0);
    const job = await composition();
    expect((await send('post', '/api/cameras/cam2/archive', { source: { type: 'composition', id: job } })).status).toBe(404); // another camera's
  });

  it('archives a plain save: the SD card’s file the download would serve', async () => {
    const spy = vi.spyOn(getRecordings(), 'archiveSource').mockResolvedValue({ type: 'recording', id: 'RecS03_20260928_140000_140020_6D28808_1A2B3C.mp4' });
    a.recordings.set('cam1', [{ id: 'RecS03_20260928_140000_140020_6D28808_1A2B3C.mp4', start: SPAN.start, end: SPAN.end, stream: 'sub', body: MP4 }]);
    const r = await send('post', '/api/cameras/den/archive', { source: { type: 'event', eventId: EVENT, quality: 'sub' } });
    expect(r.status).toBe(201);
    expect(spy).toHaveBeenCalledWith('den', EVENT, 'sub');
    expect(r.body.item).toMatchObject({ original: true, quality: 'sd', source: { type: 'recording', recording: 'RecS03_20260928_140000_140020_6D28808_1A2B3C.mp4', stream: 'sub' } });
    expect(a.archive.creates.at(-1)?.body).toEqual({ source: { type: 'recording', id: 'RecS03_20260928_140000_140020_6D28808_1A2B3C.mp4' } });
  });

  it('says when a 4K original isn’t listed, and a recording that is gone', async () => {
    vi.spyOn(getRecordings(), 'archiveSource').mockResolvedValueOnce(null);
    expect((await send('post', '/api/cameras/den/archive', { source: { type: 'event', eventId: EVENT, quality: 'main' } })).body).toEqual({ error: 'full_quality_unavailable' });
    vi.spyOn(getRecordings(), 'archiveSource').mockRejectedValueOnce(new RecordingError('unknown_clip', 'no such clip'));
    expect((await send('post', '/api/cameras/den/archive', { source: { type: 'event', eventId: '20260928-150000-150020', quality: 'sub' } })).body).toEqual({ error: 'unknown_recording' });
    vi.spyOn(getRecordings(), 'archiveSource').mockRejectedValueOnce(new Error('camera search failed'));
    expect((await send('post', '/api/cameras/den/archive', { source: { type: 'event', eventId: EVENT, quality: 'sub' } })).body).toEqual({ error: 'proxy_unavailable' });
    expect(a.archive.creates).toHaveLength(0);
  });

  it('checks name, labels, retention and the source before asking the proxy', async () => {
    const job = await composition();
    const body = (o: object) => ({ source: { type: 'composition', id: job }, ...o });
    for (const [o, detail] of [
      [{ name: ' ' }, /empty/],
      [{ labels: ['two words'] }, /one word/],
      [{ labels: Array.from({ length: 17 }, (_, i) => `x${i}`) }, /16/],
      [{ retentionDays: 0 }, /36500/],
      [{ thumbnailAt: 'now' }, /thumbnailAt/],
    ] as const) {
      const r = await send('post', '/api/cameras/den/archive', body(o));
      expect(r.status).toBe(400);
      expect(r.body.detail).toMatch(detail);
    }
    expect((await send('post', '/api/cameras/den/archive', { source: { type: 'file', id: '/etc/passwd' } })).status).toBe(400);
    expect((await send('post', '/api/cameras/den/archive', { source: { type: 'event', eventId: '../x', quality: 'sub' } })).status).toBe(400);
    expect(a.archive.creates).toHaveLength(0);
  });

  it('passes insufficient_space with the sizes, and the other refusals', async () => {
    const job = await composition();
    a.archive.free = a.archive.minFreeBytes + 1000;
    const r = await send('post', '/api/cameras/den/archive', { source: { type: 'composition', id: job } });
    expect(r.status).toBe(507);
    expect(r.body).toEqual({ error: 'insufficient_space', needed: MP4.length + 2 ** 20, free: a.archive.minFreeBytes + 1000, minFreeBytes: a.archive.minFreeBytes });
    a.archive.free = 2 ** 40;
    a.archive.enabled = false;
    expect((await send('post', '/api/cameras/den/archive', { source: { type: 'composition', id: job } })).body).toEqual({ error: 'archive_off' });
  });

  it('passes a job that failed at once with its status and code (contract §2)', async () => {
    const job = await composition();
    a.archive.failNext = 'fetch_failed';
    const r = await send('post', '/api/cameras/den/archive', { source: { type: 'composition', id: job } });
    expect(r.status).toBe(502);
    expect(r.body).toEqual({ error: 'fetch_failed', state: 'failed', detail: 'the job failed: fetch_failed' });
    a.archive.failNext = 'insufficient_space';
    const s = await send('post', '/api/cameras/den/archive', { source: { type: 'composition', id: job } });
    expect(s.status).toBe(507);
    expect(s.body.error).toBe('insufficient_space');
  });

  it('answers 202 for a longer job, which cams polls and cancels by its own copy of the id', async () => {
    const job = await composition();
    a.archive.jobMs = 400;
    const r = await send('post', '/api/cameras/den/archive', { source: { type: 'composition', id: job } });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ via: 'den', state: 'queued', item: null });
    const poll = () => get(`/api/archive/den/jobs/${r.body.id}`);
    expect((await poll()).status).toBe(200);
    await vi.waitFor(async () => expect((await poll()).body).toMatchObject({ state: 'done', archiveId: 1, item: { id: 1, via: 'den' } }), { timeout: 3000 });
    expect((await get(`/api/archive/den/jobs/${'B'.repeat(22)}`)).status).toBe(404); // not one cams started
    expect((await get(`/api/archive/cam2/jobs/${r.body.id}`)).status).toBe(404); // another proxy's
    const second = await send('post', '/api/cameras/den/archive', { source: { type: 'composition', id: job } });
    expect((await send('delete', `/api/archive/den/jobs/${second.body.id}`)).status).toBe(204);
    expect(a.archive.writes.at(-1)).toMatchObject({ method: 'DELETE', onBehalfOf: EMAIL });
    expect((await poll()).status).toBe(200);
  });

  it('limits new clips per person (10 a minute)', async () => {
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await send('post', '/api/cameras/den/archive', { source: { type: 'composition', id: 'C'.repeat(22) } })).status;
    expect(last).toBe(429);
  });
});

describe('list (contract §3)', () => {
  it('merges every proxy’s archive in the contract’s order, says which proxies answered, and an older one has none', async () => {
    setCameras([
      { id: 'den', name: 'Den', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p', proxy: { url: a.url, token: FAKE_TOKEN, camera: 'cam1' } },
      { id: 'barn', name: 'Barn', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p', proxy: { url: a.url, token: FAKE_TOKEN } },
      { id: 'cam2', name: 'Cam 2', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p', proxy: { url: b.url, token: FAKE_TOKEN, camera: 'cam1' } },
      { id: 'silo', name: 'Silo', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p', proxy: { url: `${old.url}/old`, token: FAKE_TOKEN } },
    ]);
    resetProxyClients();
    a.archive.add('cam1', { createdAt: 3000, bytes: 30 });
    a.archive.add('barn', { createdAt: 1000, bytes: 10 });
    b.archive.add('cam1', { createdAt: 2000, bytes: 20 });
    a.archive.add('ghost', { createdAt: 500 }); // a camera of the proxy cams doesn't know
    const r = await get('/api/archive');
    expect(r.status).toBe(200);
    expect(r.body.items.map((x: { via: string; id: number; camera: string | null }) => [x.via, x.id, x.camera])).toEqual([['den', 1, 'den'], ['cam2', 1, 'cam2'], ['den', 2, 'barn'], ['den', 3, null]]);
    expect(r.body.total).toBe(4);
    expect(r.body.proxies).toEqual([{ via: 'den', cams: ['den', 'barn'], ok: true }, { via: 'cam2', cams: ['cam2'], ok: true }, { via: 'silo', cams: ['silo'], ok: false, error: 'too_old' }]);
    const bySize = await get('/api/archive?sort=size&order=asc');
    expect(bySize.body.items.map((x: { bytes: number }) => x.bytes)).toEqual([10, 16, 20, 30]); // the ghost's is the placeholder's 16
    expect(a.requests.filter((x) => x.path === '/api/archive').at(-1)?.query).toMatchObject({ sort: 'size', order: 'asc' });
  });

  it('passes the filters and the sort, the camera as the proxy knows it, and pages through a large archive', async () => {
    for (let i = 0; i < 520; i++) a.archive.add('cam1', { createdAt: 10_000 + i });
    a.archive.add('barn', { labels: ['Fox'] });
    const r = await get('/api/archive?cam=den&labels=Pet,fox&q=door&quality=sd,720p&from=1&to=2&sort=duration&order=asc');
    expect(r.status).toBe(200);
    const asked = a.requests.filter((x) => x.path === '/api/archive');
    expect(asked.at(-1)?.query).toEqual({ cam: 'cam1', labels: 'Pet,fox', q: 'door', quality: 'sd,720p', from: '1', to: '2', sort: 'duration', order: 'asc', limit: '500', offset: '0' });
    expect(b.requests.some((x) => x.path === '/api/archive')).toBe(false); // cam2's proxy doesn't hold den
    const all = await get('/api/archive?cam=den');
    expect(all.body.items).toHaveLength(520);
    expect(a.requests.filter((x) => x.path === '/api/archive').at(-1)?.query).toMatchObject({ offset: '500' });
  });

  it('refuses a bad query', async () => {
    for (const q of ['sort=random', 'order=up', 'labels=two%20words', 'quality=8k', 'from=yesterday', 'cam=nope', `q=${'x'.repeat(121)}`]) expect((await get(`/api/archive?${q}`)).status, q).toBe(400);
  });

  it('relays each proxy’s status', async () => {
    a.archive.add('cam1', { labels: ['Person'] });
    const r = await get('/api/archive/status');
    expect(r.body[0]).toMatchObject({ via: 'den', ok: true, enabled: true, count: 1, labels: expect.arrayContaining([{ label: 'Person', count: 1 }]) });
    expect(r.body[1]).toMatchObject({ via: 'cam2', ok: true, count: 0 });
  });
});

describe('one item (contract §4)', () => {
  it('reads, edits (checked first, on behalf of the person) and deletes', async () => {
    const it0 = a.archive.add('cam1', { labels: ['Pet'] });
    expect((await get(`/api/archive/den/items/${it0.id}`)).body).toMatchObject({ id: it0.id, labels: ['Pet'], via: 'den' });
    const p = await send('patch', `/api/archive/den/items/${it0.id}`, { name: ' New ', labels: ['person', 'Fox'], retentionDays: 30 });
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ name: 'New', labels: ['Person', 'Fox'], retentionDays: 30, expiresAt: it0.createdAt + 30 * 86_400_000 });
    expect(a.archive.writes.at(-1)).toEqual({ method: 'PATCH', path: `/api/archive/${it0.id}`, onBehalfOf: EMAIL });
    expect((await send('patch', `/api/archive/den/items/${it0.id}`, { name: '' })).status).toBe(400);
    expect((await send('patch', `/api/archive/den/items/${it0.id}`, {})).status).toBe(400);
    expect((await send('patch', `/api/archive/den/items/${it0.id}`, { retentionDays: null })).body.expiresAt).toBeNull();
    expect((await send('delete', `/api/archive/den/items/${it0.id}`)).status).toBe(204);
    expect((await get(`/api/archive/den/items/${it0.id}`)).body).toEqual({ error: 'not_found' });
  });

  it('deletes many at once', async () => {
    const x = a.archive.add('cam1'), y = a.archive.add('barn');
    const r = await send('post', '/api/archive/den/delete', { ids: [x.id, 99, y.id] });
    expect(r.body).toEqual({ deleted: [x.id, y.id], notFound: [99] });
    expect((await send('post', '/api/archive/den/delete', { ids: [] })).status).toBe(400);
    expect((await send('post', '/api/archive/den/delete', { ids: Array.from({ length: 501 }, (_, i) => i + 1) })).status).toBe(400);
    expect((await send('post', '/api/archive/den/delete', { ids: ['1'] })).status).toBe(400);
  });

  it('serves the video with ranges, and as a named download', async () => {
    const it0 = a.archive.add('cam1', { body: MP4, name: 'Fox (at) the door' });
    const full = await get(`/api/archive/den/items/${it0.id}/video`).buffer(true).parse((res, cb) => {
      const c: Buffer[] = [];
      res.on('data', (d: Buffer) => c.push(d));
      res.on('end', () => cb(null, Buffer.concat(c)));
    });
    expect(full.status).toBe(200);
    expect(Buffer.compare(full.body as Buffer, MP4)).toBe(0);
    expect(full.headers).toMatchObject({ 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'content-length': String(MP4.length), 'cache-control': 'private, max-age=604800, immutable' });
    const part = await get(`/api/archive/den/items/${it0.id}/video`).set('Range', 'bytes=4-11');
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 4-11/${MP4.length}`);
    expect(part.headers['content-length']).toBe('8');
    const past = await get(`/api/archive/den/items/${it0.id}/video`).set('Range', `bytes=${MP4.length + 10}-`);
    expect(past.status).toBe(416);
    const dl = await get(`/api/archive/den/items/${it0.id}/video?download=1`);
    expect(dl.headers['cache-control']).toBe('no-store'); // a rename changes the name: never a cached download
    expect(dl.headers['content-disposition']).toBe(`attachment; filename="Fox (at) the door.mp4"; filename*=UTF-8''Fox%20%28at%29%20the%20door.mp4`);
    expect((await get(`/api/archive/den/items/99/video`)).status).toBe(404);
  });

  it('serves the thumbnail, and the metadata rebuilt from known fields', async () => {
    a.events.set('cam1', [{ id: 5, kind: 'person', source: 'onvif', start: 1_000_000, end: 1_005_000, endReason: 'state', analysis: { provider: 'google-vision', status: 'ok', stillTs: 1_001_000, objects: [{ name: 'Person', score: 0.9, box: { x0: 0, y0: 0, x1: 1, y1: 1 }, secret: 'x' }], summary: [{ category: 'person', score: 0.9 }], raw: 'raw' } }]);
    const it0 = a.archive.add('cam1', { recordedFrom: 999_000, recordedTo: 1_010_000 });
    const t = await get(`/api/archive/den/items/${it0.id}/thumbnail`);
    expect(t.headers['content-type']).toBe('image/jpeg');
    expect(Buffer.compare(t.body as Buffer, FAKE_JPEG)).toBe(0);
    const none = a.archive.add('cam1', { thumb: null });
    expect((await get(`/api/archive/den/items/${none.id}/thumbnail`)).status).toBe(404);
    const m = await get(`/api/archive/den/items/${it0.id}/metadata`);
    expect(m.body).toMatchObject({ item: { id: it0.id, via: 'den' }, camera: { id: 'cam1', name: 'Den', model: 'RLC-1224A' }, window: { from: 999_000, to: 1_010_000 }, events: [{ id: 5, kind: 'person', analysis: { stillTs: 1_001_000, objects: [{ name: 'Person', score: 0.9 }], summary: [{ category: 'person', score: 0.9 }] } }] });
    expect(JSON.stringify(m.body)).not.toMatch(/secret|raw/);
  });
});

describe('ZIP (contract §5)', () => {
  it('names each proxy’s ZIP apart, though both proxies call their camera cam1', async () => {
    const x = a.archive.add('cam1'), y = b.archive.add('cam1');
    const [za, zb] = await Promise.all([get(`/api/archive/den/zip?ids=${x.id}`), get(`/api/archive/cam2/zip?ids=${y.id}`)]);
    expect([za.status, zb.status]).toEqual([200, 200]);
    const name = (h: string | undefined) => /^attachment; filename="(archive-[a-z0-9-]+-\d{8}-\d{6}\.zip)"$/.exec(h ?? '')?.[1];
    expect(name(za.headers['content-disposition'])).toMatch(/^archive-den-/);
    expect(name(zb.headers['content-disposition'])).toMatch(/^archive-cam2-/);
  });

  it('names the ZIP by cams’s clock when the proxy sends no usable name', async () => {
    const x = a.archive.add('cam1');
    a.archive.zipDisposition = 'attachment; filename="../../etc/passwd"';
    const r = await get(`/api/archive/den/zip?ids=${x.id}`);
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toMatch(/^attachment; filename="archive-den-\d{8}-\d{6}\.zip"$/);
  });

  it('names a ZIP of a shared proxy after the first clip’s camera', async () => {
    const x = a.archive.add('barn');
    const r = await get(`/api/archive/den/zip?ids=${x.id}`);
    expect(r.headers['content-disposition']).toMatch(/^attachment; filename="archive-barn-\d{8}-\d{6}\.zip"$/);
  });

  it('streams the proxy’s ZIP as it comes, with its length and name', async () => {
    const x = a.archive.add('cam1', { name: 'Fox: at the door', body: MP4 }), y = a.archive.add('barn', { thumb: null });
    a.archive.zipChunkDelayMs = 600;
    const server = http.createServer(createApp()).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    try {
      const port = (server.address() as AddressInfo).port;
      const t0 = Date.now();
      const { headers, firstAt, body } = await new Promise<{ headers: http.IncomingHttpHeaders; firstAt: number; body: Buffer }>((resolve, reject) => {
        http.get({ port, host: '127.0.0.1', path: `/api/archive/den/zip?ids=${x.id},${y.id}`, headers: { Cookie: auth } }, (res) => {
          const chunks: Buffer[] = [];
          let firstAt = 0;
          res.on('data', (d: Buffer) => {
            firstAt ||= Date.now() - t0;
            chunks.push(d);
          });
          res.on('end', () => resolve({ headers: res.headers, firstAt, body: Buffer.concat(chunks) }));
        }).on('error', reject);
      });
      expect(headers['content-type']).toBe('application/zip');
      // Named by cams after its own id of the first clip's camera (den, the proxy's cam1).
      expect(headers['content-disposition']).toMatch(/^attachment; filename="archive-den-\d{8}-\d{6}\.zip"$/);
      expect(Number(headers['content-length'])).toBe(body.length);
      expect(firstAt).toBeLessThan(500); // the first half arrived before the proxy sent the rest
      expect(zipNames(body)).toEqual([`Fox_ at the door (${x.id}).mp4`, `Fox_ at the door (${x.id}).json`, `Fox_ at the door (${x.id}).jpg`, expect.stringMatching(/\(\d+\)\.mp4$/), expect.stringMatching(/\(\d+\)\.json$/)]);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it('lets go of the proxy when the viewer leaves before the ZIP starts', async () => {
    const x = a.archive.add('cam1');
    a.archive.zipHeaderDelayMs = 800;
    const server = http.createServer(createApp()).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    try {
      const port = (server.address() as AddressInfo).port;
      const req = http.get({ port, host: '127.0.0.1', path: `/api/archive/den/zip?ids=${x.id}`, headers: { Cookie: auth } });
      req.on('error', () => undefined);
      await vi.waitFor(() => expect(a.requests.some((r) => r.path === '/api/archive/zip')).toBe(true));
      req.destroy();
      await vi.waitFor(() => expect(a.archive.zipClosedEarly).toBe(1), { timeout: 600 }); // before the proxy would have answered
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it('passes the proxy’s 404 with the missing ids, refuses bad lists, and limits ZIPs per person (4 a minute)', async () => {
    const x = a.archive.add('cam1');
    expect((await get(`/api/archive/den/zip?ids=${x.id},77`)).body).toEqual({ error: 'not_found', missing: [77] });
    expect((await get('/api/archive/den/zip?ids=')).status).toBe(400);
    expect((await get(`/api/archive/den/zip?ids=${Array.from({ length: 201 }, (_, i) => i + 1).join(',')}`)).status).toBe(400);
    expect((await get(`/api/archive/den/zip?ids=${x.id}`)).status).toBe(200);
    expect((await get(`/api/archive/den/zip?ids=${x.id}`)).status).toBe(429); // the fifth this minute
  });
});
