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

// The public pages zoom since 2026-11-11 (WCAG 1.4.4, kube-setup's public
// pages baseline; e2e-public/ checks them in four browsers): no
// user-scalable=no, no pinch refused. Only the signed-in app holds still.
test('the landing page zooms', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', 'width=device-width, initial-scale=1');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).touchAction)).toBe('manipulation');
  const refused = await page.evaluate(() => ['gesturestart', 'gesturechange'].map((type) => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    document.body.dispatchEvent(e);
    return e.defaultPrevented;
  }));
  expect(refused).toEqual([false, false]);
});

test('the app does not zoom', async ({ context, page, baseURL }) => {
  await signIn(context, baseURL!);
  await page.goto('/app/video');
  await refusesZoom(page);
});
