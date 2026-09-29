// e2e/compose.spec.ts
// The SD download dialog (cam-proxy spec 2026-09-28). Barn has a cam-proxy
// whose fake holds one long clip covering today (e2e/fakeProxyData.ts).
import { expect, test } from '@playwright/test';
import { signIn } from './session';

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL!);
});
const row = (page: import('@playwright/test').Page) => page.locator('[data-testid="download-row"][data-clip-id*="-081510-"]');

test('SD opens the modal; 0/0 saves the original clip', async ({ page }) => {
  await page.goto('/app/recordings?panel=downloads&cam=barn');
  await row(page).getByTestId('download-sub').click();
  await expect(page.getByTestId('compose-dialog')).toBeVisible();
  await expect(page.getByTestId('compose-save')).toHaveAttribute('href', /download\?quality=sub/);
  await page.getByTestId('compose-close').click();
  await expect(page.getByTestId('compose-dialog')).toHaveCount(0);
});

test('a post-roll is generated with progress, previewed and saved', async ({ page }) => {
  await page.goto('/app/recordings?panel=downloads&cam=barn');
  await row(page).getByTestId('download-sub').click();
  await page.getByTestId('compose-post').fill('10');
  await expect(page.getByTestId('compose-save')).toHaveAttribute('aria-disabled', 'true');
  await page.getByTestId('compose-generate').click();
  await expect(page.getByTestId('compose-player')).toBeVisible({ timeout: 10_000 });
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('compose-save').click()]);
  expect(download.suggestedFilename()).toMatch(/^barn-\d{4}-\d{2}-\d{2}_08-15-10-composed-sd\.mp4$/);
});

test('Close during generation cancels the job', async ({ page }) => {
  await page.goto('/app/recordings?panel=downloads&cam=barn');
  await row(page).getByTestId('download-sub').click();
  await page.getByTestId('compose-post').fill('10');
  const del = page.waitForRequest((r) => r.method() === 'DELETE' && /\/compositions\//.test(r.url()));
  await page.getByTestId('compose-generate').click();
  await page.getByTestId('compose-close').click();
  await del;
});

test('Full stays a direct download, and a camera without a proxy keeps a direct SD link', async ({ page }) => {
  await page.goto('/app/recordings?panel=downloads&cam=barn');
  await expect(row(page).getByTestId('download-main')).toHaveAttribute('href', /quality=main/);
  await page.goto('/app/recordings?panel=downloads&cam=porch');
  await expect(row(page).getByTestId('download-sub')).toHaveAttribute('href', /quality=sub/);
});
