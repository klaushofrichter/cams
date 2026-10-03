// A film frame whose minute was still being collected when its sprite was
// first loaded stayed blank where the later tiles came in (Klaus, 2026-10-03):
// the browser keeps an image URL for the page, no-store or not. When the
// minute's list shows more tiles, its sprite is asked for again.
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { FAKE_PROXY_PORT } from './fakeProxyData';
import { signIn } from './session';

const HOOKS = `http://127.0.0.1:${FAKE_PROXY_PORT - 2}`;

test('a film frame of a minute being collected is fetched again as it grows', async ({ context, baseURL, page }, info) => {
  await signIn(context, baseURL!);
  await page.clock.install();
  await page.goto('/app/live');
  await page.getByTestId('camera-picker').selectOption('cam1');
  // The zoom is the user's saved preference, which other specs rely on: put it back afterwards.
  const before = await page.locator('[data-testid^="zoom-"][aria-pressed="true"]').getAttribute('data-testid');
  await page.getByTestId('zoom-0.5').click();
  try {
    await film(page, info);
  } finally {
    if (before && before !== 'zoom-0.5') {
      const saved = page.waitForResponse((r) => r.url().endsWith('/api/preferences') && r.request().method() === 'PUT');
      await page.getByTestId(before).click();
      expect((await saved).ok()).toBe(true);
    }
  }
});

async function film(page: Page, info: TestInfo) {
  // A frame before now (the hook gives its minute a sprite). The projects
  // run at once and share the fake, so they take different minutes: the
  // phone's film has 4 frames (7.5 min apart at this zoom), and it takes its
  // newest past one, at most 8.5 min back; desktop takes one older than 9 min.
  // (Minute parity didn't work: the phone's few frames can all share one.)
  const frames = page.getByTestId('strip-film-frame');
  await expect(frames.first()).toBeVisible();
  const now = await page.evaluate(() => Date.now());
  const ts = (await frames.evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-t'))))).filter((t) => t < now - (info.project.name === 'phone' ? 60_000 : 9 * 60_000));
  expect(ts.length).toBeGreaterThan(0);
  const t = ts.at(-1)!;
  const minute = Math.floor(t / 60_000) * 60_000;
  const frame = page.locator(`[data-testid="strip-film-frame"][data-t="${t}"] .tile`);
  try {
    // The minute is being collected: 59 tiles so far.
    expect((await page.request.post(`${HOOKS}/preview-minute`, { data: { minute, tiles: 59, current: true } })).ok()).toBe(true);
    const partial = page.waitForRequest((r) => r.url().includes(`/previews/${minute}.jpg?n=59`), { timeout: 10_000 });
    await page.clock.fastForward('00:31'); // today's previews are asked for again after 30 s
    await partial;
    await expect(frame).toHaveAttribute('style', new RegExp(`/previews/${minute}\\.jpg\\?n=59["']`));
    // Done: the whole minute's plain URL again.
    expect((await page.request.post(`${HOOKS}/preview-minute`, { data: { minute, tiles: 60, current: false } })).ok()).toBe(true);
    await page.clock.fastForward('00:31');
    await expect(frame).toHaveAttribute('style', new RegExp(`/previews/${minute}\\.jpg["']`));
  } finally {
    await page.request.post(`${HOOKS}/preview-minute`, { data: { minute, tiles: 60, current: false } });
  }
}
