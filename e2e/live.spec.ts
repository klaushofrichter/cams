import { expect, test } from '@playwright/test';
import { signIn } from './session';

// Browser-side evidence for CI-only failures. Console errors/warnings and
// page errors are forwarded to the test output as they happen. Everything
// else (mpegts.js info/debug logs plus a timeline of <video> media events) is
// buffered and printed only when a test fails, so passing runs stay quiet.
const MEDIA_EVENTS = ['loadedmetadata', 'loadeddata', 'canplay', 'play', 'playing', 'pause', 'waiting', 'stalled', 'error', 'emptied'];
let buffered: string[] = [];

test.beforeEach(async ({ context, baseURL, page }) => {
  await signIn(context, baseURL!);
  buffered = [];
  const t0 = Date.now();
  const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(2)}s`;
  page.on('console', (msg) => {
    const line = `[browser ${msg.type()}] ${stamp()} ${msg.text()}`;
    if (msg.type() === 'error' || msg.type() === 'warning') console.log(line);
    else buffered.push(line);
  });
  page.on('pageerror', (err) => console.log(`[pageerror] ${stamp()} ${err.message}`));
  // Chrome's own media pipeline log (what chrome://media-internals shows):
  // decoder and renderer choices, errors, and why playback did not start.
  const cdp = await context.newCDPSession(page);
  cdp.on('Media.playerMessagesLogged', ({ messages }) => {
    for (const m of messages) buffered.push(`[media-internals ${m.level}] ${stamp()} ${m.message}`);
  });
  cdp.on('Media.playerErrorsRaised', ({ errors }) => {
    for (const e of errors) console.log(`[media-internals error] ${stamp()} ${JSON.stringify(e)}`);
  });
  cdp.on('Media.playerEventsAdded', ({ events }) => {
    for (const e of events) buffered.push(`[media-internals event] ${stamp()} ${e.value}`);
  });
  cdp.on('Media.playerPropertiesChanged', ({ properties }) => {
    for (const p of properties) buffered.push(`[media-internals prop] ${stamp()} ${p.name}=${p.value}`);
  });
  await cdp.send('Media.enable');
  await page.addInitScript((events: string[]) => {
    for (const type of events) {
      document.addEventListener(
        type,
        (e) => {
          const v = e.target as HTMLVideoElement;
          if (!(v instanceof HTMLMediaElement)) return;
          const ranges = Array.from({ length: v.buffered.length }, (_, i) => `${v.buffered.start(i).toFixed(2)}-${v.buffered.end(i).toFixed(2)}`);
          console.debug(
            `[media] ${type} readyState=${v.readyState} paused=${v.paused} t=${v.currentTime.toFixed(2)} buffered=[${ranges.join(',')}]` +
              (v.error ? ` error=${v.error.code}:${v.error.message}` : ''),
          );
        },
        true,
      );
    }
  }, MEDIA_EVENTS);
});

test.afterEach(async ({}, testInfo) => {
  if ((testInfo.status !== testInfo.expectedStatus || process.env.DUMP_BROWSER_LOG) && buffered.length) {
    console.log(`--- browser log for "${testInfo.title}" ---\n${buffered.join('\n')}`);
  }
});

// Evidence first: which browser this is and whether it can play what the
// camera sends (H.264 baseline + AAC through MSE, which is what mpegts.js
// needs). A runner without it must fail here, loudly, not as a vague timeout.
test('browser supports H.264 + AAC through MSE', async ({ page, browser }) => {
  await page.goto('/app/live');
  const info = await page.evaluate(() => ({
    userAgent: navigator.userAgent,
    mse: typeof MediaSource !== 'undefined',
    mseH264Aac: MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E, mp4a.40.2"'),
    mseH264: MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E"'),
    mseAac: MediaSource.isTypeSupported('audio/mp4; codecs="mp4a.40.2"'),
    canPlayH264: document.createElement('video').canPlayType('video/mp4; codecs="avc1.42001E, mp4a.40.2"'),
  }));
  // navigator.userAgent comes from the device descriptor, so it is not proof
  // of the real browser; browser.version() is.
  console.log(`[browser-support] version=${browser.version()} ${JSON.stringify(info)}`);
  expect(info.mseH264Aac, `this browser cannot play H.264 + AAC through MSE: ${info.userAgent}`).toBe(true);
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
