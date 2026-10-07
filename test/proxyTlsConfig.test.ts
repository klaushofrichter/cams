// cameras.json for a site-CA cam-proxy (cam-proxy spec 2026-10-05 §12.1):
// proxy.caFingerprint (one or a list) and proxy.tlsServername.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadCameras, setCameras } from '../server/cameraRegistry';
import { logger } from '../server/logger';
import { groupOf } from '../server/proxy/groups';
import { k } from './helpers/fleet';

const T = 't'.repeat(40), A = 'aa'.repeat(32), B = 'bb'.repeat(32);
const file = (body: unknown) => {
  const f = join(mkdtempSync(join(tmpdir(), 'cams-tlscfg-')), 'cameras.json');
  writeFileSync(f, JSON.stringify(body));
  return f;
};
const proxy = { url: 'https://192.168.1.230:8443', token: T, tlsServername: 'proxy.garage.internal', caFingerprint: `SHA256:${A.toUpperCase().match(/../g)!.join(':')}` };
const entry = (id: string, p: object = proxy, more: object = {}) => ({ id, name: id, host: 'from-proxy', protocol: 'https', tlsServername: `${id}.garage.internal`, user: 'cams', password: 'pw', proxy: { ...p, camera: id }, ...more });
afterEach(() => setCameras([]));

describe('site-CA proxy fields', () => {
  it('normalizes the pin to a list and keeps the TLS name', () => {
    const [c] = loadCameras(file([entry('cam3')]));
    expect(c.proxy).toEqual({ url: 'https://192.168.1.230:8443', token: T, camera: 'cam3', tlsServername: 'proxy.garage.internal', caFingerprint: [A] });
  });

  it('takes a rotation list', () => {
    expect(loadCameras(file([entry('cam3', { ...proxy, caFingerprint: [A, `sha256:${B}`] })]))[0].proxy?.caFingerprint).toEqual([A, B]);
  });

  it('puts pins and name on the group', () => {
    setCameras(loadCameras(file([entry('cam3'), entry('cam4')])));
    expect(groupOf(k('cam4'))).toMatchObject({ members: [k('cam3'), k('cam4')], pins: [A], tlsServername: 'proxy.garage.internal' });
  });

  it('a group without a site CA has no pins and no name', () => {
    setCameras(loadCameras(file([{ id: 'cam1', name: 'Den', host: 'from-proxy', protocol: 'https', tlsServername: 'cam1.skylar.technology', user: 'u', password: 'p', proxy: { url: 'http://127.0.0.1:8480', token: T } }])));
    expect(groupOf(k('cam1'))).toMatchObject({ pins: null, tlsServername: null });
  });

  it('refuses a bad pin, a bad name, a name on http and a pin on a LAN http URL', () => {
    expect(() => loadCameras(file([entry('cam3', { ...proxy, caFingerprint: 'nope' })]))).toThrow('camera registry entry 0: proxy caFingerprint must be a SHA-256 fingerprint or a list of them');
    expect(() => loadCameras(file([entry('cam3', { ...proxy, tlsServername: 'has space' })]))).toThrow('camera registry entry 0: proxy tlsServername must be a host name');
    expect(() => loadCameras(file([entry('cam3', { url: 'http://192.168.1.230:8480', token: T, tlsServername: 'proxy.garage.internal' })]))).toThrow('camera registry entry 0: proxy tlsServername needs an https url');
    expect(() => loadCameras(file([entry('cam3', { url: 'http://192.168.1.230:8480', token: T, caFingerprint: A })]))).toThrow('camera registry entry 0: proxy caFingerprint needs an https url (or a loopback http one)');
  });

  it('accepts a pin on the proxy’s own host over http (cams next to the proxy, spec §12.3)', () => {
    expect(loadCameras(file([entry('cam3', { url: 'http://127.0.0.1:8480', token: T, caFingerprint: A })]))[0].proxy?.caFingerprint).toEqual([A]);
  });

  it('refuses one proxy with two pins or two names, naming both entries', () => {
    expect(() => loadCameras(file([entry('cam3'), entry('cam4', { ...proxy, caFingerprint: B })]))).toThrow('camera registry entries 0 ("cam3") and 1 ("cam4"): same cam-proxy (url and token) but different caFingerprint');
    expect(() => loadCameras(file([entry('cam3'), entry('cam4', { ...proxy, tlsServername: 'other.garage.internal' })]))).toThrow('camera registry entries 0 ("cam3") and 1 ("cam4"): same cam-proxy (url and token) but different tlsServername');
    const { caFingerprint: _c, ...noPin } = proxy;
    expect(() => loadCameras(file([entry('cam3'), entry('cam4', noPin)]))).toThrow('different caFingerprint');
  });

  it('lets a from-proxy camera of a pinned proxy go without a TLS name (the leaf-pin fallback)', () => {
    const { tlsServername: _n, ...noName } = entry('cam5');
    expect(loadCameras(file([noName]))[0].tlsServername).toBeUndefined();
    const unpinned = { ...noName, proxy: { url: 'http://127.0.0.1:8480', token: T } };
    expect(() => loadCameras(file([unpinned]))).toThrow('camera registry entry 0: host "from-proxy" needs protocol "https" and a tlsServername (or a proxy caFingerprint)');
    expect(() => loadCameras(file([{ ...noName, protocol: 'http' }]))).toThrow('needs protocol "https"');
  });

  it('no longer warns that a pin isn’t enforced (it is, from P5 on)', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      loadCameras(file([entry('cam3')]));
      expect(warn).not.toHaveBeenCalledWith(expect.anything(), 'proxy_pin_not_enforced');
    } finally {
      warn.mockRestore();
    }
  });

  it('warns at start, once per camera, about an https camera it can’t verify', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      loadCameras(file([
        { id: 'a', name: 'a', host: '192.168.1.5', user: 'u', password: 'p' }, // https, no name, no pin
        { id: 'b', name: 'b', host: '192.168.1.6', protocol: 'http', user: 'u', password: 'p' },
        { id: 'c', name: 'c', host: '192.168.1.7', tlsServername: 'c.example', user: 'u', password: 'p' },
        { id: 'd', name: 'd', host: '192.168.1.8', user: 'u', password: 'p', proxy: { url: 'https://192.168.1.230:8443', token: T, caFingerprint: A } },
      ]));
      expect(warn.mock.calls.filter((c) => c[1] === 'camera_tls_unverified')).toEqual([[{ cameraId: 'a' }, 'camera_tls_unverified']]);
    } finally {
      warn.mockRestore();
    }
  });
});
