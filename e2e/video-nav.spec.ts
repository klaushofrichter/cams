import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { signIn } from './session';
import { chicagoMs } from './fakeProxyData';
import { event, shownAt as shown, stubDay, urlAt, YESTERDAY } from './stubDay';

// The Video page's URL and the menu (Klaus, 2026-11-05): the timeline's zoom
// is in the link (`zoom=`), the menu's Video entry comes back to the tab's
// last Video state (camera, moment, zoom, play or pause, live), and the
// brand link in the top bar goes live.
test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL!);
});

const badge = (page: Page) => page.getByTestId('mode-badge');
const play = (page: Page) => page.getByTestId('play-toggle');
const zoomParam = (page: Page) => new URL(page.url()).searchParams.get('zoom');
function setup(page: Page) {
  const date = YESTERDAY();
  const a = event(date, '10:00:00', '10:00:25', 'person');
  const b = event(date, '10:00:25', '10:00:50', 'vehicle');
  return stubDay(page, date, [a, b]).then(() => ({ date, a, b }));
}
// The menu: the sidebar, or on a phone the drawer.
async function nav(page: Page, testInfo: TestInfo, id: string) {
  if (testInfo.project.name === 'phone') {
    await page.getByTestId('hamburger').click();
    await page.getByTestId('drawer').getByTestId(id).click();
    await expect(page.getByTestId('drawer')).toHaveCount(0);
  } else {
    await page.getByTestId('sidebar').getByTestId(id).click();
  }
}
async function prefZoom(page: Page): Promise<number> {
  return (await (await page.request.get('/api/preferences')).json()).timelineZoom;
}

test('the zoom goes into the URL; picking another replaces it there, without a history entry', async ({ page }) => {
  const { date } = await setup(page);
  const at = chicagoMs(date, '10:00:05') / 1000;
  await page.goto(`/app/video?cam=cam1&date=${date}&at=${at}`); // an older link: no zoom
  await expect(badge(page)).toHaveAttribute('data-mode', 'rec');
  // The saved preference, as before, and the URL says so.
  const pref = await prefZoom(page);
  await expect(page.locator('[data-testid^="zoom-"][aria-pressed="true"]')).toHaveCount(1);
  await expect.poll(() => zoomParam(page)).toMatch(/^\d+[hm]$/);
  expect(pref).toBeGreaterThan(0);
  const entries = await page.evaluate(() => history.length);
  await page.getByTestId('zoom-1').click();
  await expect.poll(() => zoomParam(page)).toBe('1h');
  await page.getByTestId('zoom-10m').click();
  await expect.poll(() => zoomParam(page)).toBe('10m');
  expect(await page.evaluate(() => history.length)).toBe(entries);
  expect(urlAt(page.url())).toBe(at * 1000); // the moment stays
  // A reload keeps it.
  await page.reload();
  await expect(page.getByTestId('zoom-10m')).toHaveAttribute('aria-pressed', 'true');
});

test('a link with a zoom opens with it, over the saved preference, which stays', async ({ page }) => {
  const { date } = await setup(page);
  const at = chicagoMs(date, '10:00:05') / 1000;
  const pref = await prefZoom(page);
  await page.goto(`/app/video?cam=cam1&date=${date}&at=${at}&zoom=30m`);
  await expect(badge(page)).toHaveAttribute('data-mode', 'rec');
  await expect(page.getByTestId('zoom-30m')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => shown(page, date)).toBe(at * 1000);
  expect(zoomParam(page)).toBe('30m');
  expect(await prefZoom(page)).toBe(pref);
  // A zoom the strip doesn't offer: the preference, as without one.
  await page.goto(`/app/video?cam=cam1&date=${date}&at=${at}&zoom=12h`);
  await expect(badge(page)).toHaveAttribute('data-mode', 'rec');
  await expect.poll(() => zoomParam(page)).not.toBe('12h');
});

test('Video, About, Video keeps the camera, the moment, the zoom and pause', async ({ page }, testInfo) => {
  const { date } = await setup(page);
  const at = chicagoMs(date, '10:00:05');
  await page.goto(`/app/video?cam=cam1&date=${date}&at=${at / 1000}&zoom=1h`);
  await expect(badge(page)).toHaveAttribute('data-mode', 'rec');
  await page.getByTestId('fwd-10').click();
  await expect.poll(() => shown(page, date)).toBe(at + 10_000);
  await page.getByTestId('zoom-3').click();
  await expect.poll(() => zoomParam(page)).toBe('3h');
  await expect.poll(() => urlAt(page.url())).toBe(at + 10_000);
  const href = page.url();

  await nav(page, testInfo, 'nav-about');
  await expect(page.getByTestId('page-title')).toHaveText('About');
  await nav(page, testInfo, 'nav-video');
  await expect(page.getByTestId('page-title')).toHaveText('Video');
  await expect(badge(page)).toHaveAttribute('data-mode', 'rec');
  expect(page.url()).toBe(href);
  await expect(page.getByTestId('camera-picker')).toHaveValue('cam1');
  await expect(page.getByTestId('zoom-3')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => shown(page, date)).toBe(at + 10_000);
  await expect(play(page)).toHaveAttribute('aria-pressed', 'false');

  // Back and Forward: About, then the Video page before it.
  await page.goBack();
  await expect(page).toHaveURL(/\/app\/about$/);
  await page.goBack();
  await expect(badge(page)).toHaveAttribute('data-mode', 'rec');
  await expect.poll(() => urlAt(page.url())).toBe(at + 10_000);
  await page.goForward();
  await expect(page).toHaveURL(/\/app\/about$/);
  await page.goForward();
  expect(page.url()).toBe(href);
});

test('a move just before leaving is kept, though the URL follows once a second', async ({ page }, testInfo) => {
  const { date } = await setup(page);
  const at = chicagoMs(date, '10:00:05');
  await page.goto(`/app/video?cam=cam1&date=${date}&at=${at / 1000}`);
  await expect(badge(page)).toHaveAttribute('data-mode', 'rec');
  await page.waitForTimeout(1200);
  await page.getByTestId('fwd-10').click();
  await page.getByTestId('fwd-1').click();
  await nav(page, testInfo, 'nav-about');
  await expect(page.getByTestId('page-title')).toHaveText('About');
  await nav(page, testInfo, 'nav-video');
  await expect(badge(page)).toHaveAttribute('data-mode', 'rec');
  await expect.poll(() => shown(page, date)).toBe(at + 11_000);
  expect(urlAt(page.url())).toBe(at + 11_000);
});

test('Video, About, Video goes on playing what was playing', async ({ page }, testInfo) => {
  const { date } = await setup(page);
  const at = chicagoMs(date, '10:00:02');
  await page.goto(`/app/video?cam=cam1&date=${date}&at=${at / 1000}`);
  await expect(badge(page)).toHaveAttribute('data-mode', 'rec');
  await play(page).click();
  await expect.poll(() => shown(page, date), { timeout: 10_000 }).toBeGreaterThanOrEqual(at + 3000);
  await expect(page).toHaveURL(/[?&]play=1(&|$)/);
  const before = await shown(page, date);

  await nav(page, testInfo, 'nav-about');
  await expect(page.getByTestId('page-title')).toHaveText('About');
  await nav(page, testInfo, 'nav-video');
  await expect(badge(page)).toHaveAttribute('data-mode', 'rec');
  await expect(play(page)).toHaveAttribute('aria-pressed', 'true');
  const after = await shown(page, date);
  expect(after).toBeGreaterThanOrEqual(before - 1000);
  expect(after).toBeLessThan(before + 4000);
  await expect.poll(() => shown(page, date), { timeout: 10_000 }).toBeGreaterThan(after);
});

// Left live a moment ago: the page is kept (the live stream's keep-alive)
// behind About. The recording waits there, paused, and plays on after.
test('from live into a recording, Video, About, Video keeps it, paused or playing', async ({ page }, testInfo) => {
  const { date } = await setup(page);
  const at = chicagoMs(date, '10:00:02');
  await page.goto('/app/video');
  await expect(badge(page)).toHaveAttribute('data-mode', 'live');
  // A link followed inside the app (as Back would): the page stays.
  await page.evaluate((h) => {
    history.pushState({}, '', h);
    dispatchEvent(new PopStateEvent('popstate'));
  }, `/app/video?cam=cam1&date=${date}&at=${at / 1000}&zoom=1h`);
  await expect(badge(page)).toHaveAttribute('data-mode', 'rec');
  await expect.poll(() => shown(page, date)).toBe(at);
  await nav(page, testInfo, 'nav-about');
  await expect(page.getByTestId('page-title')).toHaveText('About');
  await expect(page.getByTestId('live-video')).toBeHidden(); // kept, behind About
  await page.waitForTimeout(1500);
  await nav(page, testInfo, 'nav-video');
  await expect(badge(page)).toHaveAttribute('data-mode', 'rec');
  await expect(play(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('zoom-1')).toHaveAttribute('aria-pressed', 'true');
  expect(await shown(page, date)).toBe(at);

  await play(page).click();
  await expect.poll(() => shown(page, date), { timeout: 10_000 }).toBeGreaterThanOrEqual(at + 2000);
  await nav(page, testInfo, 'nav-about');
  await expect(page.getByTestId('page-title')).toHaveText('About');
  await page.waitForTimeout(3000); // not playing on behind About
  await nav(page, testInfo, 'nav-video');
  await expect(badge(page)).toHaveAttribute('data-mode', 'rec');
  await expect(play(page)).toHaveAttribute('aria-pressed', 'true');
  const back = await shown(page, date);
  expect(back).toBeLessThan(at + 6000);
  await expect.poll(() => shown(page, date), { timeout: 10_000 }).toBeGreaterThan(back);
});

test('Video, About, Video stays live', async ({ page }, testInfo) => {
  await page.goto('/app/video');
  await expect(badge(page)).toHaveAttribute('data-mode', 'live');
  await nav(page, testInfo, 'nav-about');
  await expect(page.getByTestId('page-title')).toHaveText('About');
  await nav(page, testInfo, 'nav-video');
  await expect(badge(page)).toHaveAttribute('data-mode', 'live');
  await expect(page).toHaveURL(/\/app\/video$/);
});

test('the brand link goes live and plays, keeps the zoom, and the next menu click stays live', async ({ page }, testInfo) => {
  const { date } = await setup(page);
  const at = chicagoMs(date, '10:00:02');
  await page.goto(`/app/video?cam=cam1&date=${date}&at=${at / 1000}&zoom=1h&play=1`);
  await expect(badge(page)).toHaveAttribute('data-mode', 'rec');
  const entries = await page.evaluate(() => history.length);
  await page.getByTestId('brand-link').click();
  await expect(badge(page)).toHaveAttribute('data-mode', 'live');
  await expect(page).toHaveURL(/\/app\/video$/);
  expect(await page.evaluate(() => history.length)).toBe(entries + 1); // a page load would start a new history
  await expect(page.getByTestId('zoom-1')).toHaveAttribute('aria-pressed', 'true');
  const live = page.locator('[data-testid="live-video"]:visible');
  await expect.poll(() => live.evaluate((v: HTMLVideoElement) => v.readyState >= 2 && !v.paused), { timeout: 15_000 }).toBe(true);

  await nav(page, testInfo, 'nav-about');
  await expect(page.getByTestId('page-title')).toHaveText('About');
  await nav(page, testInfo, 'nav-video');
  await expect(badge(page)).toHaveAttribute('data-mode', 'live');
  await expect(page).toHaveURL(/\/app\/video$/);

  // From another page too.
  await page.getByTestId('back-10').click();
  await expect(badge(page)).toHaveAttribute('data-mode', 'rec');
  await nav(page, testInfo, 'nav-about');
  await page.getByTestId('brand-link').click();
  await expect(page.getByTestId('page-title')).toHaveText('Video');
  await expect(badge(page)).toHaveAttribute('data-mode', 'live');
});
