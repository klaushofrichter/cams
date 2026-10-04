import { mkdirSync } from 'fs';
import { join } from 'path';
import { expect, test, type Page } from '@playwright/test';
import { signIn } from './session';
import { chicagoMs } from './fakeProxyData';

// Fullscreen for every mode (#182, spec
// docs/superpowers/specs/2026-10-04-fullscreen-recorded-design.md): the
// player box goes fullscreen, so the mode badge shows in live too; a
// recording gets the overlay's steps, keys and gestures; without element
// fullscreen (iPhone) the box fills the screen.
test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL!);
});

const chicagoToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const badge = (page: Page) => page.getByTestId('mode-badge');
const urlAt = (page: Page) => Number(new URL(page.url()).searchParams.get('at'));
const current = (page: Page) => page.locator('[data-testid="event-card"][aria-current="true"]');
// Den's 12:05:05 motion clip (CDT), 1 s in: its video is shorter than the
// clip's 25 s, so the steps stay in its first 12 s.
const clipAt = () => chicagoMs(chicagoToday(), '12:05:06');
// The URL follows the video's own time while a clip is on screen: within a few frames.
const near = async (page: Page, want: number) => expect.poll(() => Math.abs(urlAt(page) - want)).toBeLessThan(300);

// Screenshots for the PR review, only when asked (FS_SHOTS=<dir>).
async function shot(page: Page, name: string) {
  const dir = process.env.FS_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`) });
}

// No element fullscreen, as on an iPhone (every browser there is WebKit).
async function withoutElementFullscreen(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(Document.prototype, 'fullscreenEnabled', { configurable: true, get: () => false });
    Object.defineProperty(Document.prototype, 'webkitFullscreenEnabled', { configurable: true, get: () => false });
    delete (Element.prototype as { requestFullscreen?: unknown }).requestFullscreen;
    delete (Element.prototype as { webkitRequestFullscreen?: unknown }).webkitRequestFullscreen;
  });
}

// A one-finger stroke through Chromium's touch input (pointer events with
// pointerType "touch").
async function swipe(page: Page, x0: number, x1: number, y: number) {
  const cdp = await page.context().newCDPSession(page);
  const point = (x: number) => [{ x, y, id: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(x0) });
  for (let i = 1; i <= 5; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(x0 + ((x1 - x0) * i) / 5) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

test('live fullscreen shows the ● LIVE badge (it was outside the fullscreen element)', async ({ page }) => {
  await page.goto('/app/video');
  await expect(badge(page)).toHaveText('● LIVE', { timeout: 15_000 });
  await page.getByTestId('fullscreen').click();
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);
  expect(await page.evaluate(() => document.fullscreenElement!.contains(document.querySelector('[data-testid="mode-badge"]')))).toBe(true);
  expect(await page.evaluate(() => document.fullscreenElement!.contains(document.querySelector('[data-testid="live-video"]')))).toBe(true);
  await expect(badge(page)).toBeVisible();
  await expect(badge(page)).toHaveText('● LIVE');
  await expect(page.getByTestId('fs-overlay')).toHaveAttribute('data-shown', 'true');
  const vp = page.viewportSize()!;
  expect((await page.getByTestId('live-video').boundingBox())!.height).toBeCloseTo(vp.height, 0);
  await shot(page, `${test.info().project.name}-live-fullscreen`);
  // Stepping back from live stays fullscreen, now a recording.
  await page.getByTestId('fs-back-10').click();
  await expect(badge(page)).toHaveAttribute('data-mode', 'rec');
  expect(await page.evaluate(() => !!document.fullscreenElement)).toBe(true);
  await page.getByTestId('fs-live').click();
  await expect(badge(page)).toHaveAttribute('data-mode', 'live');
  await page.getByTestId('fs-exit').click();
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false);
  await expect(page.getByTestId('fs-overlay')).toHaveCount(0);
});

test('recorded fullscreen: keys and buttons step 1 s and 10 s, [ ] jump events, the overlay hides', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'keys: the desktop');
  const at = clipAt();
  await page.goto(`/app/video?cam=cam1&date=${chicagoToday()}&at=${at}`);
  await expect(badge(page)).toHaveText(/^REC .* · SD$/);
  const fs = page.getByTestId('fullscreen');
  await expect(fs).not.toHaveAttribute('aria-disabled', 'true'); // no "only in live mode" any more
  await fs.click();
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);
  expect(await page.evaluate(() => document.fullscreenElement!.contains(document.querySelector('[data-testid="mode-badge"]')))).toBe(true);
  await expect(page.getByTestId('fs-overlay')).toHaveAttribute('data-shown', 'true');
  await expect.poll(() => page.getByTestId('clip-video').evaluate((v: HTMLVideoElement) => v.readyState >= 2), { timeout: 15_000 }).toBe(true);
  await shot(page, 'desktop-recorded-fullscreen-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'desktop-recorded-fullscreen-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('fs-hint')).toHaveText('+10 s');
  await near(page, at + 10_000);
  await page.keyboard.press('Shift+ArrowLeft');
  await near(page, at + 9000);
  await page.getByTestId('fs-fwd-1').click();
  await near(page, at + 10_000);
  await page.getByTestId('fs-back-10').click();
  await near(page, at);

  await expect(current(page)).toHaveAttribute('data-clip-id', /-120505-/);
  await page.keyboard.press('[');
  await expect(current(page)).not.toHaveAttribute('data-clip-id', /-120505-/);
  const prev = await current(page).getAttribute('data-clip-id');
  await page.keyboard.press(']');
  await expect(current(page)).toHaveAttribute('data-clip-id', /-120505-/);
  await page.getByTestId('fs-prev-event').click();
  await expect(current(page)).toHaveAttribute('data-clip-id', prev!);
  await page.keyboard.press('PageDown');
  await expect(current(page)).toHaveAttribute('data-clip-id', /-120505-/);

  // 3 s without input: the controls hide; the badge stays.
  await expect(page.getByTestId('fs-overlay')).toHaveAttribute('data-shown', 'false', { timeout: 6000 });
  await expect(badge(page)).toBeVisible();
  await page.mouse.move(400, 300);
  await page.mouse.move(420, 320);
  await expect(page.getByTestId('fs-overlay')).toHaveAttribute('data-shown', 'true');
  // Space plays and pauses, even with the focus on one of the overlay's buttons.
  await page.keyboard.press('Space');
  await expect(page.getByTestId('fs-play')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('fs-hint')).toHaveText('▶');
  await page.keyboard.press('Space');
  await expect(page.getByTestId('fs-play')).toHaveAttribute('aria-pressed', 'false');
  await expect(current(page)).toHaveAttribute('data-clip-id', /-120505-/); // the focused ⏮ wasn't pressed
  await page.getByTestId('fs-exit').click();
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false);
});

test('Space plays at once after entering fullscreen (the focus leaves the sidebar button)', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'keys: the desktop');
  await page.goto(`/app/video?cam=cam1&date=${chicagoToday()}&at=${clipAt()}`);
  await expect(badge(page)).toHaveText(/^REC .* · SD$/);
  await page.getByTestId('fullscreen').click();
  await expect(page.getByTestId('fs-overlay')).toBeFocused();
  await page.keyboard.press('Space');
  await expect(page.getByTestId('fs-play')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('play-toggle')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Space');
  await expect(page.getByTestId('fs-play')).toHaveAttribute('aria-pressed', 'false');
});

// Review of #185: the page outside the player is inert while fullscreen,
// so Tab stays in the player and a key does one thing; leaving gives the
// focus back to the Fullscreen button.
test('Tab stays in the fullscreen player, one key is one step, and the focus comes back', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'keys: the desktop');
  const at = clipAt();
  await page.goto(`/app/video?cam=cam1&date=${chicagoToday()}&at=${at}`);
  await expect(badge(page)).toHaveText(/^REC .* · SD$/);
  await page.getByTestId('fullscreen').click();
  await expect(page.getByTestId('fs-overlay')).toBeFocused();
  expect(await page.getByTestId('strip-now').evaluate((el) => !!el.closest('[inert]'))).toBe(true);
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.fullscreenElement?.contains(document.activeElement))).toBe(true);
  }
  await page.getByTestId('fs-overlay').focus();
  await page.keyboard.press('ArrowRight');
  await near(page, at + 10_000);
  await page.waitForTimeout(500);
  await near(page, at + 10_000); // not 20 s, not another event
  await expect(current(page)).toHaveAttribute('data-clip-id', /-120505-/);
  await page.getByTestId('fs-exit').click();
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false);
  await expect(page.getByTestId('fullscreen')).toBeFocused();
  expect(await page.getByTestId('strip-now').evaluate((el) => !!el.closest('[inert]'))).toBe(false);
});

test('without element fullscreen the player fills the screen: live with its badge, Back leaves', async ({ page }) => {
  await withoutElementFullscreen(page);
  await page.goto('/app/video');
  await expect(badge(page)).toHaveText('● LIVE', { timeout: 15_000 });
  await page.getByTestId('fullscreen').click();
  const overlay = page.getByTestId('fs-overlay');
  await expect(overlay).toHaveAttribute('data-kind', 'fill');
  const vp = page.viewportSize()!;
  const box = (await overlay.boundingBox())!;
  expect(box).toEqual({ x: 0, y: 0, width: vp.width, height: vp.height });
  const b = (await badge(page).boundingBox())!;
  expect(b.y).toBeLessThan(40);
  expect(b.x + b.width).toBeLessThanOrEqual(vp.width);
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight || getComputedStyle(document.documentElement).overflow === 'hidden')).toBe(true);
  // The live stream fills it too, centred (its own stage is 16:9).
  const v = (await page.getByTestId('live-video').boundingBox())!;
  expect(v.height).toBeCloseTo(vp.height, 0);
  await shot(page, `${test.info().project.name}-fill-live`);
  await page.goBack();
  await expect(overlay).toHaveCount(0);
  await expect(page).toHaveURL(/\/app\/video$/);
  await expect(badge(page)).toHaveAttribute('data-mode', 'live');
});

test('fill the screen, a recording on a phone: taps by third, swipes, Back keeps the position', async ({ page }) => {
  test.skip(test.info().project.name !== 'phone', 'touch: the phone');
  await withoutElementFullscreen(page);
  const at = clipAt();
  await page.goto(`/app/video?cam=cam1&date=${chicagoToday()}&at=${at}`);
  await expect(badge(page)).toHaveText(/^REC .* · SD$/);
  await page.getByTestId('fullscreen').click();
  const overlay = page.getByTestId('fs-overlay');
  await expect(overlay).toHaveAttribute('data-kind', 'fill');
  const vp = page.viewportSize()!;
  // The controls in one row, inside the screen, even in portrait.
  const first = (await page.getByTestId('fs-prev-event').boundingBox())!;
  const last = (await page.getByTestId('fs-exit').boundingBox())!;
  expect(Math.abs(first.y - last.y)).toBeLessThan(2);
  expect(first.x).toBeGreaterThanOrEqual(0);
  expect(last.x + last.width).toBeLessThanOrEqual(vp.width);
  await expect.poll(() => page.getByTestId('clip-video').evaluate((v: HTMLVideoElement) => v.readyState >= 2), { timeout: 15_000 }).toBe(true);
  await shot(page, 'phone-fill-recorded-portrait-light');
  const y = vp.height / 2;
  // The overlay shows on entering: a tap on the right third acts at once.
  await page.touchscreen.tap(vp.width * 0.85, y);
  await expect(page.getByTestId('fs-hint')).toHaveText('+10 s');
  await near(page, at + 10_000);
  await page.touchscreen.tap(vp.width * 0.15, y);
  await near(page, at);
  await swipe(page, vp.width * 0.6, vp.width * 0.3, y); // left: 1 s forward
  await expect(page.getByTestId('fs-hint')).toHaveText('+1 s');
  await near(page, at + 1000);
  await swipe(page, vp.width * 0.3, vp.width * 0.6, y); // right: 1 s back
  await near(page, at);
  await swipe(page, 4, vp.width * 0.5, y); // from the edge: the system's
  await page.waitForTimeout(300);
  expect(Math.abs(urlAt(page) - at)).toBeLessThan(300);
  // Hidden after 3 s: the first tap only shows the controls.
  await expect(overlay).toHaveAttribute('data-shown', 'false', { timeout: 6000 });
  await page.touchscreen.tap(vp.width * 0.85, y);
  await expect(overlay).toHaveAttribute('data-shown', 'true');
  await page.waitForTimeout(300);
  expect(Math.abs(urlAt(page) - at)).toBeLessThan(300);
  // Landscape, light and dark.
  await page.setViewportSize({ width: vp.height, height: vp.width });
  await expect.poll(async () => (await overlay.boundingBox())!.width).toBe(vp.height);
  await page.touchscreen.tap(vp.height * 0.5, 40); // show the controls
  await shot(page, 'phone-fill-recorded-landscape-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'phone-fill-recorded-landscape-dark');
  await page.setViewportSize(vp);
  // Back leaves fill mode and stays at the moment shown.
  await page.getByTestId('fs-fwd-10').click();
  await near(page, at + 10_000);
  await page.goBack();
  await expect(overlay).toHaveCount(0);
  await near(page, at + 10_000);
  await expect(badge(page)).toHaveAttribute('data-mode', 'rec');
  // And the exit button.
  await page.getByTestId('fullscreen').click();
  await expect(overlay).toHaveAttribute('data-kind', 'fill');
  await page.getByTestId('fs-exit').click();
  await expect(overlay).toHaveCount(0);
  await expect(page.getByTestId('fullscreen')).toBeFocused(); // the focus comes back
  await near(page, at + 10_000);
});
