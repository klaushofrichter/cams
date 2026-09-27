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
