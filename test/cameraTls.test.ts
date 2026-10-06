// Camera TLS by trust (cam-proxy spec 2026-10-05 §12.3): a site CA with the
// camera's .internal name, a leaf pin for a camera that refused the import,
// today's public-CA name check, or nothing.
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { classifyNetworkError } from '../server/reolink/client';
import { openRequest, readBody, type CameraTrust } from '../server/reolink/http';
import { certFingerprint } from '../server/tls/fingerprint';
import { startTlsCamera } from './helpers/tlsCamera';

const pem = (n: string) => readFileSync(join(__dirname, 'fixtures/site-ca', `${n}.pem`), 'utf8');
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(stops.splice(0).map((s) => s()));
});
async function cam(name: 'cam-a' | 'selfsigned' | 'outside-a') {
  const c = await startTlsCamera(name);
  stops.push(c.stop);
  return c;
}
const call = (host: string, trust: CameraTrust) =>
  openRequest({ protocol: 'https', host, trust }, '/cgi-bin/api.cgi?cmd=GetDevInfo', { method: 'POST', body: '[{"cmd":"GetDevInfo"}]', timeoutMs: 2000 }).then(
    async (res) => `${res.statusCode} ${(await readBody(res)).length > 0}`,
    (err: { code?: string }) => `error ${err.code}`,
  );

describe('camera TLS by trust', () => {
  it('site CA: trusts the camera’s leaf by the CA, by name or by address', async () => {
    const c = await cam('cam-a');
    expect(await call(c.host, { kind: 'site-ca', ca: [pem('ca-a')], servername: 'cam3.test.internal' })).toBe('200 true');
    expect(await call(c.host, { kind: 'site-ca', ca: [pem('ca-a')] })).toBe('200 true'); // IP SAN 127.0.0.1
  });

  it('site CA: refuses another CA, another name, and a leaf outside the CA’s constraints', async () => {
    const c = await cam('cam-a');
    expect(await call(c.host, { kind: 'site-ca', ca: [pem('ca-b')], servername: 'cam3.test.internal' })).toMatch(/^error /);
    expect(await call(c.host, { kind: 'site-ca', ca: [pem('ca-a')], servername: 'cam4.test.internal' })).toBe('error ERR_TLS_CERT_ALTNAME_INVALID');
    const evil = await cam('outside-a');
    expect(await call(evil.host, { kind: 'site-ca', ca: [pem('ca-a')], servername: 'evil.example' })).toMatch(/^error /);
  });

  it('pinned: accepts the factory certificate with that fingerprint', async () => {
    const c = await cam('selfsigned');
    expect(await call(c.host, { kind: 'pinned', fingerprint: certFingerprint(pem('selfsigned')) })).toBe('200 true');
  });

  it('pinned: sends nothing when the pin doesn’t match', async () => {
    const c = await cam('selfsigned');
    expect(await call(c.host, { kind: 'pinned', fingerprint: 'ab'.repeat(32) })).toBe('error ERR_TLS_CERT_PIN_MISMATCH');
    await new Promise((r) => setTimeout(r, 50));
    expect(c.received()).toBe(0);
  });

  it('public: today’s name check (a test CA standing in for the public ones)', async () => {
    const c = await cam('cam-a');
    expect(await call(c.host, { kind: 'public', servername: 'cam3.test.internal', ca: pem('ca-a') })).toBe('200 true');
    expect(await call(c.host, { kind: 'public', servername: 'cam3.test.internal' })).toMatch(/^error /);
  });

  it('none: unverified, as today without a tlsServername', async () => {
    expect(await call((await cam('selfsigned')).host, { kind: 'none' })).toBe('200 true');
  });

  it('unavailable: refuses at once, connecting nowhere', async () => {
    const c = await cam('cam-a');
    expect(await call(c.host, { kind: 'unavailable', reason: 'the proxy’s site CA is not verified yet' })).toBe('error ERR_TLS_CA_UNVERIFIED');
    expect(c.received()).toBe(0);
  });

  it('keeps today’s target without a trust: tlsServername means a name check', async () => {
    const c = await cam('selfsigned');
    const res = await openRequest({ protocol: 'https', host: c.host }, '/', { timeoutMs: 2000 });
    expect(res.statusCode).toBe(200);
    res.resume();
    await expect(openRequest({ protocol: 'https', host: c.host, tlsServername: 'cam1.test.local' }, '/', { timeoutMs: 2000 })).rejects.toThrow();
  });

  it('reports a real name-constraint refusal as a certificate error, not offline', async () => {
    const evil = await cam('outside-a');
    const err = await openRequest({ protocol: 'https', host: evil.host, trust: { kind: 'site-ca', ca: [pem('ca-a')], servername: 'evil.example' } }, '/', { timeoutMs: 2000 }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(classifyNetworkError(err).code).toBe('camera_error');
  });

  it('reports a name-constraint failure as a certificate error, not offline', () => {
    expect(classifyNetworkError(Object.assign(new Error('x'), { code: 'PERMITTED_SUBTREE_VIOLATION' })).code).toBe('camera_error');
    expect(classifyNetworkError(Object.assign(new Error('x'), { code: 'ERR_TLS_CERT_PIN_MISMATCH' })).code).toBe('camera_error');
  });
});
