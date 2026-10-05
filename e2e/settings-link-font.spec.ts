import { test, expect, type Locator } from '@playwright/test';
import { signIn } from './session';

// Klaus 2026-10-05: "Open this camera's cam-proxy" and "Open the camera's own
// web page" are the same kind of link and must have the same font size. No
// test camera shows both, so each is measured on a camera that shows it.
test('the two outward links on Settings share one font size', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL!);
  // The fake proxies offer no web page; give them one so the link shows.
  await page.route('**/api/cameras/*/proxy/info', (r) => r.fulfill({ json: { reachable: true, webUrl: 'http://127.0.0.1:8480/' } }));
  await page.goto('/app/settings');
  const picker = page.getByTestId('camera-picker');
  const sizes: Record<string, string> = {};
  const measure = async (key: string, l: Locator) => {
    if (sizes[key]) return;
    try { await expect(l).toBeVisible({ timeout: 1500 }); } catch { return; }
    sizes[key] = await l.evaluate((el) => getComputedStyle(el).fontSize);
  };
  for (const label of await picker.locator('option').allTextContents()) {
    await picker.selectOption({ label });
    await measure('proxy', page.getByTestId('proxy-web-link'));
    await measure('webui', page.getByTestId('device-webui-link'));
    if (sizes.proxy && sizes.webui) break;
  }
  expect(Object.keys(sizes).sort()).toEqual(['proxy', 'webui']);
  expect(sizes.proxy).toBe(sizes.webui);
});
