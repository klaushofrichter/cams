import { expect, test, type Page } from '@playwright/test';
import { signIn } from './session';

// Klaus, 2026-10-06: while the live view connects, a still from the camera
// gateway that is less than 60 s old shows in the player instead of black;
// newer stills replace it, and live takes over once it plays. Den has the
// fake cam-proxy; its live stream is held back here until the test lets it
// through, and its latest still is re-stamped (X-Still-Time) to the age the
// test needs.

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL!);
});

// Holds Den's live stream until release() (a route that never answers is a
// connection that never plays).
async function holdLive(page: Page): Promise<() => void> {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route(/\/api\/cameras\/cam1\/live\?/, async (route) => {
    await held;
    await route.continue().catch(() => {}); // the page may have moved on
  });
  return release;
}

// Den's latest still, stamped `ageMs(n)` old for the n-th request (1-based).
async function stampStills(page: Page, ageMs: (n: number) => number): Promise<() => number> {
  let n = 0;
  await page.route(/\/api\/cameras\/cam1\/still\/latest\.jpg/, async (route) => {
    n++;
    const at = Date.now() - ageMs(n);
    const res = await route.fetch();
    await route.fulfill({ status: 200, contentType: 'image/jpeg', body: await res.body(), headers: { 'X-Still-Time': String(at), 'Cache-Control': 'no-store' } });
  });
  return () => n;
}

// What is in the middle of the player: the still's picture, and how bright
// it is (the test pattern, not a black box).
async function middleOfPlayer(page: Page): Promise<{ still: boolean; brightness: number }> {
  return page.getByTestId('strip-live').evaluate((layer) => {
    const r = layer.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 3);
    const img = layer.querySelector<HTMLImageElement>('[data-testid="live-still"] img');
    let brightness = 0;
    if (img?.complete && img.naturalWidth > 0) {
      const c = document.createElement('canvas');
      c.width = 32;
      c.height = 18;
      const g = c.getContext('2d')!;
      g.drawImage(img, 0, 0, 32, 18);
      const d = g.getImageData(0, 0, 32, 18).data;
      for (let i = 0; i < d.length; i += 4) brightness += (d[i] + d[i + 1] + d[i + 2]) / 3;
      brightness /= d.length / 4;
    }
    return { still: !!img && hit === img, brightness };
  });
}

const age = async (page: Page) => Number((await page.getByTestId('stills-badge').textContent())!.match(/· (\d+) s old$/)![1]);

test('a still less than 60 s old shows while live connects, newer ones replace it, then live takes over', async ({ page }) => {
  const release = await holdLive(page);
  const asked = await stampStills(page, (n) => (n === 1 ? 20_000 : 1_000));
  await page.goto('/app/live');
  await expect(page.getByTestId('live-connecting')).toBeVisible();
  // At once (the first request), not after the 5 s stills fallback.
  await expect(page.getByTestId('live-still')).toBeVisible({ timeout: 1_500 });
  await expect(page.getByTestId('live-still').locator('img')).toHaveJSProperty('complete', true);
  const first = await middleOfPlayer(page);
  expect(first.still).toBe(true);
  expect(first.brightness).toBeGreaterThan(20);
  // Marked as stills, like the fallback: the badge on the still and the mode badge.
  await expect(page.getByTestId('stills-badge')).toContainText(/^STILLS · \d{1,2}:\d{2}:\d{2}.* · \d+ s old$/);
  await expect(page.getByTestId('live-badge')).toHaveText('● STILLS');
  await expect(page.getByTestId('live-connecting')).toHaveClass(/stills/);
  // A newer still replaces it.
  await expect.poll(() => asked(), { timeout: 5_000 }).toBeGreaterThan(1);
  await expect.poll(() => age(page), { timeout: 5_000 }).toBeLessThan(10);
  // Live plays: the still and the connecting bar go, the video shows.
  release();
  await expect(page.getByTestId('live-badge')).toHaveText('● LIVE', { timeout: 15_000 });
  await expect(page.getByTestId('live-still')).toHaveCount(0);
  await expect(page.getByTestId('live-connecting')).toHaveCount(0);
  await expect
    .poll(() => page.getByTestId('live-video').evaluate((v: HTMLVideoElement) => v.readyState >= 2 && v.currentTime > 0), { timeout: 15_000 })
    .toBe(true);
});

test('a still 60 s old or older is not shown while live connects (as before)', async ({ page }) => {
  const release = await holdLive(page);
  const asked = await stampStills(page, () => 90_000);
  await page.goto('/app/live');
  await expect(page.getByTestId('live-connecting')).toBeVisible();
  await expect.poll(() => asked(), { timeout: 5_000 }).toBe(1);
  await page.waitForTimeout(2_000);
  await expect(page.getByTestId('live-still')).toHaveCount(0);
  await expect(page.getByTestId('live-connecting')).not.toHaveClass(/stills/);
  await expect(page.getByTestId('live-badge')).toHaveText('● …');
  expect(asked()).toBe(1); // one request on connect, no polling for a stale one
  release();
  await expect(page.getByTestId('live-badge')).toHaveText('● LIVE', { timeout: 15_000 });
  await expect(page.getByTestId('live-connecting')).toHaveCount(0);
});
