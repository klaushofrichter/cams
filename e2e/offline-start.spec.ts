import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'child_process';
import { chmodSync, cpSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { E2E_ADMIN_DATA, E2E_ADMIN_ENV } from './env';

// Migration P4 (M §9.4, the Pi on the road): cams in cams-admin mode starts
// with cams-admin unreachable, from its signed cache; the token sign-in, the
// live still and the recordings work. Its own cams process (a copy of the
// e2e server's data folder, cams-admin pointed at a closed port), stopped by
// its PID at the end.
const PORT = 8081;
const TOKEN = 'e2e-offline-token-not-a-secret-00000000';
let proc: ChildProcess | undefined;
let dir = '';

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cams-e2e-offline-'));
  cpSync(E2E_ADMIN_DATA, dir, { recursive: true });
  chmodSync(join(dir, 'admin'), 0o700); // cpSync makes folders with the default mode; cams refuses an open key folder
  proc = spawn('node', ['dist/server/server.js'], {
    env: {
      ...process.env, ...E2E_ADMIN_ENV, PORT: String(PORT), CAMS_DATA_DIR: dir, CAMS_ADMIN_URL: 'http://127.0.0.1:9',
      CAMERA_CREDENTIALS_FILE: join(dir, 'credentials.json'), PREFS_FILE: join(dir, 'prefs.json'), PROXY_STATE_FILE: join(dir, 'proxy-state.json'),
      CACHE_DIR: join(dir, 'cache'), CAMS_LOGIN_TOKEN: TOKEN, CAMS_TOKEN_ACCOUNT: 'home', COOKIE_SECURE: 'false',
    },
    stdio: 'ignore',
  });
  await expect.poll(async () => fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.status).catch(() => 0), { timeout: 20_000 }).toBe(200);
});
test.afterAll(async () => {
  if (proc?.pid && proc.exitCode === null) process.kill(proc.pid, 'SIGTERM');
  rmSync(dir, { recursive: true, force: true });
});

test('cams-admin unreachable: token sign-in, the live still and the recordings work from the cache', async ({ page }) => {
  await page.goto(`http://localhost:${PORT}/`);
  const login = await page.evaluate(async (token) => (await fetch('/auth/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })).status, TOKEN);
  expect(login).toBe(200);
  const me = await page.evaluate(async () => (await (await fetch('/api/me')).json()) as { account: { name: string }; role: string });
  expect(me).toMatchObject({ account: { name: 'home' }, role: 'admin' });
  const cams = await page.evaluate(async () => (await (await fetch('/api/cameras')).json()) as { id: string; name: string }[]);
  expect(cams.map((c) => c.name)).toEqual(['Den']);
  await expect.poll(async () => page.evaluate(async () => (await fetch('/api/cameras/cam1/still/latest.jpg')).status), { timeout: 15_000 }).toBe(200);
  const month = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit' }).format(new Date());
  const days = await page.evaluate(async (m) => (await (await fetch(`/api/cameras/cam1/days?month=${m}`)).json()) as { days: string[] }, month);
  expect(days.days.length).toBeGreaterThan(0);
  await page.goto(`http://localhost:${PORT}/app/video`);
  await expect(page.getByTestId('camera-picker').locator('option')).toHaveText(['Den']);
});
