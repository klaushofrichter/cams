// What cams keeps of its proxies' TLS (cam-proxy spec 2026-10-05 §12.3):
// the verified site CAs and the fallback leaf pins, across restarts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
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
});

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
      await setFallbackPin('cam5', LEAF);
      await setFallbackPin('cam5', LEAF);
      loadTlsState();
      expect(fallbackPin('cam5')).toBe(LEAF);
      await setFallbackPin('cam5', null);
      expect(fallbackPin('cam5')).toBeUndefined();
      expect(seen).toEqual(['cam5', 'cam5']);
    } finally {
      trustEvents.off('trust', on);
    }
  });

  it('drops a CA whose PEM doesn’t match its fingerprint (a hand-edited file)', () => {
    writeFileSync(file, JSON.stringify({ cas: { [A]: CA_B, [B]: CA_B }, pins: { cam5: 'nope', cam6: LEAF } }));
    loadTlsState();
    expect(verifiedCas([A, B])).toEqual([CA_B]);
    expect(fallbackPin('cam5')).toBeUndefined();
    expect(fallbackPin('cam6')).toBe(LEAF);
  });

  it('starts empty from a missing or corrupt file', () => {
    writeFileSync(file, '{not json');
    loadTlsState();
    expect(verifiedCas([A])).toEqual([]);
  });
});
