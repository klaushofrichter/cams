// test/siteCa.test.ts
// The site CA (cam-proxy spec 2026-10-05 §10.1.4): cams fetches
// /tls/ca.pem, accepts it only if its fingerprint is pinned, and then trusts
// only that CA for the proxy, checked against the proxy's TLS name.
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { certFingerprint } from '../server/tls/fingerprint';
import { fetchPinnedCa, fetchWith, siteCaDispatcher, SiteCaError } from '../server/tls/siteCa';
import { FAKE_TOKEN, startFakeProxy, type FakeProxy } from './proxy/fakeProxy';

const read = (n: string) => readFileSync(join(__dirname, 'fixtures/site-ca', n), 'utf8');
const CA_A = read('ca-a.pem'), CA_B = read('ca-b.pem');
const A = certFingerprint(CA_A), B = certFingerprint(CA_B);
let fake: FakeProxy | undefined;
afterEach(async () => {
  await fake?.stop();
  fake = undefined;
});
async function httpsProxy(leaf = 'proxy-a', ca: string | null = CA_A): Promise<FakeProxy> {
  fake = await startFakeProxy({ tls: { key: read(`${leaf}.key`), cert: read(`${leaf}.pem`) } });
  fake.caPem = ca;
  return fake;
}
const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof SiteCaError ? e.code : `other: ${(e as Error).message}`));

describe('fetchPinnedCa', () => {
  it('accepts the CA whose fingerprint is pinned', async () => {
    const f = await httpsProxy();
    expect(f.url).toMatch(/^https:\/\/127\.0\.0\.1:\d+$/);
    const got = await fetchPinnedCa(f.url, [A]);
    expect(got.fingerprint).toBe(A);
    expect(certFingerprint(got.pem)).toBe(A);
  });

  it('accepts it from a rotation list', async () => {
    expect((await fetchPinnedCa((await httpsProxy()).url, [B, A])).fingerprint).toBe(A);
  });

  it('refuses another CA (a wrong pin)', async () => {
    expect(await code(fetchPinnedCa((await httpsProxy()).url, [B]))).toBe('ca_pin_mismatch');
  });

  it('refuses a pinned certificate that isn’t a CA', async () => {
    const f = await httpsProxy('proxy-a', read('proxy-a.pem'));
    expect(await code(fetchPinnedCa(f.url, [certFingerprint(read('proxy-a.pem'))]))).toBe('ca_invalid');
  });

  it('says unreachable for a 404 and for a dead proxy', async () => {
    const f = await httpsProxy('proxy-a', null);
    expect(await code(fetchPinnedCa(f.url, [A]))).toBe('ca_unreachable');
    expect(await code(fetchPinnedCa('https://127.0.0.1:9', [A], { timeoutMs: 1000 }))).toBe('ca_unreachable');
  });

  it('works over plain http too (cams on the proxy’s own host)', async () => {
    fake = await startFakeProxy();
    fake.caPem = CA_A;
    expect((await fetchPinnedCa(fake.url, [A])).fingerprint).toBe(A);
  });
});

describe('siteCaDispatcher', () => {
  const health = (url: string, pems: string[], servername?: string) =>
    fetchWith(siteCaDispatcher(pems, servername))(`${url}/api/cameras`, { headers: { Authorization: `Bearer ${FAKE_TOKEN}` } }).then((r) => r.status, (e: unknown) => `refused: ${(e as Error).name}`);

  it('trusts the proxy’s leaf by the CA and the proxy’s TLS name', async () => {
    expect(await health((await httpsProxy()).url, [CA_A], 'proxy.test.internal')).toBe(200);
  });

  it('refuses another CA, another name, and a leaf outside the name constraints', async () => {
    const f = await httpsProxy();
    expect(await health(f.url, [CA_B], 'proxy.test.internal')).toMatch(/^refused/);
    expect(await health(f.url, [CA_A], 'cam3.test.internal')).toMatch(/^refused/);
    await f.stop();
    const evil = await httpsProxy('outside-a');
    expect(await health(evil.url, [CA_A], 'evil.example')).toMatch(/^refused/);
  });

  it('never falls back to the public CAs', async () => {
    expect(await health((await httpsProxy()).url, [CA_B])).toMatch(/^refused/);
  });
});
