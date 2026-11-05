import { expect, test, type Page } from '@playwright/test';
import { chicagoMs } from './fakeProxyData';
import { signIn } from './session';
import { centreOf, doubleTap, drag, pageScale, pinch, viewOf } from './touch';

// Pinch-to-zoom on the pictures (lib/pinchZoom.ts, Klaus 2026-11-05): the
// picture zooms inside its frame, the page and its buttons never do. Touch:
// the phone project only.
test.beforeEach(async ({ context, baseURL }) => {
  test.skip(test.info().project.name !== 'phone', 'touch: the phone');
  await signIn(context, baseURL!);
});

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const badge = (page: Page) => page.getByTestId('mode-badge');
const box = (page: Page) => page.getByTestId('player-box');
const clip = (page: Page) => page.getByTestId('clip-video');
const urlAt = (page: Page) => Number(new URL(page.url()).searchParams.get('at'));
// Den's 12:05:05 motion clip, 1 s in (as fullscreen.spec.ts).
const atClip = () => chicagoMs(today(), '12:05:06');

async function openClip(page: Page) {
  await page.goto(`/app/video?cam=cam1&date=${today()}&at=${atClip()}`);
  await expect(badge(page)).toHaveText(/^REC .* · SD$/);
  await expect.poll(() => clip(page).evaluate((v: HTMLVideoElement) => v.readyState >= 2), { timeout: 15_000 }).toBe(true);
}
// The positions of everything around the picture.
const layout = (page: Page) => Promise.all(['player-box', 'mode-badge', 'back-10', 'play-toggle', 'fwd-10', 'strip-info'].map((id) => page.getByTestId(id).boundingBox()));

test('a recorded clip: two fingers zoom the picture alone, one finger pans within it, a double tap resets', async ({ page }) => {
  await openClip(page);
  const before = await layout(page);
  const at = await centreOf(box(page));
  await pinch(page, at, 60, 180);
  const zoomed = await viewOf(clip(page));
  expect(zoomed.s).toBeCloseTo(3, 0);
  // Centred between the fingers: the middle stays in the middle.
  const size = (await box(page).boundingBox())!;
  expect(zoomed.x + zoomed.s * (size.width / 2)).toBeCloseTo(size.width / 2, 0);
  expect(await pageScale(page)).toBe(1);
  expect(await layout(page)).toEqual(before);
  // The badge and the controls aren't transformed.
  expect((await viewOf(badge(page))).s).toBe(1);

  // Pan: with the finger, and no further than the picture's edge.
  await drag(page, at, { x: at.x + 40, y: at.y });
  const panned = await viewOf(clip(page));
  expect(panned.x).toBeCloseTo(zoomed.x + 40, 0);
  for (let i = 0; i < 3; i++) await drag(page, { x: 20, y: at.y }, { x: 370, y: at.y });
  // The picture's own edges, not the box's: the test clip isn't quite 16:9.
  const [vw, vh] = await clip(page).evaluate((e: HTMLVideoElement) => [e.videoWidth, e.videoHeight]);
  const drawnW = vw * Math.min(size.width / vw, size.height / vh);
  const barW = (size.width - drawnW) / 2;
  const left = await viewOf(clip(page));
  expect(left.x + left.s * barW).toBeCloseTo(0, 1);
  for (let i = 0; i < 4; i++) await drag(page, { x: 370, y: at.y }, { x: 20, y: at.y });
  const right = await viewOf(clip(page));
  expect(right.x + right.s * (barW + drawnW)).toBeCloseTo(size.width, 1);
  expect(await layout(page)).toEqual(before);

  await doubleTap(page, at);
  await expect.poll(async () => (await viewOf(clip(page))).s).toBe(1);
  expect(await pageScale(page)).toBe(1);
});

test('5x is the most, and pinching back to 1x resets', async ({ page }) => {
  await openClip(page);
  const at = await centreOf(box(page));
  await pinch(page, at, 30, 330);
  expect((await viewOf(clip(page))).s).toBe(5);
  await pinch(page, at, 330, 30);
  const back = await viewOf(clip(page));
  expect(back).toEqual({ s: 1, x: 0, y: 0 });
  expect(await box(page).evaluate((b) => b.style.touchAction)).toBe('');
});

test('live: the <video> zooms, the LIVE badge does not; going to a recording resets it', async ({ page }) => {
  await page.goto('/app/video?cam=cam1');
  await expect(badge(page)).toHaveText('● LIVE', { timeout: 15_000 });
  const video = page.getByTestId('live-video');
  await expect(video).toBeVisible();
  const before = await layout(page);
  await pinch(page, await centreOf(box(page)), 60, 180);
  expect((await viewOf(video)).s).toBeGreaterThan(2);
  expect((await viewOf(badge(page))).s).toBe(1);
  expect(await pageScale(page)).toBe(1);
  expect(await layout(page)).toEqual(before);
  // Both of the stream's elements, whichever plays next.
  for (const v of await page.locator('[data-testid="player-box"] .stage video').all()) expect((await viewOf(v)).s).toBeGreaterThan(2);

  await page.getByTestId('back-10').click();
  await expect(badge(page)).toHaveAttribute('data-mode', 'rec');
  await expect.poll(async () => (await viewOf(video)).s).toBe(1);
});

test('another clip resets the zoom, a step inside the clip does not', async ({ page }) => {
  await openClip(page);
  await pinch(page, await centreOf(box(page)), 60, 180);
  await page.getByTestId('fwd-1').click();
  await expect.poll(() => urlAt(page) - atClip(), { timeout: 5000 }).toBeGreaterThan(500);
  expect((await viewOf(clip(page))).s).toBeGreaterThan(2);
  const other = page.locator('[data-testid="event-card"]:not([aria-current="true"])').first();
  await other.click();
  await expect.poll(async () => (await box(page).evaluate((b) => b.style.getPropertyValue('--media-zoom')))).toBe('');
});

test('at 1x one finger on the picture still scrolls the page; zoomed it pans instead', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 420 });
  await openClip(page);
  const scrolled = () => page.evaluate(() => window.scrollY + (document.querySelector('.main')?.scrollTop ?? 0));
  await expect.poll(async () => page.evaluate(() => { const m = document.querySelector('.main')!; return Math.max(m.scrollHeight - m.clientHeight, document.documentElement.scrollHeight - innerHeight); })).toBeGreaterThan(100);
  const at = await centreOf(box(page));
  const start = await scrolled();
  await drag(page, at, { x: at.x, y: at.y - 80 }, 10);
  await expect.poll(scrolled).toBeGreaterThan(start + 30);
  expect((await viewOf(clip(page))).s).toBe(1);

  // The fling has ended: a finger landing on a moving page is the page's.
  let last = -1;
  await expect.poll(async () => { const n = await scrolled(); const same = n === last; last = n; return same; }, { intervals: [200] }).toBe(true);
  const at2 = await centreOf(box(page));
  await pinch(page, at2, 60, 180);
  expect((await viewOf(clip(page))).s).toBeGreaterThan(2);
  const held = await scrolled();
  const was = await viewOf(clip(page));
  await drag(page, at2, { x: at2.x, y: at2.y - 40 }, 10);
  await page.waitForTimeout(150);
  expect(await scrolled()).toBe(held);
  expect((await viewOf(clip(page))).y).toBeLessThan(was.y);
});

test('thumbnails do not zoom, and their cards still answer a tap', async ({ page }) => {
  await openClip(page);
  const thumb = page.getByTestId('event-thumb').first();
  await thumb.scrollIntoViewIfNeeded();
  await expect(thumb).toBeVisible();
  await pinch(page, await centreOf(thumb), 30, 90);
  expect((await viewOf(thumb)).s).toBe(1);
  expect(await pageScale(page)).toBe(1);
  const card = page.locator('[data-testid="event-card"]:not([aria-current="true"])').first();
  await card.scrollIntoViewIfNeeded();
  const before = urlAt(page);
  const c = await centreOf(card);
  await page.touchscreen.tap(c.x, c.y);
  await expect.poll(() => urlAt(page)).not.toBe(before);
});

// No element fullscreen, as on an iPhone: the box fills the screen.
async function fillScreen(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(Document.prototype, 'fullscreenEnabled', { configurable: true, get: () => false });
    Object.defineProperty(Document.prototype, 'webkitFullscreenEnabled', { configurable: true, get: () => false });
    delete (Element.prototype as { requestFullscreen?: unknown }).requestFullscreen;
    delete (Element.prototype as { webkitRequestFullscreen?: unknown }).webkitRequestFullscreen;
  });
  await openClip(page);
  await page.getByTestId('fullscreen').click();
  await expect(page.getByTestId('fs-overlay')).toHaveAttribute('data-kind', 'fill');
}

test('fill the screen: swipes seek at 1x; a pinch does not, a drag pans, a tap only shows the controls, a double tap resets', async ({ page }) => {
  await fillScreen(page);
  const vp = page.viewportSize()!;
  const mid = { x: vp.width / 2, y: vp.height / 2 };
  const hint = page.getByTestId('fs-hint');
  const shownAt = async () => (await badge(page).textContent())!;
  let moves = 0;
  const keepControlsUp = () => page.mouse.move(100 + (moves++ % 2), 40);

  // 1x: a swipe left is 1 s forward.
  await keepControlsUp();
  await drag(page, { x: vp.width * 0.6, y: mid.y }, { x: vp.width * 0.3, y: mid.y }, 5);
  await expect(hint).toHaveText('+1 s');
  await expect(hint).toHaveText('');

  // A pinch is no swipe and no tap.
  const start = await shownAt();
  await keepControlsUp();
  await pinch(page, mid, 80, 240);
  expect((await viewOf(clip(page))).s).toBeCloseTo(3, 0);
  expect(await pageScale(page)).toBe(1);
  await page.waitForTimeout(250);
  await expect(hint).toHaveText('');
  await expect(badge(page)).toHaveText(start);

  // Letterboxed: wider than the screen across, the picture's height stays centred.
  const v = await viewOf(clip(page));
  const [width, height] = await clip(page).evaluate((e: HTMLVideoElement) => [e.videoWidth, e.videoHeight]);
  const drawn = (vp.width * height) / width;
  expect(v.y + v.s * vp.height / 2).toBeCloseTo(vp.height / 2, 0);
  expect(v.s * drawn).toBeLessThan(vp.height);

  // A one-finger drag pans, it doesn't seek.
  await keepControlsUp();
  await drag(page, { x: vp.width * 0.6, y: mid.y }, { x: vp.width * 0.3, y: mid.y }, 5);
  expect((await viewOf(clip(page))).x).toBeLessThan(v.x);
  await page.waitForTimeout(250);
  await expect(hint).toHaveText('');
  await expect(badge(page)).toHaveText(start);

  // A tap in a side third only shows the controls: no step.
  await expect(page.getByTestId('fs-overlay')).toHaveAttribute('data-shown', 'false', { timeout: 5000 });
  await page.touchscreen.tap(vp.width * 0.85, mid.y);
  await expect(page.getByTestId('fs-overlay')).toHaveAttribute('data-shown', 'true');
  await page.waitForTimeout(450); // not the first half of a double tap
  await page.touchscreen.tap(vp.width * 0.85, mid.y);
  await page.waitForTimeout(250);
  await expect(hint).toHaveText('');
  await expect(badge(page)).toHaveText(start);

  // The bar's buttons work, and don't reach the picture.
  const v2 = await viewOf(clip(page));
  await page.waitForTimeout(450);
  await page.getByTestId('fs-fwd-1').tap();
  await expect(hint).toHaveText('+1 s');
  expect(await viewOf(clip(page))).toEqual(v2);
  await expect(hint).toHaveText('');

  // A double tap: back to 1x, no step.
  await page.waitForTimeout(450);
  const atNow = await shownAt();
  await doubleTap(page, { x: vp.width * 0.85, y: mid.y });
  await expect.poll(async () => (await viewOf(clip(page))).s).toBe(1);
  await page.waitForTimeout(250);
  await expect(hint).toHaveText('');
  await expect(badge(page)).toHaveText(atNow);

  // And 1x has its gestures back.
  await keepControlsUp();
  await page.touchscreen.tap(vp.width * 0.85, mid.y);
  await expect(hint).toHaveText('+10 s');
});

test('a large still in the Timeline zooms with its marks', async ({ page }) => {
  const minutesToday = await page.evaluate(() => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); });
  test.skip(minutesToday < 12, "the fake proxy's stills are still yesterday's");
  const at = Math.floor((Date.now() - 180_000) / 1000) * 1000;
  await page.goto(`/app/timeline?cam=cam1&date=${today()}&t=${at}`);
  const still = page.getByTestId('timeline-still');
  await expect.poll(() => still.evaluate((img: HTMLImageElement) => img.naturalWidth), { timeout: 15_000 }).toBeGreaterThan(0);
  await still.scrollIntoViewIfNeeded();
  const frame = page.getByTestId('timeline-still-frame');
  const before = await frame.boundingBox();
  const inner = frame.locator('.zoomed');
  await pinch(page, await centreOf(frame), 50, 150);
  expect((await viewOf(inner)).s).toBeCloseTo(3, 0);
  expect(await frame.boundingBox()).toEqual(before);
  expect(await pageScale(page)).toBe(1);
  await doubleTap(page, await centreOf(frame));
  await expect.poll(async () => (await viewOf(inner)).s).toBe(1);
});
