// SIGTERM ends cams promptly (issue #216): the real server as a process, with
// a camera whose cam-proxy event stream is open and has sent something, so
// the stream's idle watchdog is armed. Before the fix that watchdog (45 s)
// outlived the aborted stream and held the process for up to a minute, past
// Docker's and Kubernetes' grace periods.
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { createServer, type AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { FAKE_TOKEN, startFakeProxy, type FakeProxy } from './proxy/fakeProxy';

const ROOT = join(__dirname, '..');

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

async function until(cond: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

let proxy: FakeProxy | undefined;
let child: ChildProcess | undefined;
let dir: string | undefined;
afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await proxy?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
  proxy = child = dir = undefined;
});

describe('shutdown', () => {
  it('exits within a few seconds of SIGTERM while a cam-proxy event stream is open', async () => {
    proxy = await startFakeProxy();
    dir = mkdtempSync(join(tmpdir(), 'cams-shutdown-'));
    const cameras = join(dir, 'cameras.json');
    writeFileSync(cameras, JSON.stringify([{ id: 'den', name: 'Den', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p', proxy: { url: proxy.url, token: FAKE_TOKEN } }]), { mode: 0o600 });
    const port = await freePort();
    child = spawn(process.execPath, ['--import', 'tsx', 'server/server.ts'], {
      cwd: ROOT,
      stdio: 'ignore',
      env: {
        ...process.env,
        PORT: String(port),
        COOKIE_SECRET: 'shutdown-test-secret-not-a-secret-000000',
        CAMS_LOGIN_TOKEN: 'shutdown-test-login-token-0000000000',
        CAMERAS_FILE: cameras,
        PREFS_FILE: join(dir, 'prefs.json'),
        CACHE_DIR: join(dir, 'cache'),
        LOG_LEVEL: 'silent',
      },
    });
    const exited = new Promise<number>((r) => child!.once('exit', () => r(Date.now())));
    // The upstream stream is open and its first bytes (retry:) have arrived.
    await until(() => proxy!.streamConnections() === 1, 15_000, 'the event stream');
    await new Promise((r) => setTimeout(r, 500));
    const t0 = Date.now();
    child.kill('SIGTERM');
    const at = await Promise.race([exited, new Promise<number>((r) => setTimeout(() => r(-1), 10_000))]);
    expect(at, 'cams still running 10 s after SIGTERM').not.toBe(-1);
    expect(at - t0).toBeLessThan(5_000);
  }, 40_000);
});
