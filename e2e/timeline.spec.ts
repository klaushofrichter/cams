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

test('the Timeline shows the day’s minutes from the camera gateway; a tile opens History at that minute', async ({ page }) => {
  await page.goto('/app/timeline');
  await page.getByTestId('camera-picker').selectOption('cam1');
  const tiles = page.getByTestId('timeline-minute');
  await expect(tiles.first()).toBeVisible();
  expect(await tiles.count()).toBeGreaterThanOrEqual(10);
  await tiles.first().click(); // Klaus, 2026-09-29: straight to History
  await expect(page).toHaveURL(/\/app\/recordings\?.*at=\d+.*panel=history/);
  await expect(page.getByTestId('source-badge')).toBeVisible();
});

// Klaus, 2026-09-29: the Timeline shares the cursor with History and Live.
test('from History, the Timeline menu opens the viewer at that time; steps and a reload keep it', async ({ page }, testInfo) => {
  const at = Math.floor((Date.now() - 180_000) / 1000) * 1000; // three minutes ago: inside the fake's stills
  await page.goto(`/app/recordings?cam=cam1&panel=history&at=${at}`);
  await expect(page.getByTestId('source-badge')).toBeVisible();
  if (testInfo.project.name === 'phone') {
    await page.getByTestId('hamburger').click();
    await page.getByTestId('drawer').getByTestId('nav-timeline').click();
  } else await page.getByTestId('sidebar').getByTestId('nav-timeline').click();
  const still = page.getByTestId('timeline-still');
  await expect(still).toBeVisible();
  const src = await still.getAttribute('src');
  const shown = Number(/stills\/(\d+)\.jpg/.exec(src!)![1]);
  expect(Math.abs(shown - at)).toBeLessThanOrEqual(60_000); // the nearest still to History's time
  await expect.poll(() => still.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(896);
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('timeline-still')).not.toHaveAttribute('src', src!); // the step has happened
  await expect(page).toHaveURL(/cam=cam1&date=\d{4}-\d{2}-\d{2}&t=\d+/);
  const stepped = await page.getByTestId('timeline-still').getAttribute('src');
  await page.reload();
  await expect(page.getByTestId('timeline-still')).toHaveAttribute('src', stepped!);
  await expect(page.getByTestId('timeline-open-history')).toHaveAttribute('href', /panel=history&at=\d+/);
  await page.getByTestId('timeline-close').click();
  await expect(page.getByTestId('timeline-viewer')).toHaveCount(0);
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

test('the viewer\'s still opens that moment in History', async ({ page }) => {
  const at = Math.floor((Date.now() - 120_000) / 1000) * 1000;
  await page.goto(`/app/timeline?cam=cam1&date=${await page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })}&t=${at}`);
  await expect(page.getByTestId('timeline-still')).toBeVisible();
  await page.getByTestId('timeline-open-history').click();
  await expect(page).toHaveURL(/\/app\/recordings\?.*at=\d+.*panel=history/);
  await expect(page.getByTestId('source-badge')).toBeVisible();
});

// Klaus, 2026-09-29: the selected minute has a red frame, 3× thicker, and
// "Show in timeline grid" scrolls to it.
async function expectRedFrame(tile: import('@playwright/test').Locator) {
  await expect(tile).toBeInViewport();
  const { width, color } = await tile.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { width: cs.borderTopWidth, color: cs.borderTopColor };
  });
  expect(width).toBe('6px');
  const [r, g, b] = color.match(/\d+/g)!.map(Number);
  expect(r).toBeGreaterThan(200);
  expect(g).toBeLessThan(90);
  expect(b).toBeLessThan(90);
}

test('"Show in timeline grid" scrolls to the selected minute, framed in red', async ({ page }) => {
  const at = Math.floor((Date.now() - 180_000) / 1000) * 1000;
  const date = await page.evaluate((t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }, at);
  await page.goto(`/app/timeline?cam=cam1&date=${date}&t=${at}`);
  await expect(page.getByTestId('timeline-still')).toBeVisible();
  const active = page.locator('[data-testid="timeline-minute"].active');
  await expect(active).toHaveCount(1);
  await page.getByTestId('timeline-show-grid').click();
  await expectRedFrame(active);
  // The thicker frame grows outward by 4 px (a negative margin), so the
  // other tiles keep their places.
  const rects = await page.getByTestId('timeline-minute').evaluateAll((els) => els.map((e) => ({ active: e.classList.contains('active'), w: e.getBoundingClientRect().width })));
  const others = new Set(rects.filter((r) => !r.active).map((r) => r.w));
  expect(others.size).toBe(1);
  expect(rects.find((r) => r.active)!.w).toBe([...others][0] + 8);
});

test('History\'s "Show in Timeline" opens the Timeline at that moment, the minute framed in red and in view', async ({ page }) => {
  const at = Math.floor((Date.now() - 180_000) / 1000) * 1000;
  await page.goto(`/app/recordings?cam=cam1&panel=history&at=${at}`);
  await expect(page.getByTestId('source-badge')).toBeVisible();
  const link = page.getByTestId('show-in-timeline');
  await expect(link).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(/\/app\/timeline\?cam=cam1&date=\d{4}-\d{2}-\d{2}&t=\d+$/); // grid=1 is used once, then dropped
  const src = await page.getByTestId('timeline-still').getAttribute('src');
  expect(Math.abs(Number(/stills\/(\d+)\.jpg/.exec(src!)![1]) - at)).toBeLessThanOrEqual(60_000);
  await expectRedFrame(page.locator('[data-testid="timeline-minute"].active'));
});

test('History offers no Timeline link for a camera without a gateway', async ({ page }) => {
  await page.goto(`/app/recordings?cam=porch&panel=history&at=${Date.now() - 180_000}`);
  await expect(page.getByTestId('source-badge')).toBeVisible();
  await expect(page.getByTestId('show-in-timeline')).toHaveCount(0);
});
