// test/camerasConfigCli.test.ts
// scripts/cameras-config.ts (cam-proxy spec 2026-10-05 §13.3): dry run by
// default, --write atomically with a backup, nothing written on any failure.
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { tmpdir } from 'os';
import { join } from 'path';
import { runCamerasConfig } from '../server/cameraImport';
import { FAKE_TOKEN, startFakeProxy, type FakeProxy } from './proxy/fakeProxy';

const PW = 'camera-password-1';
const fakes: FakeProxy[] = [];
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((f) => f.stop()));
});

async function setup(proxies: (url: string) => object[], existing?: unknown[]) {
  const f = await startFakeProxy();
  fakes.push(f);
  f.cameraAddresses.set('cam1', '192.168.1.164');
  const dir = mkdtempSync(join(tmpdir(), 'cams-cli-'));
  writeFileSync(join(dir, 'cameras-config.json'), JSON.stringify({ proxies: proxies(f.url) }), { mode: 0o600 });
  if (existing) writeFileSync(join(dir, 'cameras.json'), JSON.stringify(existing), { mode: 0o600 });
  const lines: string[] = [];
  const run = (...args: string[]) => runCamerasConfig(['--output', join(dir, 'cameras.json'), ...args], { PROXY_TOKEN: FAKE_TOKEN }, { out: (l) => lines.push(l), err: (l) => lines.push(`ERR ${l}`) }, () => new Date(Date.UTC(2026, 9, 5, 12, 0, 0)));
  return { f, dir, lines, run };
}
const proxy = (url: string) => ({ url, token: { env: 'PROXY_TOKEN' }, cameraUser: 'cams', cameraPassword: PW, protocol: 'http' });

describe('cameras-config', () => {
  it('prints a diff and writes nothing by default', async () => {
    const s = await setup((url) => [proxy(url)]);
    expect(await s.run()).toBe(0);
    expect(s.lines.some((l) => l.startsWith('+ cam1: '))).toBe(true);
    expect(s.lines.at(-1)).toBe('Dry run: nothing written. Run again with --write to write ' + join(s.dir, 'cameras.json') + '.');
    expect(existsSync(join(s.dir, 'cameras.json'))).toBe(false);
    expect(s.lines.join('\n')).not.toContain(FAKE_TOKEN);
    expect(s.lines.join('\n')).not.toContain(PW);
  });

  it('--write writes mode 600 and keeps a backup of the old file', async () => {
    const s = await setup((url) => [proxy(url)], [{ id: 'shed', name: 'Shed', host: '127.0.0.1:1', protocol: 'http', user: 'u', password: 'p' }]);
    expect(await s.run('--write')).toBe(0);
    const out = join(s.dir, 'cameras.json');
    expect(JSON.parse(readFileSync(out, 'utf8')).map((e: { id: string }) => e.id)).toEqual(['shed', 'cam1']);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    const bak = readdirSync(s.dir).filter((n) => n.startsWith('cameras.json.bak-'));
    expect(bak).toEqual(['cameras.json.bak-20261005-120000']);
    expect(statSync(join(s.dir, bak[0])).mode & 0o777).toBe(0o600);
  });

  it('writes nothing when a later proxy fails', async () => {
    const s = await setup((url) => [proxy(url), { ...proxy('http://127.0.0.1:9'), prefix: 'b-' }], [{ id: 'shed', name: 'Shed', host: '127.0.0.1:1', protocol: 'http', user: 'u', password: 'p' }]);
    const before = readFileSync(join(s.dir, 'cameras.json'), 'utf8');
    expect(await s.run('--write')).toBe(1);
    expect(s.lines.at(-1)).toMatch(/^ERR proxy 127\.0\.0\.1:9: unreachable/);
    expect(readFileSync(join(s.dir, 'cameras.json'), 'utf8')).toBe(before);
    expect(readdirSync(s.dir).filter((n) => n.includes('.bak-') || n.includes('.tmp'))).toEqual([]);
  });

  it('refuses an input file others can read', async () => {
    const s = await setup((url) => [proxy(url)]);
    chmodSync(join(s.dir, 'cameras-config.json'), 0o644);
    expect(await s.run()).toBe(1);
    expect(s.lines.at(-1)).toBe(`ERR ${join(s.dir, 'cameras-config.json')} is readable by others: chmod 600 it (it holds tokens and passwords)`);
  });

  it('refuses unknown flags and secrets on the command line', async () => {
    const s = await setup((url) => [proxy(url)]);
    expect(await s.run('--token', 'x')).toBe(2);
    expect(s.lines.at(-1)).toBe('ERR usage: cameras-config [--output cameras.json] [--input cameras-config.json] [--write] [--prune]');
  });

  it('runs as a script with npx tsx', async () => {
    const s = await setup((url) => [proxy(url)]);
    // Not execFileSync: the fake proxy answers from this process's event loop.
    const { stdout: out } = await promisify(execFile)('npx', ['tsx', 'scripts/cameras-config.ts', '--output', join(s.dir, 'cameras.json')], { env: { ...process.env, PROXY_TOKEN: FAKE_TOKEN }, encoding: 'utf8' });
    expect(out).toContain('+ cam1: ');
  }, 30_000);
});
