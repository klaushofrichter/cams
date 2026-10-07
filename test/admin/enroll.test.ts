// admin-enroll (migration P4, M §9.1, R4-5): the code on stdin, never an
// argument; the key file 600; the server key's fingerprint printed to compare.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { runCli } from '../../server/cli';
import { enroll } from '../../server/admin/enroll';
import { fingerprintOf, OTHER_KEY, startFakeAdmin, SERVER_KEY, type FakeAdmin } from './fakeAdmin';

let fake: FakeAdmin;
beforeEach(async () => {
  fake = await startFakeAdmin();
});
afterEach(() => fake.stop());

async function cli(args: string[], stdin: string, env: Record<string, string>) {
  const out: string[] = [], err: string[] = [];
  const code = await runCli(args, { stdin: Readable.from([stdin]), out: (l) => out.push(l), err: (l) => err.push(l), env });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

describe('admin-enroll', () => {
  it('code on stdin, never an argument; key file 600 in a 700 folder; prints the server key fingerprint and nothing secret', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cams-enroll-'));
    const code = fake.code;
    const out = await cli(['admin-enroll', '--url', fake.url], `${code.toLowerCase().replace(/-/g, ' ')}\n`, { CAMS_DATA_DIR: dir });
    expect(out.code).toBe(0);
    expect(out.stdout).toContain(`server key ${fake.fingerprint}`);
    expect(out.stdout).toContain('enrolled as cluster (cms_00000000000000000001), accounts home');
    expect(out.stdout + out.stderr).not.toContain(code);
    const kf = JSON.parse(readFileSync(join(dir, 'admin/key.json'), 'utf8'));
    expect(out.stdout + out.stderr).not.toContain(kf.privateKey);
    expect(kf).toMatchObject({ v: 1, url: fake.url, instanceId: fake.instanceId, keyId: fake.keyId, serverKeys: [SERVER_KEY.publicKey], accounts: ['home'] });
    expect(kf.publicKey).toBe(fake.publicKey);
    expect(statSync(join(dir, 'admin/key.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'admin')).mode & 0o777).toBe(0o700);
    expect((await cli(['admin-enroll', '--url', fake.url, '--code', 'x'], '', { CAMS_DATA_DIR: dir })).code).not.toBe(0); // no --code option
  });

  it('a refused code exits non-zero with the error code, and writes nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cams-enroll-'));
    const out = await cli(['admin-enroll', '--url', fake.url], 'CAC1-0000-0000-0000-0000-0000\n', { CAMS_DATA_DIR: dir });
    expect(out.code).not.toBe(0);
    expect(out.stderr).toContain('invalid_code');
    expect(() => statSync(join(dir, 'admin/key.json'))).toThrow();
  });

  it('a code that is not a CAC1 code (a proxy CAE1 code) is refused before any request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cams-enroll-'));
    const out = await cli(['admin-enroll', '--url', fake.url], 'CAE1-0000-0000-0000-0000-0000\n', { CAMS_DATA_DIR: dir });
    expect(out.code).not.toBe(0);
    expect(fake.requests).toEqual([]);
  });

  it('the fingerprints are computed from the received keys: an answer whose fingerprints don\'t match its keys is refused', async () => {
    const lying = (async () => new Response(JSON.stringify({ v: 1, instanceId: 'cms_00000000000000000001', instanceName: 'x', keyId: 'key_00000000000000000001', accounts: [], serverKeys: [OTHER_KEY.publicKey], serverKeyFingerprints: [fingerprintOf(SERVER_KEY.publicKey)], apiUrl: 'x' }), { status: 201 })) as typeof fetch;
    await expect(enroll('http://127.0.0.1:1', fake.code, 'test', lying)).rejects.toThrow(/fingerprint/);
    const k = await enroll(fake.url, fake.code, 'test');
    expect(k.serverKeyFingerprints).toEqual([fingerprintOf(SERVER_KEY.publicKey)]);
  });

  it('refuses http:// except on loopback', async () => {
    for (const u of ['http://cams-admin.example.net', 'http://192.0.2.1:8080', 'ftp://x']) await expect(enroll(u, fake.code, 'test')).rejects.toThrow(/https/);
    const dir = mkdtempSync(join(tmpdir(), 'cams-enroll-'));
    const out = await cli(['admin-enroll', '--url', 'http://cams-admin.example.net'], `${fake.code}\n`, { CAMS_DATA_DIR: dir });
    expect(out.code).not.toBe(0);
    expect(fake.requests).toEqual([]);
  });

  it('enroll() checks the answer\'s shape', async () => {
    await expect(enroll(fake.url, fake.code, 'test', (async () => new Response(JSON.stringify({ v: 1, instanceId: 'x' }), { status: 201 })) as typeof fetch)).rejects.toThrow(/answer/);
  });
});
