import { expect, test, type Page } from '@playwright/test';
import { signIn } from './session';
import { THROUGH_PROXY_PORT } from './fakeProxyData';

// Mill: a camera reached through its cam-proxy only (the second fake, which
// lists `camera-calls`; cam-proxy spec 2026-10-30-camera-onboarding-design
// §6). Live is the proxy's fMP4 relayed by cams, settings go to the proxy
// with cams's proxy-admin token, and the offline box's "Enter password" and
// "Trust certificate" are relayed to the proxy. Runs one test at a time, one
// size after the other (playwright.config.ts): the fake's state is shared.
const HOOKS = `http://127.0.0.1:${THROUGH_PROXY_PORT - 2}`;
const FP = `SHA256:${'3F'.repeat(32)}`;

test.beforeEach(async ({ context, baseURL, page }) => {
  await signIn(context, baseURL!);
  await page.request.post(`${HOOKS}/camera-status`, { data: { cam: 'mill', status: null } });
  await page.request.post(`${HOOKS}/password-answer`, { data: { answer: null } });
  await page.request.post(`${HOOKS}/trust-answer`, { data: { answer: null } });
});
test.afterEach(async ({ page }) => {
  await page.request.post(`${HOOKS}/camera-status`, { data: { cam: 'mill', status: null } });
});

const openMill = async (page: Page, path = '/app/live') => {
  await page.goto(path);
  await page.getByTestId('camera-picker').selectOption({ label: 'Mill' });
};

test('Mill plays live through its cam-proxy (fMP4)', async ({ page }) => {
  const live = page.waitForResponse((r) => /\/api\/cameras\/mill\/live\?/.test(r.url()));
  await openMill(page);
  const res = await live;
  expect(res.headers()['content-type']).toMatch(/^video\/mp4; codecs="/);
  expect(res.url()).toContain('codecs=');
  const video = page.getByTestId('live-video');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 20_000 }).toBeGreaterThan(1);
  await expect(page.getByTestId('live-badge')).toHaveText('● LIVE');
});

// The third stream (ext, the Reolink app's Balanced): Mill's proxy lists it,
// so the quality choice is SD | Balanced (| 4K where HEVC plays); Balanced
// asks the proxy for stream=ext and the label names its picture, 512p.
test('Mill offers Balanced; it plays the ext stream, labelled 512p', async ({ page }) => {
  await openMill(page);
  const choice = page.getByTestId('quality-choice');
  await expect(choice).toBeVisible();
  await expect(page.getByTestId('quality-ext')).toHaveText('Balanced');
  await expect(page.getByTestId('quality-sub')).toHaveAttribute('aria-pressed', 'true');
  const live = page.waitForResponse((r) => /\/api\/cameras\/mill\/live\?quality=ext/.test(r.url()));
  await page.getByTestId('quality-ext').click();
  expect((await live).status()).toBe(200);
  await expect(page.getByTestId('quality-ext')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.getByTestId('live-video').evaluate((v: HTMLVideoElement) => v.videoHeight), { timeout: 20_000 }).toBe(512);
  await expect(page.getByTestId('source-badge')).toHaveText('512p');
  // Back to SD for the other tests (the choice is kept in localStorage).
  await page.getByTestId('quality-sub').click();
  await expect(page.getByTestId('source-badge')).toHaveText(/^SD /);
});

test('Settings reads and saves an image setting through the proxy-admin token', async ({ page }) => {
  await openMill(page, '/app/settings');
  const mirror = page.getByTestId('flip-mirror');
  await expect(mirror).toBeVisible();
  const was = await mirror.isChecked();
  await mirror.setChecked(!was);
  await page.getByTestId('save-image').click();
  await expect(page.getByTestId('settings-card-image').getByTestId('save-state')).toHaveAttribute('data-state', 'saved');
  const calls = (await (await page.request.get(`${HOOKS}/calls?cam=mill`)).json()) as { writes: { path: string; admin: boolean }[] };
  expect(calls.writes.at(-1)).toEqual({ path: '/api/cameras/mill/settings/image', admin: true });
  // The Camera login is there for the proxy, without Secret instructions.
  await page.getByTestId('camera-password-change').click();
  await expect(page.getByTestId('camera-login')).toContainText('Save the login for Mill on its cam-proxy?');
  await expect(page.getByTestId('camera-login-secret')).toHaveCount(0);
  await mirror.setChecked(was);
  await page.getByTestId('save-image').click();
  await expect(page.getByTestId('settings-card-image').getByTestId('save-state')).toHaveAttribute('data-state', 'saved');
});

test('a refused camera password is entered in the offline box and relayed to the proxy', async ({ page }) => {
  await page.request.post(`${HOOKS}/camera-status`, { data: { cam: 'mill', status: { online: false, error: 'camera_offline', streams: { main: null, sub: null }, credentials: { source: 'store', authOk: false, checkedAt: Date.now() } } } });
  await openMill(page);
  await expect(page.getByTestId('offline-banner')).toBeVisible();
  await expect(page.getByTestId('offline-reason')).toHaveText('Signing in to the camera failed.');
  await page.getByTestId('offline-password').click();
  const dialog = page.getByTestId('offline-password-dialog');
  await expect(dialog).toContainText('Save the login for Mill on its cam-proxy?');
  await dialog.getByTestId('camera-password').fill('e2e-camera-password');
  await dialog.getByTestId('camera-password-save').click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('offline-banner')).toBeHidden({ timeout: 10_000 });
  const calls = (await (await page.request.get(`${HOOKS}/calls?cam=mill`)).json()) as { passwords: { admin: boolean }[] };
  expect(calls.passwords.at(-1)).toEqual({ admin: true });
});

test('an untrusted camera certificate is trusted with the fingerprint the proxy measured', async ({ page }) => {
  await page.request.post(`${HOOKS}/camera-status`, { data: { cam: 'mill', status: { online: false, error: 'camera_offline', streams: { main: null, sub: null }, tls: { mode: 'none', servername: null, fingerprint: null, notAfter: null, lastPush: null, served: FP, problem: 'untrusted' } } } });
  await openMill(page);
  await expect(page.getByTestId('offline-reason')).toHaveText("The cam-proxy doesn't trust the camera's certificate yet.");
  await page.getByTestId('offline-trust').click();
  const dialog = page.getByTestId('offline-trust-dialog');
  await expect(dialog.getByTestId('trust-fingerprint')).toHaveText(FP);
  await dialog.getByTestId('trust-confirm').click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('offline-banner')).toBeHidden({ timeout: 10_000 });
  const calls = (await (await page.request.get(`${HOOKS}/calls?cam=mill`)).json()) as { pins: { fingerprint: string }[] };
  expect(calls.pins.at(-1)).toEqual({ fingerprint: FP });
});
