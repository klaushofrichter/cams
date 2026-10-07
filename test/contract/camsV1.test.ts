import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { jcs } from '../../server/admin/jcs';
import {
  answerText, enrollText, newNonce, privateFromB64, publicFromB64, requestText, sha256hex, signText, verifySigned, verifyText, verifyWithAny,
} from '../../server/admin/sign';
import vectors from '../../contract/cams-v1/vectors.json';
import { camsFixtures, camsValidator, CONTRACT_DIR } from '../helpers/contract';

const priv = (k: 'server' | 'cams' | 'other') => privateFromB64(vectors.keys[k].privateKey);
const pub = (k: 'server' | 'cams' | 'other') => publicFromB64(vectors.keys[k].publicKey);

describe('cams-v1 contract (vendored)', () => {
  it('SOURCE names a 40-hex cams-admin commit', () => {
    expect(readFileSync(join(CONTRACT_DIR, 'SOURCE'), 'utf8').trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  it('server/admin/jcs.ts is cams-admin\'s jcs verbatim', () => {
    const vendored = readFileSync(join(CONTRACT_DIR, 'jcs.ts.txt'), 'utf8');
    const ours = readFileSync(join(__dirname, '../../server/admin/jcs.ts'), 'utf8');
    expect(ours).toBe(vendored);
  });

  it('request texts and signatures reproduce byte for byte (cams key)', () => {
    expect(vectors.requests.length).toBe(3);
    for (const r of vectors.requests) {
      const body = Buffer.from(r.body, 'utf8');
      expect(sha256hex(body)).toBe(r.bodySha256);
      expect(requestText(r.method, r.pathAndQuery, r.ts, r.nonce, body)).toBe(r.text);
      expect(signText(priv('cams'), r.text)).toBe(r.sig);
      expect(verifyText(pub('cams'), r.text, r.sig)).toBe(true);
    }
  });

  it('answer texts and signatures reproduce byte for byte (server key)', () => {
    expect(vectors.responses.length).toBe(3);
    for (const a of vectors.responses) {
      const body = Buffer.from(a.body, 'utf8');
      expect(sha256hex(body)).toBe(a.bodySha256);
      expect(answerText(a.status, a.nonce, body)).toBe(a.text);
      expect(signText(priv('server'), a.text)).toBe(a.sig);
      expect(verifyWithAny([vectors.keys.other.publicKey, vectors.keys.server.publicKey], a.text, a.sig)).toBe(true);
    }
    expect(sha256hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('snapshot jcs text and sig reproduce; verifySigned checks sig over jcs(obj without sig)', () => {
    for (const s of vectors.snapshots) {
      expect(jcs(s.snapshot)).toBe(s.text);
      expect(signText(priv('server'), s.text)).toBe(s.sig);
      expect(verifySigned([vectors.keys.server.publicKey], { ...s.snapshot, sig: s.sig })).toBe(true);
      expect(verifySigned([vectors.keys.other.publicKey], { ...s.snapshot, sig: s.sig })).toBe(false);
      expect(verifySigned([vectors.keys.server.publicKey], { ...s.snapshot, revision: 'r:ffffffffffffffff', sig: s.sig })).toBe(false);
      expect(verifySigned([vectors.keys.server.publicKey], { ...s.snapshot })).toBe(false);
    }
  });

  it('the enroll proof text is cams\'s own and its signature reproduces', () => {
    const e = vectors.enroll[0];
    expect(enrollText(e.code, e.publicKey)).toBe(e.text);
    expect(e.text.startsWith('cams-admin cams-enroll v1\n')).toBe(true);
    expect(signText(priv('cams'), e.text)).toBe(e.sig);
  });

  it('verifyText is false for another key, a changed body hash, an 87-character signature, a non-string', () => {
    const r = vectors.requests[0];
    expect(verifyText(pub('other'), r.text, r.sig)).toBe(false);
    expect(verifyText(pub('cams'), r.text.replace(r.bodySha256, sha256hex('x')), r.sig)).toBe(false);
    expect(verifyText(pub('cams'), r.text, r.sig.slice(0, 87))).toBe(false);
    expect(verifyText(pub('cams'), r.text, 42)).toBe(false);
    expect(verifyText(pub('cams'), r.text, null)).toBe(false);
    expect(verifyWithAny(['not a key', ''], r.text, r.sig)).toBe(false);
  });

  it('publicFromB64 accepts only a 44-byte Ed25519 SPKI', () => {
    expect(() => publicFromB64(Buffer.alloc(44).toString('base64'))).toThrow();
    expect(() => publicFromB64('')).toThrow();
  });

  it('newNonce: 22 base64url characters, fresh each time', () => {
    const a = newNonce(), b = newNonce();
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(a).not.toBe(b);
  });

  it('fixtures behave as their prefix says (strict and lenient schemas)', () => {
    const fixtures = camsFixtures();
    expect(fixtures.length).toBeGreaterThanOrEqual(13);
    for (const f of fixtures) {
      const strict = camsValidator(f.schema, 'strict')(f.message);
      const lenient = camsValidator(f.schema, 'lenient')(f.message);
      if (f.name.startsWith('valid-')) expect([f.name, strict, lenient]).toEqual([f.name, true, true]);
      if (f.name.startsWith('invalid-')) expect([f.name, strict]).toEqual([f.name, false]);
      if (f.name.startsWith('drift-')) expect([f.name, strict, lenient]).toEqual([f.name, false, true]);
    }
  });

  it('the signed snapshot fixtures verify with the vectors server key', () => {
    const f = (n: string) => camsFixtures().find((x) => x.name === n)!;
    for (const n of ['valid-snapshot-two-accounts', 'valid-snapshot-empty']) expect(verifySigned([vectors.keys.server.publicKey], f(n).message), n).toBe(true);
    expect(verifySigned([vectors.keys.server.publicKey], f('invalid-snapshot-unsigned').message)).toBe(false);
  });
});
