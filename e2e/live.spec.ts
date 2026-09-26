import { expect, test } from '@playwright/test';
import { signIn } from './session';

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL!);
});

test('live video plays from the camera', async ({ page }) => {
  await page.goto('/app/live');
  await expect(page.getByTestId('live-state')).toHaveText('Live', { timeout: 15_000 });
  const video = page.getByTestId('live-video');
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState >= 2 && v.currentTime > 0.5), { timeout: 15_000 })
    .toBe(true);
  await expect(page.getByTestId('live-badge')).toContainText('LIVE');
});

test('audio starts muted and can be toggled', async ({ page }) => {
  await page.goto('/app/live');
  const video = page.getByTestId('live-video');
  await expect(video).toHaveJSProperty('muted', true);
  await page.getByTestId('mute-toggle').click();
  await expect(page.getByTestId('live-video')).toHaveJSProperty('muted', false);
});

test('snapshot link downloads a JPEG', async ({ page }) => {
  await page.goto('/app/live');
  const link = page.getByTestId('snapshot');
  await expect(link).toHaveAttribute('href', '/api/cameras/cam1/snapshot.jpg');
  const res = await page.request.get('/api/cameras/cam1/snapshot.jpg');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe('image/jpeg');
});

test('an unreachable camera shows the offline banner with retry', async ({ page }) => {
  await page.goto('/app/live');
  await page.getByTestId('camera-picker').selectOption('garage');
  await expect(page.getByTestId('offline-banner')).toContainText('Garage is offline');
  await expect(page.getByTestId('offline-reason')).toHaveText('The camera could not be reached.');
  await page.getByTestId('retry').click();
  await expect(page.getByTestId('offline-banner')).toBeVisible();
  await expect(page.getByTestId('live-video')).toHaveCount(0);
});

// Review focus 4 ("switching cameras tears the stream down") is covered by
// e2e/live-teardown.spec.ts, which checks the mock camera's own connection
// count instead of just the DOM. A DOM-only check here would pass even if
// LiveSession.stop()/player.destroy() did nothing, because Live.svelte
// unconditionally unmounts LivePlayer on any camera switch (status is reset
// to null first), independent of whether teardown actually released
// anything.

test('camera API rejects unknown cameras', async ({ page }) => {
  const res = await page.request.get('/api/cameras/nope/status');
  expect(res.status()).toBe(404);
});
