import { expect, test } from '@playwright/test';
import { signIn } from './session';

// Plan 6: Den (cam1) has a fake cam-proxy (e2e/fakeProxyData.ts) with the
// last ten minutes of stills; Porch has none.
test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL!);
});

test('the Timeline shows the day’s minutes from the camera gateway, and a still on click', async ({ page }) => {
  await page.goto('/app/timeline');
  await page.getByTestId('camera-picker').selectOption('cam1');
  const tiles = page.getByTestId('timeline-minute');
  await expect(tiles.first()).toBeVisible();
  expect(await tiles.count()).toBeGreaterThanOrEqual(10);
  await tiles.first().click();
  const still = page.getByTestId('timeline-still');
  await expect(still).toBeVisible();
  await expect.poll(() => still.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(896);
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('timeline-still')).toBeVisible();
  // The URL holds the view: a reload opens the same still.
  await expect(page).toHaveURL(/cam=cam1&date=\d{4}-\d{2}-\d{2}&t=\d+/);
  const src = await page.getByTestId('timeline-still').getAttribute('src');
  await page.reload();
  await expect(page.getByTestId('timeline-still')).toHaveAttribute('src', src!);
  await page.getByTestId('timeline-close').click();
  await expect(page.getByTestId('timeline-viewer')).toHaveCount(0);
});

test('the Timeline explains a camera without a gateway', async ({ page }) => {
  await page.goto('/app/timeline');
  await page.getByTestId('camera-picker').selectOption('porch');
  await expect(page.getByTestId('timeline-no-proxy')).toBeVisible();
});

// Plan 7: moving over the Recordings timeline shows that moment's frame from
// the proxy's preview sprites (Den's fake proxy has the last ten minutes).
test('the Recordings timeline previews the frame under the pointer', async ({ page }) => {
  await page.goto('/app/recordings?cam=cam1&panel=history');
  const bar = page.getByTestId('timeline');
  await expect(bar).toBeVisible();
  const box = (await bar.boundingBox())!;
  // Two minutes ago in the browser's time zone (America/Chicago), not the
  // test runner's (UTC on CI).
  const frac = await page.evaluate(() => {
    const now = new Date();
    return (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds() - 120) / 86400;
  });
  await expect.poll(async () => {
    await page.mouse.move(box.x + box.width * frac, box.y + box.height / 2);
    return page.getByTestId('scrub-preview').isVisible();
  }, { timeout: 10_000 }).toBe(true);
  await page.mouse.move(box.x + box.width * frac, box.y - 40);
  await expect(page.getByTestId('scrub-preview')).toHaveCount(0);
});
