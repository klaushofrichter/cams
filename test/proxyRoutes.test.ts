import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../server/app';
import { setCameras } from '../server/cameraRegistry';
import { resetProxyClients } from '../server/proxy/client';
import { SESSION_COOKIE, signSession } from '../server/session';
import { FAKE_TOKEN, JPEG, startFakeProxy, type FakeProxy } from './proxy/fakeProxy';

const auth = `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`;
const M = Date.UTC(2026, 8, 27, 19, 3); // a minute
let fake: FakeProxy;

beforeEach(async () => {
  fake = await startFakeProxy();
  // cams calls it "den"; the proxy knows it as "cam1".
  setCameras([
    { id: 'den', name: 'Den', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p', proxy: { url: fake.url, token: FAKE_TOKEN, camera: 'cam1' } },
    { id: 'shed', name: 'Shed', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p' },
  ]);
  resetProxyClients();
  fake.previews.set('cam1', new Map([[M, JPEG]]));
  fake.stills.set('cam1', new Map([[M + 1000, JPEG], [M + 2000, JPEG]]));
});
afterEach(async () => {
  await fake.stop();
  setCameras([]);
});

const get = (path: string) => request(createApp()).get(path).set('Cookie', auth);

describe('proxy media routes', () => {
  it('need a signed-in user', async () => {
    expect((await request(createApp()).get(`/api/cameras/den/stills?from=${M}&to=${M + 60_000}`)).status).toBe(401);
  });

  it('list previews with cams’ own URLs, and stills', async () => {
    const p = await get(`/api/cameras/den/previews?from=${M}&to=${M + 60_000}`);
    expect(p.status).toBe(200);
    expect(p.body).toEqual([expect.objectContaining({ minute: M, cols: 10, rows: 6, tileW: 160, tileH: 90, url: `/api/cameras/den/previews/${M}.jpg` })]);
    expect(JSON.stringify(p.body)).not.toContain(fake.url);
    const s = await get(`/api/cameras/den/stills?from=${M}&to=${M + 60_000}`);
    expect(s.body).toEqual([M + 1000, M + 2000]);
    expect(fake.requests.at(-1)?.path).toBe('/api/cameras/cam1/stills'); // the proxy's name for it
  });

  it('stream the images', async () => {
    for (const path of [`/api/cameras/den/previews/${M}.jpg`, `/api/cameras/den/stills/${M + 1000}.jpg`]) {
      const r = await get(path).buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toBe('image/jpeg');
      expect(r.headers['cache-control']).toMatch(/immutable/);
      expect(Buffer.compare(r.body, JPEG)).toBe(0);
    }
    expect((await get(`/api/cameras/den/stills/${M + 9000}.jpg`)).status).toBe(404);
  });

  it('check their parameters', async () => {
    expect((await get('/api/cameras/den/stills')).status).toBe(400);
    expect((await get(`/api/cameras/den/stills?from=${M}&to=${M - 1}`)).status).toBe(400);
    expect((await get(`/api/cameras/den/stills?from=${M}&to=${M + 86_400_001}`)).status).toBe(400);
    expect((await get('/api/cameras/den/stills/abc.jpg')).status).toBe(400);
    expect((await get('/api/cameras/den/previews/..%2f..%2fx.jpg')).status).toBe(400);
  });

  it('answer no_proxy for a camera without one, and unknown_camera', async () => {
    expect((await get(`/api/cameras/shed/stills?from=${M}&to=${M}`)).body).toEqual({ error: 'no_proxy' });
    expect((await get(`/api/cameras/nope/stills?from=${M}&to=${M}`)).status).toBe(404);
  });

  it('answer 502 proxy_unavailable while the proxy is down, without details', async () => {
    fake.offline = true;
    const r = await get(`/api/cameras/den/stills?from=${M}&to=${M}`);
    expect(r.status).toBe(502);
    expect(r.body).toEqual({ error: 'proxy_unavailable' });
  });
});
