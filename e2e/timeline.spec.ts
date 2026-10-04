import { expect, test } from '@playwright/test';
import { signIn } from './session';

// Plan 6: Den (cam1) has a fake cam-proxy (e2e/fakeProxyData.ts) with the
// last ten minutes of stills; Porch has none.
test.beforeEach(async ({ context, baseURL, page }) => {
  await signIn(context, baseURL!);
  // The fake's stills are the last ten minutes: until 00:12 (the browser's
  // zone) they are still yesterday's, and today has none (issue #38).
  const minutesToday = await page.evaluate(() => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); });
  test.skip(minutesToday < 12, "the fake proxy's stills are still yesterday's");
});

test('a minute opens its seconds under its hour; a second opens the still; "Open in History" lands paused there', async ({ page }) => {
  await page.goto('/app/timeline');
  await page.getByTestId('camera-picker').selectOption('cam1');
  const tiles = page.getByTestId('timeline-minute');
  await expect(tiles.first()).toBeVisible();
  expect(await tiles.count()).toBeGreaterThanOrEqual(10);
  const tile = tiles.last();
  await tile.click();
  await expect(page).toHaveURL(/\/app\/timeline\?/); // Klaus, 2026-09-30: it stays on the Timeline
  const hour = page.getByTestId('timeline-hour').filter({ has: tile });
  await expect(hour.getByTestId('timeline-minute-view')).toBeVisible();
  await page.getByTestId('timeline-minute-view').getByTestId('timeline-second').nth(10).click();
  const still = page.getByTestId('timeline-still');
  await expect(still).toBeVisible();
  const ts = /stills\/(\d+)\.jpg/.exec((await still.getAttribute('src'))!)![1];
  await page.getByTestId('timeline-open-history').click();
  await expect.poll(() => new URL(page.url()).searchParams.get('at')).toBe(ts);
  await expect(page.getByTestId('source-badge')).toBeVisible();
  await expect(page.getByTestId('play-toggle')).toHaveAttribute('aria-pressed', 'false');
});

// Klaus, 2026-09-29: the Timeline shares the cursor with History and Live.
test('from History, the Timeline menu opens that minute and still; a minute step and a reload keep the minute', async ({ page }, testInfo) => {
  const at = Math.floor((Date.now() - 180_000) / 1000) * 1000; // three minutes ago: inside the fake's stills
  await page.goto(`/app/recordings?cam=cam1&panel=history&at=${at}`);
  await expect(page.getByTestId('source-badge')).toBeVisible();
  if (testInfo.project.name === 'phone') {
    await page.getByTestId('hamburger').click();
    await page.getByTestId('drawer').getByTestId('nav-timeline').click();
  } else await page.getByTestId('sidebar').getByTestId('nav-timeline').click();
  const still = page.getByTestId('timeline-still');
  await expect(still).toBeVisible();
  const shown = Number(/stills\/(\d+)\.jpg/.exec((await still.getAttribute('src'))!)![1]);
  expect(Math.abs(shown - at)).toBeLessThanOrEqual(60_000); // the nearest still to History's time
  await expect.poll(() => still.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(896);
  await expect(page.getByTestId('timeline-minute-view')).toBeInViewport();
  const active = page.locator('[data-testid="timeline-minute"].active');
  const before = Number(await active.getAttribute('data-minute'));
  // Step to a neighbour inside the hour: back unless this is the hour's first minute.
  const back = !(await page.getByTestId('timeline-minute-prev').isDisabled());
  const after = before + (back ? -60_000 : 60_000);
  await page.keyboard.press('Escape'); // with the large still open, the arrows step its second (issue #159)
  await expect(page.getByTestId('timeline-still')).toHaveCount(0);
  await page.keyboard.press(back ? 'ArrowLeft' : 'ArrowRight');
  await expect(active).toHaveAttribute('data-minute', String(after));
  await expect(page.getByTestId('timeline-still')).toHaveCount(0); // a new minute starts without a still
  await expect(page).toHaveURL(new RegExp(`cam=cam1&date=\\d{4}-\\d{2}-\\d{2}&t=${after}$`));
  await page.reload();
  await expect(page.locator('[data-testid="timeline-minute"].active')).toHaveAttribute('data-minute', String(after));
  await page.getByTestId('timeline-close').click();
  await expect(page.getByTestId('timeline-minute-view')).toHaveCount(0);
});

// Issue #159: one second back or forward under the large still. Den's fake
// proxy keeps a still every ten seconds, so the seconds between are gaps.
test('the large still steps one second with the buttons and the arrow keys, across minutes and gaps', async ({ page }) => {
  const m = Math.floor((Date.now() - 180_000) / 60_000) * 60_000; // three minutes ago
  await page.goto(`/app/timeline?cam=cam1&t=${m + 10_000}`);
  const still = page.getByTestId('timeline-still');
  const gap = page.getByTestId('timeline-gap');
  const active = page.locator('[data-testid="timeline-minute"].active');
  await expect(still).toHaveAttribute('src', new RegExp(`stills/${m + 10_000}\\.jpg$`));
  const stamp = (t: number) => page.evaluate((x) => {
    const d = new Date(x);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }, t);
  // A second without a still: the gap, said in local time.
  await page.getByTestId('timeline-second-next').click();
  await expect(gap).toHaveText(`${await stamp(m + 11_000)} not available as snapshot`);
  await expect(still).toHaveCount(0);
  await page.getByTestId('timeline-second-prev').click();
  await expect(still).toHaveAttribute('src', new RegExp(`stills/${m + 10_000}\\.jpg$`));
  // The arrow keys, and back across the minute: the previous minute's last second.
  await page.keyboard.press('ArrowLeft');
  await expect(gap).toHaveText(`${await stamp(m + 9000)} not available as snapshot`);
  for (let s = 8; s >= 0; s--) {
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByTestId('timeline-large-time')).toHaveText(await page.evaluate((x) => new Date(x).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }), m + s * 1000));
  }
  await expect(still).toHaveAttribute('src', new RegExp(`stills/${m}\\.jpg$`));
  await expect(active).toHaveAttribute('data-minute', String(m));
  await page.keyboard.press('ArrowLeft');
  await expect(gap).toHaveText(`${await stamp(m - 1000)} not available as snapshot`);
  await expect(active).toHaveAttribute('data-minute', String(m - 60_000));
  await expect(page.locator('[data-testid="timeline-second"].active')).toHaveAttribute('data-ts', String(m - 1000));
  await page.keyboard.press('ArrowRight');
  await expect(still).toHaveAttribute('src', new RegExp(`stills/${m}\\.jpg$`));
  await expect(active).toHaveAttribute('data-minute', String(m));
  await expect(page).toHaveURL(new RegExp(`&t=${m}$`));
});

test('from Live, the Timeline menu opens the newest minute', async ({ page }, testInfo) => {
  await page.goto('/app/live');
  await page.getByTestId('camera-picker').selectOption('cam1');
  await expect(page.getByTestId('live-panel')).toBeVisible();
  await page.waitForTimeout(500);
  if (testInfo.project.name === 'phone') {
    await page.getByTestId('hamburger').click();
    await page.getByTestId('drawer').getByTestId('nav-timeline').click();
  } else await page.getByTestId('sidebar').getByTestId('nav-timeline').click();
  const still = page.getByTestId('timeline-still');
  await expect(still).toBeVisible();
  const shown = Number(/stills\/(\d+)\.jpg/.exec((await still.getAttribute('src'))!)![1]);
  expect(Date.now() - shown).toBeLessThan(3 * 60_000); // the newest minute, not an old History time
});

test('the Timeline explains a camera without a gateway', async ({ page }) => {
  await page.goto('/app/timeline');
  await page.getByTestId('camera-picker').selectOption('porch');
  await expect(page.getByTestId('timeline-no-proxy')).toBeVisible();
});

// Plan 7: moving over the Recordings timeline shows that moment's frame from
// the proxy's preview sprites (Den's fake proxy has the last ten minutes).
test('the Recordings timeline previews the frame under the pointer', async ({ page }) => {
  const at = Date.now() - 120_000;
  await page.goto(`/app/recordings?cam=cam1&panel=history&at=${at}`);
  const bar = page.getByTestId('timeline');
  await expect(bar).toBeVisible();
  const box = (await bar.boundingBox())!;
  await expect.poll(async () => {
    await page.mouse.move(box.x + box.width / 2 - box.width / 1440, box.y + box.height / 2); // one minute before the playhead (24 h bar)
    return page.getByTestId('scrub-preview').isVisible();
  }, { timeout: 10_000 }).toBe(true);
  await page.mouse.move(box.x + box.width / 2, box.y - 40);
  await expect(page.getByTestId('scrub-preview')).toHaveCount(0);
});

test('History\'s "Show in Timeline" opens that minute under its hour, with the still in view', async ({ page }) => {
  const at = Math.floor((Date.now() - 180_000) / 1000) * 1000;
  await page.goto(`/app/recordings?cam=cam1&panel=history&at=${at}`);
  await expect(page.getByTestId('source-badge')).toBeVisible();
  const link = page.getByTestId('show-in-timeline');
  await expect(link).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(/\/app\/timeline\?cam=cam1&date=\d{4}-\d{2}-\d{2}&t=\d+$/);
  const src = await page.getByTestId('timeline-still').getAttribute('src');
  expect(Math.abs(Number(/stills\/(\d+)\.jpg/.exec(src!)![1]) - at)).toBeLessThanOrEqual(60_000);
  await expect(page.getByTestId('timeline-minute-view')).toBeInViewport();
});

test('History offers no Timeline link for a camera without a gateway', async ({ page }) => {
  await page.goto(`/app/recordings?cam=porch&panel=history&at=${Date.now() - 180_000}`);
  await expect(page.getByTestId('source-badge')).toBeVisible();
  await expect(page.getByTestId('show-in-timeline')).toHaveCount(0);
});
