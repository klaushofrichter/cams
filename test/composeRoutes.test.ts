// The compositions pass-through (cam-proxy spec 2026-09-28): the Downloads
// modal's calls go to the camera's cam-proxy with its token.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../server/app';
import { setCameras } from '../server/cameraRegistry';
import { getProxyClient, ProxyError, resetProxyClients } from '../server/proxy/client';
import { getRecordings } from '../server/recordings/service';
import { getClient } from '../server/reolink/clients';
import { SESSION_COOKIE, signSession } from '../server/session';
import { FAKE_TOKEN, startFakeProxy, type FakeProxy } from './proxy/fakeProxy';
import { BETA, applyFleet, cookieFor, k, restoreMode, twoAccounts } from './helpers/fleet';

const auth = `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`;
const EVENT = '20260928-140000-140020';
const SPAN = { start: Date.parse('2026-09-28T14:00:00-05:00'), end: Date.parse('2026-09-28T14:00:20-05:00') };
const LONG = '20261004-071650-071844'; // 114 s
const LONG_SPAN = { start: Date.parse('2026-10-04T07:16:50-05:00'), end: Date.parse('2026-10-04T07:18:44-05:00') };
let fake: FakeProxy;

beforeEach(async () => {
  fake = await startFakeProxy();
  setCameras([
    { id: 'den', name: 'Den', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p', proxy: { url: fake.url, token: FAKE_TOKEN, camera: 'cam1' } },
    { id: 'shed', name: 'Shed', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p' },
  ]);
  resetProxyClients();
  // The event → proxy clip lookup has its own tests (the recordings service).
  // The proxy's FTP copy of an event can start earlier and run longer than
  // the SD recording (image 16 of 2026-10-04: a 114 s recording).
  vi.spyOn(getRecordings(), 'proxyClipOf').mockImplementation(async (_cam, id) => (id === EVENT ? { id: 7, event: SPAN } : id === LONG ? { id: 8, event: LONG_SPAN } : null));
  fake.clips.push({ id: 7, cam: 'cam1', start: SPAN.start, end: SPAN.end, stream: 'sub', events: [], body: Buffer.alloc(1) });
  fake.clips.push({ id: 8, cam: 'cam1', start: LONG_SPAN.start - 131_000, end: LONG_SPAN.end, stream: 'sub', events: [], body: Buffer.alloc(1) });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fake.stop();
  setCameras([]);
});

const post = (id: string, body: object) => request(createApp()).post(`/api/cameras/${id}/compositions`).set('Cookie', auth).send(body);

describe('compositions pass-through', () => {
  it('finds the proxy clip for the event and forwards the request', async () => {
    const r = await post('den', { eventId: EVENT, preS: 5, postS: 10, size: 'sd', badge: true });
    expect(r.status).toBe(201);
    expect(r.body.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(fake.composeRequests.at(-1)).toEqual({ clipId: 7, span: SPAN, preS: 5, postS: 10, size: 'sd', badge: true });
    await post('den', { eventId: EVENT, preS: 0, postS: 5, size: 'sd', badge: false, timeZone: 'America/Chicago' });
    expect(fake.composeRequests.at(-1)).toMatchObject({ timeZone: 'America/Chicago' }); // the cards' clock (final review I5)
    expect(fake.requests.at(-1)?.auth).toBe(`Bearer ${FAKE_TOKEN}`);
  });

  // Image 16 of 2026-10-04: the dialog said 44 s, the proxy "At most 60 s":
  // it applied the rolls to its own, longer copy (245 s → 175 s).
  it('sends the recording\'s span, so the proxy measures the same 44 s as the dialog (114 s, pre -100, post 30)', async () => {
    const r = await post('den', { eventId: LONG, preS: -100, postS: 30, size: 'sd', badge: true });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ durationS: 44 });
    expect(fake.composeRequests.at(-1)).toMatchObject({ clipId: 8, span: LONG_SPAN, preS: -100, postS: 30 });
  });

  // The fake mirrors cam-proxy's spanOf and overlap rule (review of #176).
  it('the fake proxy refuses a malformed span, and one that misses the clip, like cam-proxy', async () => {
    const send = (span: unknown) => fetch(`${fake.url}/api/cameras/cam1/compositions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${FAKE_TOKEN}` }, body: JSON.stringify({ clipId: 7, span, preS: 0, postS: 0, size: 'sd', badge: false }) }).then(async (r) => [r.status, await r.json()]);
    const malformed = [400, { error: 'invalid', detail: 'span is {start, end} in unix ms, start before end, at most a day apart' }];
    expect(await send({ start: SPAN.start, end: 'x' })).toEqual(malformed);
    expect(await send({ start: SPAN.end, end: SPAN.start })).toEqual(malformed);
    expect(await send({ start: SPAN.start, end: SPAN.start + 86_400_001 })).toEqual(malformed);
    expect(await send({ start: SPAN.end - 500, end: SPAN.end + 60_000 })).toEqual([400, { error: 'invalid', detail: 'span must overlap the clip by at least 1 s' }]);
    expect((await send(SPAN))[0]).toBe(201);
  });

  it('checks the length itself, with the dialog\'s rule and words, before asking the proxy', async () => {
    const before = fake.composeRequests.length;
    expect((await post('den', { eventId: LONG, preS: 187, postS: 0, size: 'sd', badge: true })).body).toEqual({ error: 'invalid', detail: 'At most 5m' });
    expect((await post('den', { eventId: LONG, preS: 0, postS: 7, size: '1080p', badge: true })).body).toEqual({ error: 'invalid', detail: 'At most 2m' });
    expect((await post('den', { eventId: LONG, preS: -114, postS: 0, size: 'sd', badge: true })).body).toEqual({ error: 'invalid', detail: 'At least 1 s of the clip must remain' });
    expect(fake.composeRequests.length).toBe(before);
    expect((await post('den', { eventId: LONG, preS: 186, postS: 0, size: 'sd', badge: true })).body).toMatchObject({ durationS: 300 });
  });

  it('polls, then streams the result as a download or inline', async () => {
    fake.composeDelayMs = 0;
    const { body } = await post('den', { eventId: EVENT, preS: 0, postS: 5, size: 'sd', badge: false });
    await new Promise((res) => setTimeout(res, 20));
    expect((await request(createApp()).get(`/api/cameras/den/compositions/${body.id}`).set('Cookie', auth)).body).toMatchObject({ state: 'done' });
    const dl = await request(createApp()).get(`/api/cameras/den/compositions/${body.id}/video?name=den-2026-09-28_14-00-00-composed-sd.mp4`).set('Cookie', auth);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toBe('video/mp4');
    expect(dl.headers['content-disposition']).toBe('attachment; filename="den-2026-09-28_14-00-00-composed-sd.mp4"');
    const inline = await request(createApp()).get(`/api/cameras/den/compositions/${body.id}/video?inline=1`).set('Cookie', auth);
    expect(inline.headers['content-disposition']).toBe('inline');
    const odd = await request(createApp()).get(`/api/cameras/den/compositions/${body.id}/video?name=../x`).set('Cookie', auth);
    expect(odd.headers['content-disposition']).toBe('attachment; filename="composed.mp4"');
  });

  it('answers 409 before the result is ready', async () => {
    fake.composeDelayMs = 10_000;
    const { body } = await post('den', { eventId: EVENT, preS: 0, postS: 5, size: 'sd', badge: false });
    expect((await request(createApp()).get(`/api/cameras/den/compositions/${body.id}/video`).set('Cookie', auth)).status).toBe(409);
  });

  it('cancels', async () => {
    const { body } = await post('den', { eventId: EVENT, preS: 0, postS: 5, size: 'sd', badge: false });
    expect((await request(createApp()).delete(`/api/cameras/den/compositions/${body.id}`).set('Cookie', auth)).status).toBe(204);
    expect(fake.compositions.has(body.id)).toBe(false);
  });

  it('says no_proxy, no_clip, bad job ids, and needs a signed-in user', async () => {
    expect((await post('shed', { eventId: EVENT, preS: 0, postS: 5, size: 'sd', badge: false })).body).toEqual({ error: 'no_proxy' });
    expect((await post('den', { eventId: '20260928-090000-090010', preS: 0, postS: 5, size: 'sd', badge: false })).body).toEqual({ error: 'no_clip' });
    expect((await post('den', { eventId: '../x', preS: 0, postS: 5, size: 'sd', badge: false })).status).toBe(400);
    expect((await request(createApp()).get('/api/cameras/den/compositions/..%2Fx').set('Cookie', auth)).status).toBe(400);
    expect((await request(createApp()).post('/api/cameras/den/compositions').send({})).status).toBe(401);
  });

  it('says proxy_unavailable when the proxy is down', async () => {
    await fake.stop();
    expect((await post('den', { eventId: EVENT, preS: 0, postS: 5, size: 'sd', badge: false })).status).toBe(502);
    fake = await startFakeProxy();
  });

  // CodeQL js/request-forgery: only jobs cams started go to the proxy, by
  // cams's own copy of the id.
  it('refuses a job it did not start, without asking the proxy', async () => {
    const before = fake.requests.length;
    const stranger = 'z'.repeat(22);
    expect((await request(createApp()).get(`/api/cameras/den/compositions/${stranger}`).set('Cookie', auth)).status).toBe(404);
    expect((await request(createApp()).get(`/api/cameras/den/compositions/${stranger}/video`).set('Cookie', auth)).status).toBe(404);
    expect((await request(createApp()).delete(`/api/cameras/den/compositions/${stranger}`).set('Cookie', auth)).status).toBe(404);
    expect(fake.requests.length).toBe(before);
  });

  it('keeps a job it is still asked about past 20 minutes from its start (issue #76)', async () => {
    fake.composeDelayMs = 0;
    const t0 = Date.now();
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(t0);
    const { body } = await post('den', { eventId: EVENT, preS: 0, postS: 5, size: 'sd', badge: false });
    now.mockReturnValue(t0 + 15 * 60_000); // the dialog's once-a-minute keep-alive
    expect((await request(createApp()).get(`/api/cameras/den/compositions/${body.id}`).set('Cookie', auth)).status).toBe(200);
    now.mockReturnValue(t0 + 30 * 60_000);
    await post('den', { eventId: EVENT, preS: 0, postS: 6, size: 'sd', badge: false }); // prunes the old ones
    expect((await request(createApp()).get(`/api/cameras/den/compositions/${body.id}`).set('Cookie', auth)).status).toBe(200);
  });

  it('keeps jobs per camera', async () => {
    setCameras([
      { id: 'den', name: 'Den', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p', proxy: { url: fake.url, token: FAKE_TOKEN, camera: 'cam1' } },
      { id: 'barn', name: 'Barn', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p', proxy: { url: fake.url, token: FAKE_TOKEN, camera: 'cam1' } },
    ]);
    resetProxyClients();
    const { body } = await post('den', { eventId: EVENT, preS: 0, postS: 5, size: 'sd', badge: false });
    expect((await request(createApp()).get(`/api/cameras/barn/compositions/${body.id}`).set('Cookie', auth)).status).toBe(404);
  });

  // Issue #72 items.
  it('passes byte ranges through for the preview (iOS Safari)', async () => {
    fake.composeDelayMs = 0;
    const { body } = await post('den', { eventId: EVENT, preS: 0, postS: 5, size: 'sd', badge: false });
    await new Promise((res) => setTimeout(res, 20));
    const r = await request(createApp()).get(`/api/cameras/den/compositions/${body.id}/video?inline=1`).set('Cookie', auth).set('Range', 'bytes=0-3');
    expect(r.status).toBe(206);
    expect(r.headers['content-range']).toMatch(/^bytes 0-3\/\d+$/);
    expect(r.headers['accept-ranges']).toBe('bytes');
  });

  it('says whether the proxy has a copy of the event, before anything is composed', async () => {
    expect((await request(createApp()).get(`/api/cameras/den/compositions/available?eventId=${EVENT}`).set('Cookie', auth)).body).toEqual({ available: true });
    expect((await request(createApp()).get('/api/cameras/den/compositions/available?eventId=20260928-090000-090010').set('Cookie', auth)).body).toEqual({ available: false });
    expect((await request(createApp()).get(`/api/cameras/shed/compositions/available?eventId=${EVENT}`).set('Cookie', auth)).body).toEqual({ available: false });
  });

  it('answers 502, not "no copy", when the lookup fails (issue #76)', async () => {
    vi.spyOn(getRecordings(), 'proxyClipOf').mockRejectedValue(new ProxyError('proxy_unreachable', 'down'));
    const r = await request(createApp()).get(`/api/cameras/den/compositions/available?eventId=${EVENT}`).set('Cookie', auth);
    expect(r.status).toBe(502);
    expect(r.body).toEqual({ error: 'proxy_unavailable' });
    expect((await post('den', { eventId: EVENT, preS: 0, postS: 5, size: 'sd', badge: false })).status).toBe(502);
  });
});

// "Save clip around this" (#179 phase 3, spec §5): `at` instead of `eventId`.
describe('compositions around a second', () => {
  // A second a minute ago with stills from 30 s before to 30 s after, and an
  // FTP clip over its last 10 s.
  const AT = Math.floor(Date.now() / 1000) * 1000 - 60_000;
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  beforeEach(() => {
    fake.stills.set('cam1', new Map(Array.from({ length: 61 }, (_, i) => [AT - 30_000 + i * 1000, jpeg])));
    fake.clips.push({ id: 9, cam: 'cam1', start: AT + 20_000, end: AT + 30_000, stream: 'sub', events: [], body: Buffer.alloc(1) });
    // The camera's time settings: UTC-6, DST by the US rule (UTC-5 in summer).
    vi.spyOn(getClient(k('den'))!, 'timeInfo').mockResolvedValue({ stdOffsetMinutes: -360, dstOffsetMinutes: 60, dstRule: US_RULE });
  });
  const US_RULE = { start: { mon: 3, week: 2, weekday: 0, minutes: 120 }, end: { mon: 11, week: 1, weekday: 0, minutes: 120 } };
  const around = (more: object = {}) => post('den', { at: AT, preS: 10, postS: 10, size: 'sd', badge: true, ...more });
  const stamp = (t: number, offMin: number) => new Date(t + offMin * 60_000).toISOString().slice(0, 19).replace('T', '_').replaceAll(':', '-');
  // America/Chicago's UTC offset at t in minutes (the US rule, as the
  // camera's): from Intl, not from the code under test, so the expectation
  // is right on any day the suite runs (it said -300, CDT, until DST ended).
  const chicagoOffset = (t: number) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(t).map((x) => [x.type, Number(x.value)]));
    return (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000) / 60_000;
  };

  it('relays {at, …} and names the file in the camera\'s time', async () => {
    const r = await around({ timeZone: 'Asia/Tokyo' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ durationS: 21, name: `den-${stamp(AT, chicagoOffset(AT))}-around.mp4` });
    expect(fake.composeRequests.at(-1)).toEqual({ at: AT, preS: 10, postS: 10, size: 'sd', badge: true, timeZone: 'Asia/Tokyo' });
    // Remembered like a clip's job: it can be polled and fetched.
    expect((await request(createApp()).get(`/api/cameras/den/compositions/${r.body.id}`).set('Cookie', auth)).status).toBe(200);
  });

  // Review of #190: DST enabled is not DST in effect; winter names are standard time.
  it.each([
    ['winter', '2026-12-15T19:03:22Z', '2026-12-15_13-03-22'],
    ['summer', '2026-10-04T19:03:22Z', '2026-10-04_14-03-22'],
    ['the last daylight second before falling back', '2026-11-01T06:59:59Z', '2026-11-01_01-59-59'],
    ['the first standard second after it', '2026-11-01T07:00:00Z', '2026-11-01_01-00-00'],
    ['the first daylight second in spring', '2026-03-08T08:00:00Z', '2026-03-08_03-00-00'],
  ])('names the file with the offset in effect at the second: %s', async (_name, iso, stamp) => {
    const at = Date.parse(iso);
    vi.useFakeTimers({ toFake: ['Date'], now: at + 60_000 });
    try {
      fake.stills.set('cam1', new Map([[at, jpeg]]));
      // Signed at the faked time (a session from "the future" is refused).
      const r = await request(createApp()).post('/api/cameras/den/compositions').set('Cookie', `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`).send({ at, preS: 0, postS: 0, size: 'sd', badge: true });
      expect(r.status).toBe(201);
      expect(r.body.name).toBe(`den-${stamp}-around.mp4`);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the oracle: Chicago is -300 in summer, -360 in winter, and changes at the US rule\'s seconds', () => {
    expect([Date.parse('2026-10-04T19:03:22Z'), Date.parse('2026-11-01T06:59:59Z'), Date.parse('2026-11-01T07:00:00Z'), Date.parse('2026-12-15T19:03:22Z'), Date.parse('2026-03-08T07:59:59Z'), Date.parse('2026-03-08T08:00:00Z')].map(chicagoOffset)).toEqual([-300, -300, -360, -360, -360, -300]);
  });

  // The camera's time unknown: the viewer's zone, at fixed seconds across
  // the US changes (Chicago) and in a zone without DST (Tokyo).
  it.each([
    ['America/Chicago', 'the last daylight second before falling back', '2026-11-01T06:59:59Z', '2026-11-01_01-59-59'],
    ['America/Chicago', 'the first standard second after it', '2026-11-01T07:00:00Z', '2026-11-01_01-00-00'],
    ['America/Chicago', 'the last standard second in spring', '2026-03-08T07:59:59Z', '2026-03-08_01-59-59'],
    ['America/Chicago', 'the first daylight second in spring', '2026-03-08T08:00:00Z', '2026-03-08_03-00-00'],
    ['Asia/Tokyo', 'the US fall-back second', '2026-11-01T07:00:00Z', '2026-11-01_16-00-00'],
    ['Asia/Tokyo', 'the US spring second', '2026-03-08T08:00:00Z', '2026-03-08_17-00-00'],
  ])('camera time unknown, viewer in %s: %s', async (zone, _name, iso, expected) => {
    vi.spyOn(getClient(k('den'))!, 'timeInfo').mockRejectedValue(new Error('offline'));
    const at = Date.parse(iso);
    vi.useFakeTimers({ toFake: ['Date'], now: at + 60_000 });
    try {
      fake.stills.set('cam1', new Map([[at, jpeg]]));
      const r = await request(createApp()).post('/api/cameras/den/compositions').set('Cookie', `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`).send({ at, preS: 0, postS: 0, size: 'sd', badge: true, timeZone: zone });
      expect(r.status).toBe(201);
      expect(r.body.name).toBe(`den-${expected}-around.mp4`);
    } finally {
      vi.useRealTimers();
    }
  });

  it('names the file in the viewer\'s zone when the camera\'s time is unknown, else UTC', async () => {
    vi.spyOn(getClient(k('den'))!, 'timeInfo').mockRejectedValue(new Error('offline'));
    expect((await around({ timeZone: 'Asia/Tokyo' })).body.name).toBe(`den-${stamp(AT, 540)}-around.mp4`);
    expect((await around()).body.name).toBe(`den-${stamp(AT, 0)}-around.mp4`);
  });

  it('relays a dry run and its answers', async () => {
    const r = await around({ dryRun: true });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ start: AT - 10_000, end: AT + 11_000, durationS: 21, seconds: { clip: 0, still: 21, card: 0 }, clips: [] });
    const edge = await around({ at: AT + 20_000, preS: 5, postS: 5, dryRun: true });
    expect(edge.body).toMatchObject({ seconds: { clip: 6, still: 5, card: 0 }, clips: [{ start: AT + 20_000, end: AT + 30_000 }] });
    expect(fake.composeRequests.at(-1)).toMatchObject({ dryRun: true });
  });

  it('passes the proxy\'s 409 nothing_to_compose through', async () => {
    const r = await around({ at: AT - 5 * 60_000 });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: 'nothing_to_compose', detail: 'no clip or still covers any second of this window' });
  });

  it.each([
    [{ eventId: EVENT }, 'exactly one of eventId or at'],
    [{ at: String(AT) }, 'at is a whole second (unix ms)'],
    [{ at: AT + 0.5 }, 'at is a whole second (unix ms)'],
    [{ at: AT + 1 }, 'at is a whole second (unix ms)'],
    [{ at: -1000 }, 'at is a whole second (unix ms)'],
    [{ at: AT + 3_600_000 }, 'at is in the future'],
    [{ at: AT - 9 * 86_400_000 }, 'at is older than the stills and clips kept'],
    [{ preS: -1 }, 'Whole seconds from 0 to 3600'],
    [{ preS: 150, postS: 150 }, 'At most 5m'],
    [{ preS: 60, postS: 60, size: '1080p' }, 'At most 2m'],
    [{ size: '4k' }, 'size is sd, 360p, 720p or 1080p'],
    [{ badge: 'yes' }, 'badge is true or false'],
    [{ dryRun: 1 }, 'dryRun is true or false'],
  ])('refuses %j itself, without asking the proxy', async (more, detail) => {
    const before = fake.composeRequests.length;
    const r = await around(more);
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'invalid', detail });
    expect(fake.composeRequests.length).toBe(before);
  });

  // The fake mirrors cam-proxy's §13 rules (its own words).
  it('the fake proxy refuses like cam-proxy: a window not yet over, negative rolls, span with at', async () => {
    const send = (body: object) => fetch(`${fake.url}/api/cameras/cam1/compositions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${FAKE_TOKEN}` }, body: JSON.stringify({ preS: 0, postS: 0, size: 'sd', badge: false, ...body }) }).then(async (r) => [r.status, await r.json()]);
    const late = await send({ at: Math.floor(Date.now() / 1000) * 1000 - 2000, postS: 10 });
    expect(late[0]).toBe(400);
    expect(late[1].detail).toMatch(/^the window ends in the future \(\d+ s from now\)$/);
    expect(await send({ at: AT, preS: -1 })).toEqual([400, { error: 'invalid', detail: 'around a second, pre-roll and post-roll are whole seconds from 0 to 3600' }]);
    expect(await send({ at: AT, span: { start: AT, end: AT + 1000 } })).toEqual([400, { error: 'invalid', detail: 'span goes with clipId, not with at' }]);
    expect(await send({ at: AT, clipId: 7 })).toEqual([400, { error: 'invalid', detail: 'exactly one of clipId (a clip) or at (a second, unix ms)' }]);
  });
});

// Code review 2026-11-09, items 5, 7 and 8.
describe('compositions: who may cancel, malformed answers, every field checked', () => {
  // One account with two viewers and an admin, its camera on the fake proxy.
  function useAccount() {
    const [alpha, beta] = twoAccounts({ betaUrl: fake.url, betaToken: FAKE_TOKEN });
    beta.users = [
      { email: 'starter@example.org', role: 'viewer', disabled: false },
      { email: 'other@example.org', role: 'viewer', disabled: false },
      { email: 'boss@example.org', role: 'admin', disabled: false },
    ];
    applyFleet([alpha, beta]);
    resetProxyClients();
  }
  const as = (email: string) => cookieFor(email, BETA);
  const start = (email: string) => request(createApp()).post('/api/cameras/cam1/compositions').set('Cookie', as(email)).send({ eventId: EVENT, preS: 0, postS: 5, size: 'sd', badge: false });
  const del = (email: string, job: string) => request(createApp()).delete(`/api/cameras/cam1/compositions/${job}`).set('Cookie', as(email));
  afterEach(() => {
    restoreMode();
  });

  it('only the viewer who started a job, or an account admin, cancels it; the other viewers still poll it', async () => {
    useAccount();
    const { body } = await start('starter@example.org');
    expect((await del('other@example.org', body.id)).status).toBe(403);
    expect(fake.compositions.has(body.id)).toBe(true);
    expect((await request(createApp()).get(`/api/cameras/cam1/compositions/${body.id}`).set('Cookie', as('other@example.org'))).status).toBe(200);
    expect((await del('starter@example.org', body.id)).status).toBe(204);
    const second = (await start('starter@example.org')).body;
    expect((await del('boss@example.org', second.id)).status).toBe(204);
    expect(fake.compositions.has(second.id)).toBe(false);
  });

  it('a 201 from the proxy that is not JSON: 502 with a clear error, not a 500', async () => {
    vi.spyOn(getProxyClient(k('den'))!, 'open').mockResolvedValue(new Response('{"id": "abc', { status: 201 }));
    const r = await post('den', { eventId: EVENT, preS: 0, postS: 5, size: 'sd', badge: false });
    expect([r.status, r.body]).toEqual([502, { error: 'proxy_unavailable', detail: 'the proxy started a job but its answer is unreadable' }]);
  });

  it('the same around a second', async () => {
    vi.spyOn(getProxyClient(k('den'))!, 'open').mockResolvedValue(new Response('not json', { status: 201 }));
    const r = await post('den', { at: Math.floor(Date.now() / 1000) * 1000 - 60_000, preS: 1, postS: 1, size: 'sd', badge: false });
    expect([r.status, r.body]).toEqual([502, { error: 'proxy_unavailable', detail: 'the proxy started a job but its answer is unreadable' }]);
  });

  it('a 201 whose job id is readable is remembered, even when the rest is odd', async () => {
    const id = 'J'.repeat(22);
    const open = vi.spyOn(getProxyClient(k('den'))!, 'open').mockResolvedValueOnce(new Response(JSON.stringify({ id, state: 42 }), { status: 201 }));
    expect((await post('den', { eventId: EVENT, preS: 0, postS: 5, size: 'sd', badge: false })).status).toBe(201);
    open.mockResolvedValueOnce(new Response(JSON.stringify({ id, state: 'running' }), { status: 200 }));
    expect((await request(createApp()).get(`/api/cameras/den/compositions/${id}`).set('Cookie', auth)).status).toBe(200);
  });

  it('checks every field of an event composition, as around a second', async () => {
    const before = fake.composeRequests.length;
    const good = { eventId: EVENT, preS: 0, postS: 5, size: 'sd', badge: false };
    for (const [bad, detail] of [
      [{ preS: undefined }, /Whole seconds/],
      [{ postS: '5' }, /Whole seconds/],
      [{ preS: 1.5 }, /Whole seconds/],
      [{ size: undefined }, /size/],
      [{ size: '4k' }, /size/],
      [{ badge: 'yes' }, /badge/],
      [{ badge: undefined }, /badge/],
      [{ timeZone: 5 }, /timeZone/],
    ] as const) {
      const r = await post('den', { ...good, ...bad });
      expect([r.status, r.body.error]).toEqual([400, 'invalid']);
      expect(r.body.detail).toMatch(detail);
    }
    expect(fake.composeRequests.length).toBe(before);
    expect((await post('den', good)).status).toBe(201);
  });
});
