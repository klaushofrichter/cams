// test/proxyGroups.test.ts
// Proxy groups (cam-proxy spec 2026-10-05 §12.1): the entries with the same
// proxy url + token are one proxy, with one client, one stream and one
// Archive entry.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../server/logger';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadCameras, setCameras, type CameraConfig } from '../server/cameraRegistry';
import { getProxyClient, proxyClientFor, resetProxyClients } from '../server/proxy/client';
import { activeMembers, groupOf, proxyGroups, remoteIds } from '../server/proxy/groups';
import { archiveProxies } from '../server/proxy/archive';
import { loadProxyState, setProxyEnabled } from '../server/proxyState';

const T = 'a'.repeat(40), T2 = 'b'.repeat(40), ADMIN = 'c'.repeat(40);
const cam = (id: string, proxy?: CameraConfig['proxy']): CameraConfig => ({ id, name: id, host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p', ...(proxy && { proxy }) });
const file = (body: unknown) => {
  const f = join(mkdtempSync(join(tmpdir(), 'cams-groups-')), 'cameras.json');
  writeFileSync(f, JSON.stringify(body));
  return f;
};

beforeEach(() => {
  process.env.PROXY_STATE_FILE = join(mkdtempSync(join(tmpdir(), 'cams-groups-state-')), 'proxy-state.json');
  loadProxyState();
  resetProxyClients();
});
afterEach(() => {
  setCameras([]);
  delete process.env.PROXY_STATE_FILE;
  loadProxyState();
});

describe('proxy groups', () => {
  it('groups entries by url and token, in config order', () => {
    setCameras([
      cam('den', { url: 'http://a:8480', token: T, camera: 'cam1' }),
      cam('shed'),
      cam('cam2', { url: 'http://b:8480', token: T }),
      cam('barn', { url: 'http://a:8480/', token: T }),
      cam('gate', { url: 'http://a:8480', token: T2 }),
    ]);
    const gs = proxyGroups();
    expect(gs.map((g) => g.members)).toEqual([['den', 'barn'], ['cam2'], ['gate']]);
    expect(groupOf('barn')).toBe(gs[0]);
    expect([...gs[0].remoteOf]).toEqual([['den', 'cam1'], ['barn', 'barn']]);
    expect(remoteIds(gs[0])).toEqual(['barn', 'cam1']);
    expect(groupOf('shed')).toBeUndefined();
  });

  it('has one client per proxy, and none for a switched-off camera', async () => {
    setCameras([cam('den', { url: 'http://a:8480', token: T, camera: 'cam1' }), cam('barn', { url: 'http://a:8480', token: T })]);
    expect(getProxyClient('den')).toBe(getProxyClient('barn'));
    await setProxyEnabled('barn', false);
    expect(getProxyClient('barn')).toBeUndefined();
    expect(proxyClientFor('barn')).toBe(getProxyClient('den'));
    expect(activeMembers(groupOf('den')!)).toEqual(['den']);
  });

  it('builds the Archive proxies from the same group objects (spec §12.4)', async () => {
    setCameras([cam('den', { url: 'http://a:8480', token: T, camera: 'cam1' }), cam('barn', { url: 'http://a:8480', token: T }), cam('cam2', { url: 'http://b:8480', token: T, camera: 'cam1' })]);
    const ps = archiveProxies();
    expect(ps.map((p) => [p.via, p.cams])).toEqual([['den', ['den', 'barn']], ['cam2', ['cam2']]]);
    expect(ps[0].group).toBe(groupOf('den'));
    expect([...ps[0].toCams]).toEqual([['cam1', 'den'], ['barn', 'barn']]);
    await setProxyEnabled('den', false);
    expect(archiveProxies()[0].via).toBe('barn'); // as today: the first camera that uses it
  });
});

describe('registry checks for a group', () => {
  const p = { url: 'http://a:8480', token: T };
  const entry = (id: string, proxy: object) => ({ id, name: id, host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p', proxy });

  it('accepts an adminToken on only some entries (e2e/cameras.json: cam1 and barn)', () => {
    expect(loadCameras(file([entry('den', { ...p, adminToken: ADMIN }), entry('barn', p)]))).toHaveLength(2);
    expect(() => loadCameras('e2e/cameras.json')).not.toThrow();
  });

  it('refuses two different adminTokens for one proxy, naming both entries', () => {
    expect(() => loadCameras(file([entry('den', { ...p, adminToken: ADMIN }), entry('x', { url: 'http://b:1', token: T }), entry('barn', { ...p, adminToken: 'd'.repeat(40) })]))).toThrow(
      'camera registry entries 0 ("den") and 2 ("barn"): same cam-proxy (url and token) but different adminToken',
    );
  });

  it('keeps a proxy pin and TLS name, refusing a group that disagrees on them (spec §12.1)', () => {
    const pin = { ...p, url: 'https://192.168.1.230:8443', caFingerprint: `SHA256:${'ab'.repeat(32)}`, tlsServername: 'proxy.garage.internal' };
    const [c] = loadCameras(file([entry('den', pin)]));
    expect(c.proxy).toEqual({ url: pin.url, token: T, caFingerprint: ['ab'.repeat(32)], tlsServername: 'proxy.garage.internal' });
    expect(() => loadCameras(file([entry('den', pin), entry('barn', { ...pin, caFingerprint: 'cd'.repeat(32) })]))).toThrow(
      'camera registry entries 0 ("den") and 1 ("barn"): same cam-proxy (url and token) but different caFingerprint',
    );
    expect(() => loadCameras(file([entry('den', pin), entry('barn', { ...pin, tlsServername: undefined })]))).toThrow(
      'camera registry entries 0 ("den") and 1 ("barn"): same cam-proxy (url and token) but different tlsServername',
    );
  });

  it('refuses a pin on a LAN http proxy URL, and a proxy TLS name without https', () => {
    const pin = `SHA256:${'ab'.repeat(32)}`;
    expect(() => loadCameras(file([entry('den', { url: 'http://192.168.1.230:8480', token: T, caFingerprint: pin })]))).toThrow('camera registry entry 0: proxy caFingerprint needs an https url (or a loopback http one)');
    expect(loadCameras(file([entry('den', { url: 'http://127.0.0.1:8480', token: T, caFingerprint: pin })]))[0].proxy?.caFingerprint).toEqual(['ab'.repeat(32)]);
    expect(() => loadCameras(file([entry('den', { url: 'http://127.0.0.1:8480', token: T, tlsServername: 'proxy.x.internal' })]))).toThrow('camera registry entry 0: proxy tlsServername needs an https url');
    expect(() => loadCameras(file([entry('den', { url: 'https://a:8443', token: T, caFingerprint: 'abc' })]))).toThrow('camera registry entry 0: proxy caFingerprint must be a SHA-256 fingerprint or a list of them');
  });

  it('warns that a pin isn’t enforced yet (P5)', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      loadCameras(file([entry('den', { url: 'https://192.168.1.230:8443', token: T, caFingerprint: 'ab'.repeat(32) })]));
      expect(warn).toHaveBeenCalledWith({ cameras: ['den'] }, 'proxy_pin_not_enforced');
    } finally {
      warn.mockRestore();
    }
  });

  it('loads the Pi’s one-camera shape unchanged', () => {
    const pi = { id: 'cam1', name: 'Den', host: 'from-proxy', protocol: 'https', tlsServername: 'cam1.skylar.technology', user: 'cams', password: 'pw', proxy: { url: 'http://127.0.0.1:8480', token: T, adminToken: ADMIN } };
    const [c] = loadCameras(file([pi]));
    expect(c).toEqual({ ...pi });
  });
});
