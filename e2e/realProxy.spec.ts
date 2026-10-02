import { readFileSync } from 'fs';
import { expect, test, type Page } from '@playwright/test';
import { REAL_PROXY, REAL_PROXY_ON } from './env';
import { signIn } from './session';

// Across the stack (spec 2026-10-02-recordings-via-proxy-design): Silo's
// cam-sim refuses HTTP Download, the real cam-proxy fetches the SD recording
// over Baichuan, and cams plays it and saves it in 4K (the main stream).
test.skip(!REAL_PROXY_ON, 'needs the real cam-proxy: CI, or CAMS_E2E_REAL_PROXY=1 on Linux (e2e/env.ts)');

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL!);
});

const card = (page: Page, hhmmss: string) => page.locator(`[data-testid="event-card"][data-clip-id*="-${hhmmss}-"]`);

test('Silo plays and saves a recording its camera refuses over HTTP', async ({ page }) => {
  await page.goto('/app/recordings?cam=silo&panel=events');
  await expect(page.getByTestId('event-card')).toHaveCount(4, { timeout: 30_000 });
  await expect(page.getByTestId('recordings-source')).toHaveText('Source of recordings and thumbnails: cam-proxy (SD card)');
  await card(page, '120505').click();
  const video = page.getByTestId('clip-video');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState >= 2 && v.currentTime > 0.5), { timeout: 30_000 }).toBe(true);
  await page.locator('li', { has: card(page, '120505') }).getByTestId('event-download').click();
  await page.getByTestId('compose-size').selectOption('4k');
  const [file] = await Promise.all([page.waitForEvent('download'), page.getByTestId('compose-save').click()]);
  expect(file.suggestedFilename()).toMatch(/^silo-\d{4}-\d{2}-\d{2}_12-05-05-main\.mp4$/);
  const bytes = readFileSync((await file.path())!);
  expect(bytes.length).toBeGreaterThan(1000);
  expect(bytes.subarray(4, 8).toString('latin1')).toBe('ftyp');
  // The proxy fetched over Baichuan: its HTTP Download is refused.
  const status = (await (await page.request.get(`http://127.0.0.1:${REAL_PROXY.port}/control/status`, { headers: { Authorization: `Bearer ${REAL_PROXY.adminToken}` } })).json()) as { recordings: { last: { result: string } | null } };
  expect(status.recordings.last?.result).toBe('ok');
});
