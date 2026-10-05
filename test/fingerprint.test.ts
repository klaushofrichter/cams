// test/fingerprint.test.ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { X509Certificate } from 'crypto';
import { join } from 'path';
import { certFingerprint, fingerprintList, formatFingerprint, normalizeFingerprint } from '../server/tls/fingerprint';

const pem = (n: string) => readFileSync(join(__dirname, 'fixtures/site-ca', `${n}.pem`), 'utf8');
const HEX = 'ab'.repeat(32);

describe('fingerprints', () => {
  it('normalizes the forms people paste', () => {
    for (const v of [HEX, HEX.toUpperCase(), `SHA256:${HEX}`, `sha256:${HEX.match(/../g)!.join(':')}`, ` SHA-256:${HEX.toUpperCase()} `]) expect(normalizeFingerprint(v)).toBe(HEX);
  });

  it('refuses anything else', () => {
    for (const v of [undefined, 42, '', 'SHA256:abc', HEX.slice(2), `${HEX}00`, 'q'.repeat(64), 'SHA256:q83vEjRWeJA='] as unknown[]) expect(normalizeFingerprint(v)).toBeNull();
  });

  it('takes one or a list (CA rotation, spec §10.7)', () => {
    expect(fingerprintList(HEX)).toEqual([HEX]);
    expect(fingerprintList([HEX, `SHA256:${'cd'.repeat(32)}`])).toEqual([HEX, 'cd'.repeat(32)]);
    expect(fingerprintList([])).toBeNull();
    expect(fingerprintList([HEX, 'nope'])).toBeNull();
  });

  it('formats like the proxy’s Certificates card and computes it from a PEM', () => {
    expect(formatFingerprint(HEX)).toBe(`SHA256:${'AB:'.repeat(31)}AB`);
    const ca = pem('ca-a');
    expect(certFingerprint(ca)).toBe(normalizeFingerprint(new X509Certificate(ca).fingerprint256));
    expect(certFingerprint(ca)).not.toBe(certFingerprint(pem('ca-b')));
  });
});
