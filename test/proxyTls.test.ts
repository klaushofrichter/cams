// cams → a site-CA cam-proxy over HTTPS (cam-proxy spec 2026-10-05 §10.1.4,
// §12.3): the CA from /tls/ca.pem against the pin, then that CA only, the
// proxy's certificate checked against its TLS name.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { createApp } from '../server/app';
import { setCameras, type CameraConfig } from '../server/cameraRegistry';
import { resetProxyClients } from '../server/proxy/client';
import { proxyHub, proxyStates, startProxyStreams, stopProxyStreams } from '../server/proxy/stream';
import { loadProxyState } from '../server/proxyState';
import { SESSION_COOKIE, signSession } from '../server/session';
import { certFingerprint } from '../server/tls/fingerprint';
import { loadTlsState, verifiedCas } from '../server/tls/store';
import { FAKE_ADMIN_TOKEN, FAKE_TOKEN, startFakeProxy, type FakeProxy } from './proxy/fakeProxy';

const fx = (n: string) => readFileSync(join(__dirname, 'fixtures/site-ca', n), 'utf8');
const A = certFingerprint(fx('ca-a.pem')), B = certFingerprint(fx('ca-b.pem'));
const auth = `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`;
const OPTS = { backoffMinMs: 50, backoffMaxMs: 300, healthyMs: 200 };
let fake: FakeProxy | undefined;

async function siteProxy(leaf: 'proxy-a' | 'proxy-b' = 'proxy-a', port?: number): Promise<FakeProxy> {
  fake = await startFakeProxy({ port, tls: { key: fx(`${leaf}.key`), cert: fx(`${leaf}.pem`) } });
  fake.caPem = fx(leaf === 'proxy-a' ? 'ca-a.pem' : 'ca-b.pem');
  return fake;
}
const cams = (url: string, pins: string[], more: Partial<NonNullable<CameraConfig['proxy']>> = {}): void => {
  setCameras([{ id: 'den', name: 'Den', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p', proxy: { url, token: FAKE_TOKEN, camera: 'cam1', tlsServername: 'proxy.test.internal', caFingerprint: pins, ...more } }]);
  resetProxyClients();
};
const paths = () => fake!.requests.map((r) => r.path);

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'cams-ptls-'));
  process.env.PROXY_TLS_FILE = join(dir, 'proxy-tls.json');
  process.env.PROXY_STATE_FILE = join(dir, 'proxy-state.json');
  loadTlsState();
  loadProxyState();
});
afterEach(async () => {
  stopProxyStreams();
  await fake?.stop();
  fake = undefined;
  setCameras([]);
  delete process.env.PROXY_TLS_FILE;
  delete process.env.PROXY_STATE_FILE;
  loadProxyState();
});

describe('a site-CA proxy over HTTPS', () => {
  it('fetches the CA once, then streams over TLS that trusts only it', async () => {
    const f = await siteProxy();
    cams(f.url, [A]);
    const got: { cam: string }[] = [];
    const on = (m: { cam: string }) => got.push(m);
    proxyHub.on('message', on);
    try {
      startProxyStreams(OPTS);
      await expect.poll(() => proxyStates()[0]?.up).toBe(true);
      f.push({ cam: 'cam1', type: 'clip', data: { clipId: 1 } });
      await expect.poll(() => got.length).toBe(1);
      expect(paths().filter((p) => p === '/tls/ca.pem')).toHaveLength(1);
      expect(verifiedCas([A])).toEqual([fx('ca-a.pem')]);
    } finally {
      proxyHub.off('message', on);
    }
  });

  it('never sends the token past a wrong pin', async () => {
    const f = await siteProxy();
    cams(f.url, [B]);
    startProxyStreams(OPTS);
    await new Promise((r) => setTimeout(r, 400));
    expect(proxyStates()[0]?.up).toBe(false);
    expect(new Set(paths())).toEqual(new Set(['/tls/ca.pem']));
    expect(f.requests.every((r) => r.auth === undefined)).toBe(true);
  });

  it('refuses the proxy’s certificate under another name', async () => {
    const f = await siteProxy();
    cams(f.url, [A], { tlsServername: 'cam3.test.internal' });
    startProxyStreams(OPTS);
    await new Promise((r) => setTimeout(r, 400));
    expect(proxyStates()[0]?.up).toBe(false);
    expect(paths().includes('/api/stream')).toBe(false); // the TLS handshake failed before any request
  });

  it('follows a CA rotation within the pinned list', async () => {
    const f = await siteProxy('proxy-a');
    const port = Number(new URL(f.url).port);
    cams(f.url, [A, B]);
    startProxyStreams(OPTS);
    await expect.poll(() => proxyStates()[0]?.up).toBe(true);
    await f.stop();
    await expect.poll(() => proxyStates()[0]?.up).toBe(false); // it noticed
    await siteProxy('proxy-b', port); // same address, new CA
    await expect.poll(() => proxyStates()[0]?.up, { timeout: 5000 }).toBe(true);
    expect(verifiedCas([A, B])).toHaveLength(2);
  });

  it('answers proxy info and mints a login link over the pinned channel', async () => {
    const f = await siteProxy();
    f.publicUrl = 'https://192.168.1.230:8443';
    setCameras([{ id: 'den', name: 'Den', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p', proxy: { url: f.url, token: FAKE_TOKEN, adminToken: FAKE_ADMIN_TOKEN, camera: 'cam1', tlsServername: 'proxy.test.internal', caFingerprint: [A] } }]);
    resetProxyClients();
    const info = await request(createApp()).get('/api/cameras/den/proxy/info').set('Cookie', auth);
    expect(info.body).toEqual({ reachable: true, webUrl: 'https://192.168.1.230:8443' });
    const link = await request(createApp()).post('/api/cameras/den/proxy/login-link').set('Cookie', auth).send();
    expect(link.status).toBe(200);
    expect(link.body.url).toMatch(/^https:\/\/192\.168\.1\.230:8443\/control\/login-link\?code=fake-code-1$/);
  });

  it('keeps plain http without a pin (the Pi), never asking for /tls/ca.pem', async () => {
    fake = await startFakeProxy();
    setCameras([{ id: 'cam1', name: 'Den', host: 'from-proxy', protocol: 'https', tlsServername: 'cam1.skylar.technology', user: 'u', password: 'p', proxy: { url: fake.url, token: FAKE_TOKEN } }]);
    resetProxyClients();
    startProxyStreams(OPTS);
    await expect.poll(() => proxyStates()[0]?.up).toBe(true);
    expect(paths().includes('/tls/ca.pem')).toBe(false);
  });
});
