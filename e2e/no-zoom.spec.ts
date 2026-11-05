import { expect, test } from '@playwright/test';
import { signIn } from './session';

async function refusesZoom(page: import('@playwright/test').Page) {
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).touchAction)).toBe('pan-x pan-y');
  // iOS's pinch events: Chromium never sends them, so send one by hand.
  const refused = await page.evaluate(() => ['gesturestart', 'gesturechange'].map((type) => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    document.body.dispatchEvent(e);
    return e.defaultPrevented;
  }));
  expect(refused).toEqual([true, true]);
}

test('the landing page does not zoom', async ({ page }) => {
  await page.goto('/');
  await refusesZoom(page);
});

test('the app does not zoom', async ({ context, page, baseURL }) => {
  await signIn(context, baseURL!);
  await page.goto('/app/video');
  await refusesZoom(page);
});
