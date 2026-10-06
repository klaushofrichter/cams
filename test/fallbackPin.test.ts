// test/fallbackPin.test.ts
// A camera that refused the site certificate (cam-proxy spec 2026-10-05
// §10.1.4): its proxy reports the served fingerprint in /api/cameras
// (tls.mode "pinned"), and cams pins it, over the verified channel only.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getCamera, setCameras } from '../server/cameraRegistry';
import { resetProxyClients } from '../server/proxy/client';
import { setListRefreshMs } from '../server/proxy/names';
import { proxyStates, startProxyStreams, stopProxyStreams } from '../server/proxy/stream';
import { loadProxyState } from '../server/proxyState';
import { cameraTrust } from '../server/tls/cameraTrust';
import { certFingerprint, formatFingerprint } from '../server/tls/fingerprint';
import { fallbackPin, loadTlsState } from '../server/tls/store';
import { FAKE_TOKEN, startFakeProxy, type FakeProxy } from './proxy/fakeProxy';

const fx = (n: string) => readFileSync(join(__dirname, 'fixtures/site-ca', n), 'utf8');
const A = certFingerprint(fx('ca-a.pem')), LEAF = certFingerprint(fx('selfsigned.pem'));
const OPTS = { backoffMinMs: 50, backoffMaxMs: 300, healthyMs: 200 };
let f: FakeProxy;

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cams-fpin-'));
  process.env.PROXY_TLS_FILE = join(dir, 'proxy-tls.json');
  process.env.PROXY_STATE_FILE = join(dir, 'proxy-state.json');
  loadTlsState();
  loadProxyState();
  f = await startFakeProxy({ tls: { key: fx('proxy-a.key'), cert: fx('proxy-a.pem') } });
  f.caPem = fx('ca-a.pem');
  f.cameraNames.set('cam5', 'Shed');
  f.cameraTls.set('cam5', { mode: 'pinned', servername: null, fingerprint: formatFingerprint(LEAF), notAfter: null, lastPush: { at: 1, outcome: 'refused' } });
  f.cameraTls.set('cam1', { mode: 'site-ca', servername: 'cam3.test.internal', fingerprint: 'ee'.repeat(32), notAfter: 2, lastPush: null });
});
afterEach(async () => {
  stopProxyStreams();
  setListRefreshMs();
  await f.stop();
  setCameras([]);
  delete process.env.PROXY_TLS_FILE;
  delete process.env.PROXY_STATE_FILE;
  loadProxyState();
});

const cams = (pins: string[] | undefined, url = f.url) => {
  const proxy = (camera: string) => ({ url, token: FAKE_TOKEN, camera, ...(pins && { tlsServername: 'proxy.test.internal', caFingerprint: pins }) });
  setCameras([
    { id: 'den', name: 'Den', host: 'from-proxy', protocol: 'https', tlsServername: 'cam3.test.internal', user: 'u', password: 'p', proxy: proxy('cam1') },
    { id: 'shed', name: 'Shed', host: 'from-proxy', protocol: 'https', ...(pins ? {} : { tlsServername: 'x.test.internal' }), user: 'u', password: 'p', proxy: proxy('cam5') },
  ]);
  resetProxyClients();
};

describe('fallback pins', () => {
  it('pins what the proxy reports for a camera that refused the import, and keeps it', async () => {
    cams([A]);
    startProxyStreams(OPTS);
    await expect.poll(() => fallbackPin('shed')).toBe(LEAF);
    expect(cameraTrust(getCamera('shed')!)).toEqual({ kind: 'pinned', fingerprint: LEAF });
    expect(fallbackPin('den')).toBeUndefined();
    loadTlsState(); // a restart
    expect(fallbackPin('shed')).toBe(LEAF);
  });

  it('clears the pin when the proxy reports the camera on the site CA again', async () => {
    cams([A]);
    startProxyStreams(OPTS);
    await expect.poll(() => fallbackPin('shed')).toBe(LEAF);
    stopProxyStreams();
    resetProxyClients(); // a fresh client: the camera list isn't served from the last 2 s
    f.cameraTls.set('cam5', { mode: 'site-ca', servername: 'cam5.test.internal', fingerprint: 'ff'.repeat(32), notAfter: 3, lastPush: { at: 2, outcome: 'pushed' } });
    startProxyStreams(OPTS);
    await expect.poll(() => fallbackPin('shed')).toBeUndefined();
  });

  it('re-reads the list while the stream stays up', async () => {
    setListRefreshMs(200);
    f.cameraTls.delete('cam5');
    cams([A]);
    startProxyStreams(OPTS);
    await expect.poll(() => proxyStates().every((s) => s.up)).toBe(true);
    f.cameraTls.set('cam5', { mode: 'pinned', servername: null, fingerprint: LEAF, notAfter: null, lastPush: null });
    await expect.poll(() => fallbackPin('shed'), { timeout: 5000 }).toBe(LEAF); // the list is shared for 2 s, so the first re-read after that sees it
  });

  it('ignores a tls block from a proxy without a pin', async () => {
    const plain = await startFakeProxy();
    plain.cameraNames.set('cam5', 'Shed');
    plain.cameraTls.set('cam5', { mode: 'pinned', fingerprint: LEAF });
    try {
      cams(undefined, plain.url);
      startProxyStreams(OPTS);
      await expect.poll(() => proxyStates().every((s) => s.up)).toBe(true);
      await new Promise((r) => setTimeout(r, 200));
      expect(fallbackPin('shed')).toBeUndefined();
    } finally {
      stopProxyStreams();
      await plain.stop();
    }
  });
});
