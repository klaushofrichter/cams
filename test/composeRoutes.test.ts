// The compositions pass-through (cam-proxy spec 2026-09-28): the Downloads
// modal's calls go to the camera's cam-proxy with its token.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../server/app';
import { setCameras } from '../server/cameraRegistry';
import { resetProxyClients } from '../server/proxy/client';
import { getRecordings } from '../server/recordings/service';
import { SESSION_COOKIE, signSession } from '../server/session';
import { FAKE_TOKEN, startFakeProxy, type FakeProxy } from './proxy/fakeProxy';

const auth = `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`;
const EVENT = '20260928-140000-140020';
let fake: FakeProxy;

beforeEach(async () => {
  fake = await startFakeProxy();
  setCameras([
    { id: 'den', name: 'Den', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p', proxy: { url: fake.url, token: FAKE_TOKEN, camera: 'cam1' } },
    { id: 'shed', name: 'Shed', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p' },
  ]);
  resetProxyClients();
  // The event → proxy clip lookup has its own tests (the recordings service).
  vi.spyOn(getRecordings(), 'proxyClipOf').mockImplementation(async (_cam, id) => (id === EVENT ? { id: 7 } : null));
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
    expect(fake.composeRequests.at(-1)).toEqual({ clipId: 7, preS: 5, postS: 10, size: 'sd', badge: true });
    await post('den', { eventId: EVENT, preS: 0, postS: 5, size: 'sd', badge: false, timeZone: 'America/Chicago' });
    expect(fake.composeRequests.at(-1)).toMatchObject({ timeZone: 'America/Chicago' }); // the cards' clock (final review I5)
    expect(fake.requests.at(-1)?.auth).toBe(`Bearer ${FAKE_TOKEN}`);
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
});
