// The proxy's JSON is checked before it reaches the browser (code review
// 2026-11-09, items 9 and 10): a malformed list is a 502, never a 500 or a
// pass-through, and preview entries carry only the fields the page uses.
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import request from 'supertest';
import { createApp } from '../server/app';
import { setCameras } from '../server/cameraRegistry';
import { resetProxyClients } from '../server/proxy/client';
import { SESSION_COOKIE, signSession } from '../server/session';

const auth = `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`;
const TOKEN = 'answers-proxy-client-token-'.padEnd(48, 'q');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
  setCameras([]);
  resetProxyClients();
});

// A stand-in proxy: `list` answers the JSON routes, any .jpg is a picture.
async function useProxy(list: unknown) {
  const app = express();
  app.use((req, res) => (req.path.endsWith('.jpg') ? void res.type('image/jpeg').send(JPEG) : void res.json(list)));
  server = app.listen(0);
  await new Promise((r) => server!.once('listening', r));
  const url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  setCameras([{ id: 'den', name: 'Den', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p', proxy: { url, token: TOKEN } }]);
  resetProxyClients();
}
const get = (path: string) => request(createApp()).get(path).set('Cookie', auth);
const now = Date.now();

describe('still/latest.jpg', () => {
  for (const [what, body] of [['an object', { stills: [1] }], ['null', null], ['a string', 'x']] as const) {
    it(`a list that is ${what}: 502, not 500`, async () => {
      await useProxy(body);
      const r = await get('/api/cameras/den/still/latest.jpg');
      expect([r.status, r.body]).toEqual([502, { error: 'proxy_unavailable' }]);
    });
  }
  it('no usable time in the list: 404', async () => {
    await useProxy(['x', null, -5, 1.5]);
    expect((await get('/api/cameras/den/still/latest.jpg')).status).toBe(404);
  });
  it('the newest usable time', async () => {
    const t = now - 5000;
    await useProxy([t - 1000, t, 'x']);
    const r = await get('/api/cameras/den/still/latest.jpg');
    expect(r.status).toBe(200);
    expect(r.headers['x-still-time']).toBe(String(t));
  });
});

describe('stills', () => {
  it('passes only whole non-negative times', async () => {
    await useProxy([1000, 'x', { a: 1 }, -1, 2.5, 3000]);
    const r = await get(`/api/cameras/den/stills?from=${now - 60_000}&to=${now}`);
    expect([r.status, r.body]).toEqual([200, [1000, 3000]]);
  });
  it('a list that is not a list: 502', async () => {
    await useProxy({ evil: '<script>' });
    const r = await get(`/api/cameras/den/stills?from=${now - 60_000}&to=${now}`);
    expect([r.status, r.body]).toEqual([502, { error: 'proxy_unavailable' }]);
  });
});

describe('previews', () => {
  const minute = 1_790_000_040_000 - (1_790_000_040_000 % 60_000);
  const good = { minute, cols: 10, rows: 6, tileW: 160, tileH: 90, intervalS: 1, present: [true, false, true] };
  it('builds each entry field by field: nothing else from the proxy reaches the browser', async () => {
    await useProxy([{ ...good, url: 'https://elsewhere.example/x.jpg', token: 'secret', path: '/data/x' }]);
    const r = await get(`/api/cameras/den/previews?from=${minute}&to=${minute + 60_000}`);
    expect(r.body).toEqual([{ ...good, url: `/api/cameras/den/previews/${minute}.jpg?n=2` }]);
  });
  it('drops entries with missing or malformed layout fields', async () => {
    await useProxy([good, { ...good, minute: minute + 60_000, cols: 'ten' }, { ...good, minute: minute + 120_000, present: 'all' }, { ...good, minute: minute + 180_000, tileW: -1 }, { ...good, minute: minute + 240_000, intervalS: null }]);
    const r = await get(`/api/cameras/den/previews?from=${minute}&to=${minute + 300_000}`);
    expect(r.body.map((m: { minute: number }) => m.minute)).toEqual([minute]);
  });
  it('a present list with non-booleans counts only true as present', async () => {
    await useProxy([{ ...good, present: [true, 1, 'yes', null] }]);
    const r = await get(`/api/cameras/den/previews?from=${minute}&to=${minute + 60_000}`);
    expect(r.body[0].present).toEqual([true, false, false, false]);
  });
});
