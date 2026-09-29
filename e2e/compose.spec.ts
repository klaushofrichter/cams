// e2e/compose.spec.ts
// The save dialog (cam-proxy spec 2026-09-28; since 2026-09-29 the only way to
// download, from each History card). Barn has a cam-proxy whose fake holds one
// long clip covering today (e2e/fakeProxyData.ts); Porch has no proxy.
import { expect, test } from '@playwright/test';
import { signIn } from './session';

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL!);
});
// The card's download button sits next to its play button, in the same list item.
const download = (page: import('@playwright/test').Page, id = '-081510-') =>
  page.locator('li', { has: page.locator(`[data-testid="event-card"][data-clip-id*="${id}"]`) }).getByTestId('event-download');

test('the download button opens the dialog; SD with no roll saves the original clip', async ({ page }) => {
  await page.goto('/app/recordings?panel=history&cam=barn');
  await expect(download(page)).toBeVisible();
  await expect(page).toHaveURL(/clip=/); // History has settled on its position
  const before = page.url();
  await download(page).click();
  await expect(page.getByTestId('compose-dialog')).toBeVisible();
  expect(page.url()).toBe(before); // opening it doesn't move the player
  await expect(page.getByTestId('compose-save')).toHaveAttribute('href', /download\?quality=sub/);
  await page.getByTestId('compose-close').click();
  await expect(page.getByTestId('compose-dialog')).toHaveCount(0);
});

test('a post-roll is generated with progress, previewed and saved', async ({ page }) => {
  await page.goto('/app/recordings?panel=history&cam=barn');
  await download(page).click();
  await page.getByTestId('compose-post').fill('10');
  await expect(page.getByTestId('compose-save')).toHaveAttribute('aria-disabled', 'true');
  await page.getByTestId('compose-generate').click();
  await expect(page.getByTestId('compose-player')).toBeVisible({ timeout: 10_000 });
  const [file] = await Promise.all([page.waitForEvent('download'), page.getByTestId('compose-save').click()]);
  expect(file.suggestedFilename()).toMatch(/^barn-\d{4}-\d{2}-\d{2}_08-15-10-composed-sd\.mp4$/);
});

test('Close during generation cancels the job', async ({ page }) => {
  await page.goto('/app/recordings?panel=history&cam=barn');
  await download(page).click();
  await page.getByTestId('compose-post').fill('10');
  const del = page.waitForRequest((r) => r.method() === 'DELETE' && /\/compositions\//.test(r.url()));
  await page.getByTestId('compose-generate').click();
  await page.getByTestId('compose-close').click();
  await del;
});

test('4K saves the original main stream; a camera without a proxy offers only SD and 4K', async ({ page }) => {
  await page.goto('/app/recordings?panel=history&cam=barn');
  await download(page).click();
  await page.getByTestId('compose-size').selectOption('4k');
  await expect(page.getByTestId('compose-pre')).toBeDisabled();
  await expect(page.getByTestId('compose-save')).toHaveAttribute('href', /quality=main/);
  await page.getByTestId('compose-close').click();
  await page.goto('/app/recordings?panel=history&cam=porch');
  await download(page, '-').first().click();
  await expect(page.getByTestId('compose-pre')).toHaveCount(0);
  await expect(page.getByTestId('compose-size').locator('option')).toHaveText([/^SD/, /^4K/]);
  await expect(page.getByTestId('compose-save')).toHaveAttribute('href', /quality=sub/);
});
