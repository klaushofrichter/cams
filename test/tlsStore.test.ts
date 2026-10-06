// What cams keeps of its proxies' TLS (cam-proxy spec 2026-10-05 §12.3):
// the verified site CAs and the fallback leaf pins, across restarts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setCameras } from '../server/cameraRegistry';
import { certFingerprint } from '../server/tls/fingerprint';
import { addVerifiedCa, fallbackPin, loadTlsState, setFallbackPin, trustEvents, verifiedCas } from '../server/tls/store';

const pem = (n: string) => readFileSync(join(__dirname, 'fixtures/site-ca', `${n}.pem`), 'utf8');
const CA_A = pem('ca-a'), CA_B = pem('ca-b');
const A = certFingerprint(CA_A), B = certFingerprint(CA_B), LEAF = 'cc'.repeat(32);
let file: string;
beforeEach(() => {
  file = join(mkdtempSync(join(tmpdir(), 'cams-tls-')), 'proxy-tls.json');
  process.env.PROXY_TLS_FILE = file;
  loadTlsState();
});
afterEach(() => {
  delete process.env.PROXY_TLS_FILE;
  setCameras([]);
  vi.restoreAllMocks();
});
const HOST = '192.168.60.15';

describe('TLS store', () => {
  it('keeps verified CAs across a restart, mode 600', async () => {
    await addVerifiedCa(A, CA_A);
    loadTlsState();
    expect(verifiedCas([B, A])).toEqual([CA_A]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('keeps fallback pins and announces a change once', async () => {
    const seen: string[] = [];
    const on = (e: { cam: string }) => seen.push(e.cam);
    trustEvents.on('trust', on);
    try {
      await setFallbackPin('cam5', { fingerprint: LEAF, host: HOST });
      await setFallbackPin('cam5', { fingerprint: LEAF, host: HOST });
      loadTlsState();
      expect(fallbackPin('cam5', HOST)).toBe(LEAF);
      await setFallbackPin('cam5', null);
      expect(fallbackPin('cam5', HOST)).toBeUndefined();
      expect(seen).toEqual(['cam5', 'cam5']);
    } finally {
      trustEvents.off('trust', on);
    }
  });

  it('drops a CA whose PEM doesn’t match its fingerprint (a hand-edited file)', () => {
    writeFileSync(file, JSON.stringify({ cas: { [A]: CA_B, [B]: CA_B }, pins: { cam5: { fingerprint: 'nope', host: HOST }, cam6: { fingerprint: LEAF, host: HOST }, cam7: LEAF } }), { mode: 0o600 });
    loadTlsState();
    expect(verifiedCas([A, B])).toEqual([CA_B]);
    expect(fallbackPin('cam5', HOST)).toBeUndefined();
    expect(fallbackPin('cam6', HOST)).toBe(LEAF);
    expect(fallbackPin('cam7', HOST)).toBeUndefined(); // a pin without its address
  });

  it('starts empty from a missing or corrupt file', () => {
    writeFileSync(file, '{not json', { mode: 0o600 });
    loadTlsState();
    expect(verifiedCas([A])).toEqual([]);
  });

  it('binds a pin to the camera’s address: another address isn’t pinned (security review of #227)', async () => {
    await setFallbackPin('cam5', { fingerprint: LEAF, host: HOST });
    expect(fallbackPin('cam5', HOST)).toBe(LEAF);
    expect(fallbackPin('cam5', '192.168.60.16')).toBeUndefined();
    expect(fallbackPin('cam5', undefined)).toBeUndefined();
  });

  it('refuses a file others can read or write (integrity: a planted pin would let a host take the camera login)', () => {
    writeFileSync(file, JSON.stringify({ cas: {}, pins: {} }), { mode: 0o644 });
    expect(() => loadTlsState()).toThrow(/proxy-tls\.json must be mode 600 and owned by this user/);
  });

  it('refuses a file of another owner', async () => {
    await addVerifiedCa(A, CA_A);
    vi.spyOn(process, 'getuid').mockReturnValue((process.getuid?.() ?? 0) + 1);
    expect(() => loadTlsState()).toThrow(/must be mode 600 and owned by this user/);
  });

  it('never falls back to the temp folder for a pinned proxy', () => {
    delete process.env.PROXY_TLS_FILE;
    const prefs = process.env.PREFS_FILE;
    delete process.env.PREFS_FILE;
    try {
      setCameras([{ id: 'cam3', name: 'c', host: '192.168.60.13', protocol: 'https', user: 'u', password: 'p', proxy: { url: 'https://192.168.1.230:8443', token: 't'.repeat(40), caFingerprint: [A] } }]);
      expect(() => loadTlsState()).toThrow('a cam-proxy caFingerprint needs a data folder for proxy-tls.json: set PROXY_TLS_FILE or PREFS_FILE');
      setCameras([{ id: 'cam1', name: 'c', host: 'from-proxy', protocol: 'https', tlsServername: 'cam1.skylar.technology', user: 'u', password: 'p', proxy: { url: 'http://127.0.0.1:8480', token: 't'.repeat(40) } }]);
      expect(() => loadTlsState()).not.toThrow(); // the Pi: no pin, nothing kept
    } finally {
      if (prefs !== undefined) process.env.PREFS_FILE = prefs;
    }
  });
});
