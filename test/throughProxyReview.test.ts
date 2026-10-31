// Final review of cams through the proxy (feat/through-proxy): the camera's
// web link only from the proxy's address, no empty-password login, the trust
// relay's 429 and 400, the features file's place, the proxy time's cache.
import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../server/app';
import { getCamera, keyed, listCameras, setCameras, setReportedAddress } from '../server/cameraRegistry';
import { camKey, setFleet } from '../server/fleet';
import { CAMERA_CALLS, checkProxyFeaturesStore, noteProxyFeatures, proxyFeaturesFile } from '../server/proxy/features';
import { proxyTimeInfo } from '../server/proxy/cameraCalls';
import { ReolinkClient } from '../server/reolink/client';
import { getClient } from '../server/reolink/clients';
import { SESSION_COOKIE, signSession } from '../server/session';
import { fakeStatus, FAKE_TOKEN } from './proxy/fakeProxy';
import { startThroughProxy, type ThroughProxy } from './helpers/throughProxy';
import { ALPHA, ALPHA_REF, k } from './helpers/fleet';

const auth = `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`;
const FP = `SHA256:${'AB'.repeat(32)}`;
let t: ThroughProxy | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await t?.close();
  t = undefined;
});

describe('the camera\'s web link of a through-proxy camera', () => {
  it('comes from the proxy\'s address only, never from cams-admin\'s host or webUiUrl', async () => {
    t = await startThroughProxy();
    const cam = keyed(ALPHA, [{ id: 'cam1', name: 'Den', host: 'evil.example', protocol: 'https', user: 'u', password: '', webUiUrl: 'https://evil.example/login', proxy: { url: t.fake.url, token: FAKE_TOKEN, camera: 'cam1' } }]);
    setFleet([{ ...ALPHA_REF, users: null, cameras: cam }]);
    await noteProxyFeatures(ALPHA, t.fake.url, [{ features: [CAMERA_CALLS] }]);
    expect(listCameras(ALPHA)[0].webUiUrl).toBeNull();
    setReportedAddress(camKey(ALPHA, 'cam1'), '192.0.2.40');
    expect(listCameras(ALPHA)[0].webUiUrl).toBe('https://192.0.2.40/');
  });
});

describe('a cameras.json entry with a proxy and no password', () => {
  it('has no credentials, so no direct client, and a client refuses an empty password without a login', async () => {
    t = await startThroughProxy();
    setCameras([{ id: 'den', name: 'Den', host: t.simHost, protocol: 'http', user: 'u', password: '', proxy: { url: 'http://127.0.0.1:9', token: FAKE_TOKEN } }]);
    expect(getCamera(k('den'))?.credentials).toBe('missing');
    expect(getClient(k('den'))).toBeUndefined();
    expect(listCameras(getCamera(k('den'))!.accountId)[0].credentials).toBe('missing');
    const before = t.sim.loginAttempts;
    const c = new ReolinkClient({ id: 'x', name: 'x', host: t.simHost, protocol: 'http', user: 'u', password: '' });
    await expect(c.command('GetDevInfo')).rejects.toMatchObject({ code: 'camera_credentials_missing' });
    expect(t.sim.loginAttempts).toBe(before);
  });
});

describe('the trust relay', () => {
  it('relays the proxy\'s 429 with its wait, and its 400', async () => {
    t = await startThroughProxy();
    t.fake.cameraStatus.set('cam1', fakeStatus({ online: false, tls: { mode: 'none', served: FP, problem: 'untrusted' } }));
    t.fake.trustAnswer = { status: 429, body: { error: 'rate_limited' }, retryAfter: '42' };
    const r = await request(createApp()).post('/api/cameras/den/trust').set('Cookie', auth).send({ fingerprint: FP }).expect(429);
    expect(r.body).toEqual({ error: 'rate_limited', retryAfterS: 42 });
    expect(r.headers['retry-after']).toBe('42');
    t.fake.trustAnswer = { status: 400, body: { error: 'invalid' } };
    await request(createApp()).post('/api/cameras/den/trust').set('Cookie', auth).send({ fingerprint: FP }).expect(400, { error: 'invalid' });
  });
});

describe('the features file', () => {
  it('has no temp-folder fallback: without PREFS_FILE or PROXY_FEATURES_FILE, cams with proxied cameras refuses to start', () => {
    const prefs = process.env.PREFS_FILE;
    delete process.env.PREFS_FILE;
    delete process.env.PROXY_FEATURES_FILE;
    try {
      expect(proxyFeaturesFile()).toBeNull();
      setCameras([{ id: 'den', name: 'Den', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p' }]);
      expect(() => checkProxyFeaturesStore()).not.toThrow();
      setCameras([{ id: 'den', name: 'Den', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p', proxy: { url: 'http://127.0.0.1:9', token: FAKE_TOKEN } }]);
      expect(() => checkProxyFeaturesStore()).toThrow(/PROXY_FEATURES_FILE/);
    } finally {
      process.env.PREFS_FILE = prefs;
      setCameras([]);
    }
  });
});

describe('the proxy\'s time', () => {
  it('follows a new zone seen in the status, and is read again after 10 minutes', async () => {
    t = await startThroughProxy();
    expect((await proxyTimeInfo(k('den'))).stdOffsetMinutes).toBe(-360);
    t.fake.cameraStatus.set('cam1', fakeStatus({ time: { clockOffsetMs: 0, stdOffsetMinutes: 540, dstOffsetMinutes: 0, dstRule: null } }));
    await request(createApp()).get('/api/cameras/den/status').set('Cookie', auth).expect(200);
    expect((await proxyTimeInfo(k('den'))).stdOffsetMinutes).toBe(540);
    t.fake.cameraStatus.set('cam1', fakeStatus({ time: { clockOffsetMs: 0, stdOffsetMinutes: 60, dstOffsetMinutes: 0, dstRule: null } }));
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 11 * 60_000);
    expect((await proxyTimeInfo(k('den'))).stdOffsetMinutes).toBe(60);
  });
});
