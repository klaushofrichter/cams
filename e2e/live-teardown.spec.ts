import { expect, test, type Page } from '@playwright/test';
import { signIn } from './session';

// Proves that switching cameras releases the OLD stream both client- and
// server-side, by reading the mock camera's own /__state instead of just the
// Live page's DOM. A DOM-only assertion (no <video> element left) would pass
// even if LiveSession.stop()/player.destroy() did nothing, since Live.svelte
// unconditionally unmounts LivePlayer on any camera switch.
//
// Isolation: /__state's activeStreams counter is shared across the WHOLE
// mock-camera process (one process for the entire e2e run, on port 8098) —
// it isn't scoped per camera id or per browser page, because the app's
// upstream requests to the mock never say which cams-camera id they're for.
// So this test can only be trusted while it is the ONLY thing touching the
// mock. That's arranged three ways:
//   - test.describe.serial, so this file's own test(s) never run concurrently
//     with each other;
//   - `fullyParallel: false` on this file's Playwright project (below,
//     playwright.config.ts), which stops Playwright scheduling this file's
//     tests in parallel with themselves;
//   - a dedicated `live-teardown` project that `dependencies` on both
//     `desktop` and `phone` finishing first. A project's tests never start
//     until every dependency project's tests (all of them, across every
//     other spec file, including e2e/live.spec.ts, which also opens a real
//     stream to "Den") have completed, so nothing else can be mid-stream on
//     the mock while this file polls the count. It runs once, not once per
//     project, since repeating it under `phone` would just re-observe the
//     same single mock-camera process's state.
test.describe.serial('live stream teardown', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL!);
  });

  async function activeStreams(page: Page): Promise<number> {
    const res = await page.request.get('http://127.0.0.1:8098/__state');
    return (await res.json()).activeStreams;
  }

  test('switching cameras releases the old stream (client and server)', async ({ page }) => {
    await page.goto('/app/live');
    await expect(page.getByTestId('live-state')).toHaveText('Live', { timeout: 15_000 });
    await expect.poll(() => activeStreams(page), { timeout: 10_000 }).toBe(1);

    await page.getByTestId('camera-picker').selectOption('porch');
    await expect(page.getByTestId('live-state')).toHaveText('Live', { timeout: 15_000 });

    // Must settle back to 1 (the new camera's stream), not stay at 2 (the
    // old one leaked alongside the new one).
    await expect.poll(() => activeStreams(page), { timeout: 10_000 }).toBe(1);
    await page.waitForTimeout(1_500);
    expect(await activeStreams(page)).toBe(1);

    await page.goto('/app/about');
    await expect.poll(() => activeStreams(page), { timeout: 10_000 }).toBe(0);
  });
});
