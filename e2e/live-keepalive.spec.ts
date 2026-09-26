import { expect, test, type Page, type Request } from '@playwright/test';
import { PREFS_EMAIL } from './env';
import { signIn } from './session';

// The Live page stays mounted (hidden) for `liveKeepAlive` seconds after the
// user leaves it, so its stream keeps running and coming back needs no new
// connection. The expiry after N seconds is covered by
// web/src/lib/keepAlive.test.ts with fake timers; this file doesn't wait out
// a real minute.
//
// Isolation: the mock camera's /__state counters (activeStreams,
// streamsOpened) are shared with every other spec running in parallel
// against Den, so they can't prove anything about THIS page. Instead each
// test watches its own page's /live requests: a new request means a
// reconnect, and a request that fails (aborted) means the client closed the
// stream. Every test signs in as PREFS_EMAIL, so the keep-alive values it
// writes are never seen by other spec files (preferences are per user). Desktop
// only and serial: the desktop and phone projects would share that user.
test.describe.configure({ mode: 'serial' });
test.skip(() => test.info().project.name !== 'desktop', 'preferences of the shared PREFS_EMAIL user; desktop only');

const LIVE_URL = /\/api\/cameras\/[^/]+\/live\?/;

async function setKeepAlive(page: Page, seconds: number) {
  const res = await page.request.put('/api/preferences', { data: { liveKeepAlive: seconds } });
  expect(res.status()).toBe(200);
}

// Records this page's live-stream requests and which of them have ended.
function watchStreams(page: Page) {
  const opened: Request[] = [];
  const ended = new Set<Request>();
  page.on('request', (r) => { if (LIVE_URL.test(r.url())) opened.push(r); });
  page.on('requestfailed', (r) => { if (LIVE_URL.test(r.url())) ended.add(r); });
  page.on('requestfinished', (r) => { if (LIVE_URL.test(r.url())) ended.add(r); });
  return { opened, open: () => opened.filter((r) => !ended.has(r)).length };
}

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL!, PREFS_EMAIL);
});

test.afterAll(async ({ browser, baseURL }, testInfo) => {
  // Hooks still run in the projects whose tests are all skipped; only the
  // desktop project may touch PREFS_EMAIL's preferences.
  if (testInfo.project.name !== 'desktop') return;
  // restore the default for later tests, even if a test failed half-way
  const context = await browser.newContext();
  await signIn(context, baseURL!, PREFS_EMAIL);
  const page = await context.newPage();
  await setKeepAlive(page, 60);
  await context.close();
});

test('coming back within the keep-alive shows the live picture without reconnecting', async ({ page }) => {
  await setKeepAlive(page, 60);
  const streams = watchStreams(page);
  await page.goto('/app/live');
  const video = page.locator('[data-testid="live-video"]:visible');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState >= 2 && v.currentTime > 0.5), { timeout: 15_000 }).toBe(true);
  // Tag the element: coming back must show this very <video>, not a new one.
  await video.evaluate((v) => (v.dataset.keepaliveMark = 'same'));
  const before = streams.opened.length;
  expect(streams.open()).toBe(1);

  await page.getByTestId('sidebar').getByTestId('nav-settings').click();
  await expect(page.getByTestId('settings-card-prefs')).toBeVisible();
  await expect(page.getByTestId('page-title')).toHaveText('Settings'); // one title, not two
  await expect(page.getByTestId('live-video')).toBeHidden();
  await page.waitForTimeout(1_500);
  expect(streams.open()).toBe(1); // still streaming in the background
  // and still playing, not paused, while hidden
  expect(await page.getByTestId('live-video').evaluate((v: HTMLVideoElement) => !v.paused)).toBe(true);

  await page.getByTestId('sidebar').getByTestId('nav-live').click();
  await expect(page.getByTestId('page-title')).toHaveText('Live');
  // immediately playing, the same element, and no new stream was opened
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState >= 2 && !v.paused), { timeout: 1_000 }).toBe(true);
  expect(await video.evaluate((v) => v.dataset.keepaliveMark)).toBe('same');
  expect(streams.opened.length).toBe(before);
  expect(streams.open()).toBe(1);
});

test('with keep-alive off, leaving Live closes the stream', async ({ page }) => {
  await setKeepAlive(page, 0);
  const streams = watchStreams(page);
  await page.goto('/app/live');
  const video = page.locator('[data-testid="live-video"]:visible');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState >= 2), { timeout: 15_000 }).toBe(true);
  expect(streams.open()).toBe(1);

  await page.getByTestId('sidebar').getByTestId('nav-settings').click();
  await expect(page.getByTestId('settings-card-prefs')).toBeVisible();
  await expect.poll(() => streams.open(), { timeout: 5_000 }).toBe(0);
  await expect(page.locator('video')).toHaveCount(0);
});

// Task 13: Live's onDestroy publishes idle once the keep-alive expires and
// the page is actually torn down (as opposed to just hidden). With
// keep-alive off, leaving Live tears it down at once, so the indicator goes
// transparent right away instead of waiting out a real keep-alive window.
test('with keep-alive off, leaving Live turns the indicator idle', async ({ page }) => {
  await setKeepAlive(page, 0);
  await page.goto('/app/live');
  const video = page.locator('[data-testid="live-video"]:visible');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState >= 2), { timeout: 15_000 }).toBe(true);
  await expect(page.getByTestId('stream-indicator')).toHaveAttribute('data-state', 'streaming');

  await page.getByTestId('sidebar').getByTestId('nav-settings').click();
  await expect(page.getByTestId('settings-card-prefs')).toBeVisible();
  await expect(page.getByTestId('stream-indicator')).toHaveAttribute('data-state', 'idle');
});

// Fix round 1, item 9: hidden Live (kept mounted for the keep-alive) must
// not keep playing audio the viewer never asked for, and the viewer's own
// mute choice must come back once Live is visible again.
test('hidden Live is muted, and unmuted again on return', async ({ page }) => {
  await setKeepAlive(page, 60);
  await page.goto('/app/live');
  const video = page.locator('[data-testid="live-video"]:visible');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState >= 2), { timeout: 15_000 }).toBe(true);

  // Unmute: the viewer's own choice.
  await page.getByTestId('mute-toggle').click();
  await expect(page.getByTestId('mute-toggle')).toHaveAttribute('aria-pressed', 'true');
  expect(await video.evaluate((v: HTMLVideoElement) => v.muted)).toBe(false);

  await page.getByTestId('sidebar').getByTestId('nav-settings').click();
  await expect(page.getByTestId('settings-card-prefs')).toBeVisible();
  // The same (hidden) <video> element is muted while nobody can see Live.
  const hidden = page.locator('[data-testid="live-video"]');
  await expect(hidden).toBeHidden();
  await expect.poll(() => hidden.evaluate((v: HTMLVideoElement) => v.muted), { timeout: 2_000 }).toBe(true);

  await page.getByTestId('sidebar').getByTestId('nav-live').click();
  await expect(page.getByTestId('page-title')).toHaveText('Live');
  // Unmuted again: the earlier choice came back, not a fresh `muted: true`.
  await expect(page.getByTestId('mute-toggle')).toHaveAttribute('aria-pressed', 'true');
  expect(await video.evaluate((v: HTMLVideoElement) => v.muted)).toBe(false);
});

// Fix round 1, item 11: the expiry path (App unmounts Live once the
// keep-alive countdown, restarted by a live preference change while away,
// runs out) is otherwise never exercised end to end. Setting keep-alive
// through the actual Settings UI (not the API directly) also exercises the
// preferences store update that drives App's countdown.
test('turning keep-alive off in Settings while Live is hidden ends the stream', async ({ page }) => {
  await setKeepAlive(page, 60);
  const streams = watchStreams(page);
  await page.goto('/app/live');
  const video = page.locator('[data-testid="live-video"]:visible');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState >= 2), { timeout: 15_000 }).toBe(true);
  expect(streams.open()).toBe(1);

  await page.getByTestId('sidebar').getByTestId('nav-settings').click();
  await expect(page.getByTestId('settings-card-prefs')).toBeVisible();
  await expect(page.getByTestId('live-video')).toBeHidden(); // still kept alive, hidden

  await page.getByTestId('pref-keepalive').selectOption('0');
  await page.getByTestId('save-prefs').click();
  await expect(page.getByTestId('settings-card-prefs').getByTestId('save-state')).toHaveText('Saved', { timeout: 5_000 });

  await expect.poll(() => streams.open(), { timeout: 5_000 }).toBe(0);
  await expect(page.locator('video')).toHaveCount(0);

  await setKeepAlive(page, 60); // restore, in case afterAll doesn't run
});

// A hidden tab (or minimised window) is off-screen too: with keep-alive off,
// hiding the tab while on Live closes the stream, and showing it again
// reconnects. Playwright can't really hide a tab, so the test overrides
// document.visibilityState and fires visibilitychange, as a browser does.
async function setTabHidden(page: Page, hidden: boolean) {
  await page.evaluate((h) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

test('a hidden tab counts as off-screen: keep-alive off closes the stream, showing the tab reconnects', async ({ page }) => {
  await setKeepAlive(page, 0);
  const streams = watchStreams(page);
  await page.goto('/app/live');
  const video = page.locator('[data-testid="live-video"]:visible');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState >= 2), { timeout: 15_000 }).toBe(true);
  expect(streams.open()).toBe(1);

  await setTabHidden(page, true);
  await expect.poll(() => streams.open(), { timeout: 5_000 }).toBe(0);

  await setTabHidden(page, false);
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState >= 2), { timeout: 15_000 }).toBe(true);
  expect(streams.open()).toBe(1);
  await setKeepAlive(page, 60); // restore, in case afterAll doesn't run
});

test('a hidden tab within the keep-alive keeps the same stream', async ({ page }) => {
  await setKeepAlive(page, 60);
  const streams = watchStreams(page);
  await page.goto('/app/live');
  const video = page.locator('[data-testid="live-video"]:visible');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState >= 2), { timeout: 15_000 }).toBe(true);
  const opened = streams.opened.length;
  // Unmuted by the viewer; a hidden tab still mutes it (off-screen means
  // another page OR a hidden tab), and showing the tab brings the sound back.
  await page.getByTestId('mute-toggle').click();
  expect(await video.evaluate((v: HTMLVideoElement) => v.muted)).toBe(false);
  await setTabHidden(page, true);
  const player = page.locator('[data-testid="live-video"]');
  await expect.poll(() => player.evaluate((v: HTMLVideoElement) => v.muted), { timeout: 2_000 }).toBe(true);
  await page.waitForTimeout(500); // nothing should happen to the stream; prove it didn't
  await setTabHidden(page, false);
  await expect.poll(() => player.evaluate((v: HTMLVideoElement) => v.muted), { timeout: 2_000 }).toBe(false);
  expect(streams.opened.length).toBe(opened);
  expect(streams.open()).toBe(1);
});

