// test/siteCaEndToEnd.test.ts
// The whole site-CA path in one process (cam-proxy spec 2026-10-05 §13.3,
// §12.3): the generator pins the proxy, writes cameras.json, cams loads it,
// streams from the proxy over HTTPS and reaches the camera over its site
// certificate; a second camera on the leaf-pin fallback.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { cameraHost, loadCameras, setCameras } from '../server/cameraRegistry';
import { runCamerasConfig } from '../server/cameraImport';
import { resetProxyClients } from '../server/proxy/client';
import '../server/proxy/names'; // its stream listeners (the app loads it through its routes)
import { proxyStates, startProxyStreams, stopProxyStreams } from '../server/proxy/stream';
import { loadProxyState } from '../server/proxyState';
import { getClient, resetClients } from '../server/reolink/clients';
import { certFingerprint, formatFingerprint } from '../server/tls/fingerprint';
import { fallbackPin, loadTlsState } from '../server/tls/store';
import { startTlsCamera } from './helpers/tlsCamera';
import { FAKE_TOKEN, startFakeProxy, type FakeProxy } from './proxy/fakeProxy';

const fx = (n: string) => readFileSync(join(__dirname, 'fixtures/site-ca', n), 'utf8');
const reply = (cmd: string) => (cmd === 'Login' ? [{ cmd, code: 0, value: { Token: { name: 'tok', leaseTime: 3600 } } }] : [{ cmd, code: 0, value: { DevInfo: { model: 'RLC-1224A', firmVer: 'v3' } } }]);
const stops: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  stopProxyStreams();
  await Promise.all(stops.splice(0).map((s) => s()));
  setCameras([]);
  resetClients();
  delete process.env.PROXY_TLS_FILE;
  delete process.env.PROXY_STATE_FILE;
  loadProxyState();
});

describe('site CA end to end', () => {
  it('generator → cameras.json → stream over HTTPS → cameras by CA and by pin', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cams-e2e-tls-'));
    process.env.PROXY_TLS_FILE = join(dir, 'proxy-tls.json');
    process.env.PROXY_STATE_FILE = join(dir, 'proxy-state.json');
    loadTlsState();
    loadProxyState();
    const cam3 = await startTlsCamera('cam-a', reply);
    const cam5 = await startTlsCamera('selfsigned', reply);
    stops.push(cam3.stop, cam5.stop);
    const f: FakeProxy = await startFakeProxy({ tls: { key: fx('proxy-a.key'), cert: fx('proxy-a.pem') } });
    stops.push(() => f.stop());
    f.caPem = fx('ca-a.pem');
    f.cameraNames.clear();
    f.cameraNames.set('cam3', 'Driveway').set('cam5', 'Shed');
    f.cameraAddresses.set('cam3', cam3.host).set('cam5', cam5.host);
    f.cameraTls.set('cam3', { mode: 'site-ca', servername: 'cam3.test.internal', fingerprint: certFingerprint(fx('cam-a.pem')), notAfter: 1, lastPush: null });
    f.cameraTls.set('cam5', { mode: 'pinned', servername: null, fingerprint: formatFingerprint(certFingerprint(fx('selfsigned.pem'))), notAfter: null, lastPush: { at: 1, outcome: 'refused' } });
    writeFileSync(join(dir, 'cameras-config.json'), JSON.stringify({ proxies: [{ url: f.url, tlsServername: 'proxy.test.internal', caFingerprint: formatFingerprint(certFingerprint(fx('ca-a.pem'))), token: FAKE_TOKEN, cameraUser: 'cams', cameraPassword: 'pw', prefix: 'garage-' }] }), { mode: 0o600 });
    const out: string[] = [];
    expect(await runCamerasConfig(['--output', join(dir, 'cameras.json'), '--write'], {}, { out: (l) => out.push(l), err: (l) => out.push(l) })).toBe(0);

    setCameras(loadCameras(join(dir, 'cameras.json')));
    resetProxyClients();
    resetClients();
    startProxyStreams({ backoffMinMs: 50, backoffMaxMs: 300, healthyMs: 200 });
    await expect.poll(() => proxyStates()).toEqual([{ cam: 'garage-cam3', up: true }, { cam: 'garage-cam5', up: true }]);
    await expect.poll(() => fallbackPin('garage-cam5', cameraHost('garage-cam5'))).toBe(certFingerprint(fx('selfsigned.pem')));
    await expect.poll(() => [cameraHost('garage-cam3'), cameraHost('garage-cam5')]).toEqual([cam3.host, cam5.host]); // from-proxy addresses
    expect((await getClient('garage-cam3')!.status()).model).toBe('RLC-1224A');
    expect((await getClient('garage-cam5')!.status()).model).toBe('RLC-1224A');
    expect(f.streamConnections()).toBe(1);
  });
});
