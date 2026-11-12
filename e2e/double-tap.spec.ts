import { expect, test, type Page } from '@playwright/test';
import { signIn } from './session';
import { chicagoMs } from './fakeProxyData';
import { centreOf, doubleTap } from './touch';
import { event, shownAt, stubDay, YESTERDAY } from './stubDay';

// Double tap, double click (Klaus, 2026-11-05): on the picture at 1x it
// enters fullscreen, the Fullscreen button's way ("fill the screen" without
// element fullscreen). In fullscreen a double tap in the middle third (a
// double click anywhere, with the mouse) leaves; the middle's single tap
// waits for the double-tap window and then plays or pauses once; the side
// thirds step on every tap. Esc and the button still leave.
test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL!);
});

const badge = (page: Page) => page.getByTestId('mode-badge');
const overlay = (page: Page) => page.getByTestId('fs-overlay');
const fsElement = (page: Page) => page.evaluate(() => !!document.fullscreenElement);
// Clicks that reach the page outside the fullscreen overlay. The double tap
// that leaves fullscreen gets its second tap's click after the overlay may be
// gone (a slow phone; CI 2026-11-11): it must not press what is under it then
// ("Show in Timeline" at the centre, which left the video page).
const countPageClicks = (page: Page) => page.evaluate(() => {
  const w = window as { pageClicks?: number };
  w.pageClicks = 0;
  document.addEventListener('click', (e) => {
    if (!(e.target instanceof Element && e.target.closest('[data-testid="fs-overlay"]'))) w.pageClicks! += 1;
  }, true);
});
const pageClicks = (page: Page) => page.evaluate(() => (window as { pageClicks?: number }).pageClicks ?? 0);

async function withoutElementFullscreen(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(Document.prototype, 'fullscreenEnabled', { configurable: true, get: () => false });
    Object.defineProperty(Document.prototype, 'webkitFullscreenEnabled', { configurable: true, get: () => false });
    delete (Element.prototype as { requestFullscreen?: unknown }).requestFullscreen;
    delete (Element.prototype as { webkitRequestFullscreen?: unknown }).webkitRequestFullscreen;
  });
}

async function open(page: Page) {
  const date = YESTERDAY();
  await stubDay(page, date, [event(date, '10:00:00', '10:00:25', 'person'), event(date, '10:00:25', '10:00:50', 'vehicle')]);
  const at = chicagoMs(date, '10:00:05');
  await page.goto(`/app/video?cam=cam1&date=${date}&at=${at / 1000}`);
  await expect(badge(page)).toHaveAttribute('data-mode', 'rec');
  await expect.poll(() => page.getByTestId('clip-video').evaluate((v: HTMLVideoElement) => v.readyState >= 2), { timeout: 15_000 }).toBe(true);
  return { date, at };
}

test('desktop: a double click enters and leaves fullscreen; one click plays or pauses once', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'the mouse: the desktop');
  await open(page);
  const box = await centreOf(page.getByTestId('player-box'));
  await page.mouse.dblclick(box.x, box.y);
  await expect.poll(() => fsElement(page)).toBe(true);
  await expect(overlay(page)).toHaveAttribute('data-kind', 'element');
  const vp = page.viewportSize()!;
  // One click: plays, once, after the double-click window; no flicker.
  const presses: string[] = [];
  await page.exposeFunction('pressed', (v: string) => presses.push(v));
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="play-toggle"]')!;
    new MutationObserver(() => (window as unknown as { pressed: (v: string) => void }).pressed(el.getAttribute('aria-pressed')!)).observe(el, { attributes: true, attributeFilter: ['aria-pressed'] });
  });
  await page.mouse.click(vp.width / 2, vp.height / 2);
  await expect(page.getByTestId('fs-play')).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(600);
  expect(presses).toEqual(['true']);
  // A double click leaves, and doesn't pause or play.
  await page.mouse.dblclick(vp.width / 2, vp.height / 2);
  await expect.poll(() => fsElement(page)).toBe(false);
  await expect(overlay(page)).toHaveCount(0);
  await page.waitForTimeout(800); // not entered again by the same double click
  expect(await fsElement(page)).toBe(false);
  expect(presses).toEqual(['true']);
  await page.getByTestId('play-toggle').click(); // pause
  // Esc and the button still leave.
  await page.mouse.dblclick(box.x, box.y);
  await expect.poll(() => fsElement(page)).toBe(true);
  await page.keyboard.press('Escape');
  await expect.poll(() => fsElement(page)).toBe(false);
  await page.waitForTimeout(700);
  await page.mouse.dblclick(box.x, box.y);
  await expect.poll(() => fsElement(page)).toBe(true);
  await page.getByTestId('fs-exit').click();
  await expect.poll(() => fsElement(page)).toBe(false);
});

test('phone: a double tap fills the screen; the sides step on each tap, the middle plays once, a double tap there leaves', async ({ page }) => {
  test.skip(test.info().project.name !== 'phone', 'touch: the phone');
  await withoutElementFullscreen(page);
  const { date, at } = await open(page);
  await doubleTap(page, await centreOf(page.getByTestId('player-box')));
  await expect(overlay(page)).toHaveAttribute('data-kind', 'fill');
  const vp = page.viewportSize()!;
  const y = vp.height / 2;
  let moves = 0;
  const keepControlsUp = () => page.mouse.move(100 + (moves++ % 2), 40);
  // Fast taps on the right third: a step each, no waiting.
  await keepControlsUp();
  await doubleTap(page, { x: vp.width * 0.85, y });
  await expect.poll(() => shownAt(page, date)).toBe(at + 20_000);
  await expect(overlay(page)).toHaveAttribute('data-kind', 'fill');
  // One tap in the middle: plays, once.
  await keepControlsUp();
  await page.touchscreen.tap(vp.width / 2, y);
  await expect(page.getByTestId('fs-play')).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(600);
  await expect(page.getByTestId('fs-play')).toHaveAttribute('aria-pressed', 'true');
  // A double tap in the middle: leaves, still playing.
  await keepControlsUp();
  await countPageClicks(page);
  await doubleTap(page, { x: vp.width / 2, y });
  await expect(overlay(page)).toHaveCount(0);
  await page.waitForTimeout(700);
  expect(await pageClicks(page)).toBe(0);
  await expect(page).toHaveURL(/\/app\/video\?/);
  await expect(page.getByTestId('play-toggle')).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(800);
  await expect(overlay(page)).toHaveCount(0); // not entered again
  await expect(page.getByTestId('play-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(badge(page)).toHaveAttribute('data-mode', 'rec');
});

test('phone: element fullscreen too, by a double tap, and out again', async ({ page }) => {
  test.skip(test.info().project.name !== 'phone', 'touch: the phone');
  await open(page);
  await doubleTap(page, await centreOf(page.getByTestId('player-box')));
  await expect.poll(() => fsElement(page)).toBe(true);
  const vp = page.viewportSize()!;
  await countPageClicks(page);
  await doubleTap(page, { x: vp.width / 2, y: vp.height / 2 });
  await expect.poll(() => fsElement(page)).toBe(false);
  await page.waitForTimeout(800);
  expect(await fsElement(page)).toBe(false);
  expect(await pageClicks(page)).toBe(0);
  await expect(page).toHaveURL(/\/app\/video\?/);
  await expect(page.getByTestId('play-toggle')).toHaveAttribute('aria-pressed', 'false');
});

test('live: a double tap or double click on the picture enters fullscreen there too', async ({ page }) => {
  await withoutElementFullscreen(page);
  await page.goto('/app/video');
  await expect(badge(page)).toHaveAttribute('data-mode', 'live');
  const box = await centreOf(page.getByTestId('player-box'));
  if (test.info().project.name === 'phone') await doubleTap(page, box);
  else await page.mouse.dblclick(box.x, box.y);
  await expect(overlay(page)).toHaveAttribute('data-kind', 'fill');
  await expect(badge(page)).toHaveAttribute('data-mode', 'live');
});
