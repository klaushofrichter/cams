import { readFileSync } from 'fs';
import { type Download, type Page } from '@playwright/test';
import { expect, test } from './clock';
import { signIn } from './session';
import { chicagoMs, outsideDemoClips } from './fakeProxyData';
import { eventCount, expandAllHours } from './hours';

// The Video page (spec docs/superpowers/specs/2026-10-04-video-page-design.md):
// Live and History are one page whose mode follows the player. The old URLs
// keep working; the badge says LIVE or REC; light and quality are live only;
// the snapshot saves what is on screen in either mode.
test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL!);
});

const chicagoToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const badge = (page: Page) => page.getByTestId('mode-badge');
const isJpeg = async (d: Download) => readFileSync((await d.path())!).subarray(0, 3).toString('hex') === 'ffd8ff';

test('/app/live lands on /app/video, live, titled Video', async ({ page }) => {
  await page.goto('/app/live');
  await expect(page).toHaveURL('/app/video');
  await expect(page.getByTestId('page-title')).toHaveText('Video');
  await expect(badge(page)).toHaveAttribute('data-mode', 'live');
  await expect(badge(page)).toHaveText('● LIVE', { timeout: 15_000 }); // once the live video plays
});

test('an old History link lands on /app/video at the asked day and time, as a recording', async ({ page }) => {
  const at = chicagoMs(chicagoToday(), '12:05:10'); // Den's 12:05:05 motion clip (Chicago time, DST-proof)
  await page.goto(`/app/recordings?cam=cam1&date=${chicagoToday()}&panel=history&at=${at}`);
  await expect(page).toHaveURL(new RegExp(`/app/video\\?cam=cam1&date=${chicagoToday()}&at=${at}`));
  await expect(page).not.toHaveURL(/panel=/);
  await expect(badge(page)).toHaveAttribute('data-mode', 'rec');
  await expect(badge(page)).toHaveText(/^REC \d{2}:\d{2}:\d{2}( [AP]M)? · SD$/); // a clip: the sub stream
  await expect(page.locator('[data-testid="event-card"][aria-current="true"]')).toHaveAttribute('data-clip-id', /-120505-120530$/);
  await expect(page.getByTestId('page-title')).toHaveText('Video');
});

// Klaus, 2026-10-04: REC says what it shows: SD (or 4K) for a clip, Still for the stills.
test('the REC badge says SD over a clip and Still over the stills', async ({ page }) => {
  const clipAt = chicagoMs(chicagoToday(), '12:05:10'); // Den's 12:05:05 motion clip (Chicago time, DST-proof)
  await page.goto(`/app/video?cam=cam1&date=${chicagoToday()}&at=${clipAt}`);
  await expect(badge(page)).toHaveText(/^REC \d{2}:\d{2}:\d{2}( [AP]M)? · SD$/);
  await expect(badge(page)).toHaveAttribute('aria-label', /^REC .* · SD, back to live$/);
  const stillAt = outsideDemoClips(Date.now() - 5 * 60_000); // Barn: a still every second (not in a demo clip)
  const stillDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(stillAt));
  await page.goto(`/app/video?cam=barn&date=${stillDay}&at=${stillAt}`);
  await expect(page.getByTestId('source-badge')).toHaveText('Stills 1 FPS');
  await expect(badge(page)).toHaveText(/^REC \d{2}:\d{2}:\d{2}( [AP]M)? · Still$/);
  await expect(badge(page)).toHaveAttribute('aria-label', /^REC .* · Still, back to live$/);
  // Inside the player box, at desktop and phone width.
  const b = (await badge(page).boundingBox())!;
  const box = (await page.getByTestId('strip-player').boundingBox())!;
  expect(b.x + b.width).toBeLessThanOrEqual(box.x + box.width);
});

test('an old link to another day opens that day, and the list is that day’s', async ({ page }) => {
  const yesterday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(Date.now() - 86_400_000));
  await page.goto(`/app/recordings?cam=cam1&date=${yesterday}&panel=events`);
  await expect(page).toHaveURL(new RegExp(`/app/video\\?cam=cam1&date=${yesterday}`));
  await expect(badge(page)).toHaveAttribute('data-mode', 'rec');
  await expect(badge(page)).toHaveText(/^REC [A-Z][a-z]{2} \d{1,2}, /); // another day: with the date
  await expect(page.getByTestId('events-day')).toHaveText(`Events on ${yesterday}`);
  await expect.poll(() => eventCount(page)).toBe(2); // yesterday's demo clips (22:15 may be collapsed)
});

test('scrubbing back is REC with light and quality off; ⇥ and the badge are LIVE again', async ({ page }) => {
  await page.goto('/app/video');
  await expect(page.getByTestId('live-badge')).toHaveText('● LIVE', { timeout: 15_000 });
  await expect(page.getByTestId('light-toggle')).toBeEnabled(); // Den has a light
  await page.getByTestId('back-10').click();
  await expect(badge(page)).toHaveAttribute('data-mode', 'rec');
  await expect(badge(page)).toHaveText(/^REC /);
  await expect(page).toHaveURL(/\/app\/video\?.*at=\d+/);
  // Off but focusable, named, and a click says why on screen (review of #173).
  const light = page.getByTestId('light-toggle');
  await expect(light).toHaveAttribute('aria-disabled', 'true');
  await expect(light).toHaveAttribute('title', 'Only in live mode');
  await expect(page.getByRole('button', { name: 'Light — only in live mode' })).toBeVisible();
  const quality = page.getByTestId('quality-toggle'); // only where the browser plays H.265
  if (await quality.count()) {
    await expect(quality).toHaveAttribute('aria-disabled', 'true');
    await expect(quality).toHaveAttribute('aria-label', 'Quality — only in live mode');
  }
  // Fullscreen works in both modes (#182, e2e/fullscreen.spec.ts).
  const fullscreen = page.getByTestId('fullscreen');
  await expect(fullscreen).not.toHaveAttribute('aria-disabled', 'true');
  await expect(fullscreen).toHaveAttribute('aria-label', 'Fullscreen');
  await expect(page.getByTestId('live-only-note')).toHaveAttribute('data-shown', 'false');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); // the hidden note takes no room
  await light.click({ force: true });
  await expect(page.getByTestId('live-only-note')).toBeVisible();
  await page.getByTestId('back-1').click(); // still a recording; the note stays until live
  await expect(page.getByTestId('live-only-note')).toBeVisible();
  await light.click({ force: true }); // aria-disabled: Playwright calls it not enabled, a user can still click
  await expect(page.getByTestId('live-only-note')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByTestId('live-only-note')).toHaveText('Quality and light work only in live mode.');
  await expect(light).toHaveAttribute('aria-pressed', 'false'); // nothing switched
  await expect(page.getByTestId('mute-toggle')).toBeEnabled(); // sound stays
  await page.getByTestId('strip-now').click(); // ⇥
  await expect(badge(page)).toHaveAttribute('data-mode', 'live');
  await expect(page).toHaveURL(/\/app\/video$/);
  await expect(light).not.toHaveAttribute('aria-disabled', 'true');
  await expect(fullscreen).toHaveAttribute('aria-label', 'Fullscreen');
  await expect(page.getByTestId('live-only-note')).toHaveCount(0);
  await page.getByTestId('back-10').click();
  await expect(badge(page)).toHaveAttribute('data-mode', 'rec');
  await badge(page).click(); // the REC badge
  await expect(badge(page)).toHaveAttribute('data-mode', 'live');
  await expect(page.getByTestId('live-badge')).toHaveText('● LIVE', { timeout: 15_000 });
});

test('the snapshot saves a JPEG in both modes, named live, rec or still', async ({ page }) => {
  await page.goto('/app/video');
  await expect(page.getByTestId('live-badge')).toHaveText('● LIVE', { timeout: 15_000 });
  const save = async () => {
    const [d] = await Promise.all([page.waitForEvent('download'), page.getByTestId('snapshot').click()]);
    expect(await isJpeg(d)).toBe(true);
    return d.suggestedFilename();
  };
  expect(await save()).toMatch(/^cam1-live-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.jpg$/);

  // A recording's frame: the clip's own picture, at the moment shown. Its
  // hour may be collapsed, more than 6 h from now (issue #213).
  await expandAllHours(page);
  await page.locator('[data-testid="event-card"][data-clip-id*="-120505-"]').click();
  const video = page.getByTestId('clip-video');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState >= 2 && v.currentTime > 0.5), { timeout: 15_000 }).toBe(true);
  await page.getByTestId('play-toggle').click();
  await expect(page.getByTestId('play-toggle')).toHaveAttribute('aria-pressed', 'false');
  expect(await save()).toMatch(/^cam1-rec-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.jpg$/);
  await expect(page.getByTestId('snapshot-error')).toHaveCount(0);

  // The proxy's still (Den's fake proxy keeps one every 10 s of the last minutes; not in a demo clip).
  const at = outsideDemoClips(Math.floor((Date.now() - 120_000) / 60_000) * 60_000 + 20_000, 60_000);
  await page.goto(`/app/video?cam=cam1&at=${at}`);
  await expect(page.getByTestId('source-badge')).toHaveText(/Stills 1 FPS|Preview 1 FPS/);
  await expect(page.getByTestId('strip-still').or(page.getByTestId('strip-preview'))).toBeVisible();
  expect(await save()).toBe(`cam1-still-${new Date(at).toISOString().slice(0, 19).replace(/[:T]/g, '-')}.jpg`);
});

test('the camera card links the name and the proxy, and shows the status', async ({ page }) => {
  await page.goto('/app/video');
  const card = page.getByTestId('camera-card');
  await expect(card.getByTestId('camera-card-name')).toHaveText('Den');
  await expect(card.getByTestId('camera-status')).toHaveAttribute('data-state', 'online', { timeout: 15_000 });
  await expect(card.getByTestId('camera-card-proxy')).toHaveText(/Proxy/);
  await page.getByTestId('camera-picker').selectOption({ label: 'Garage' });
  await expect(card.getByTestId('camera-card-name')).toHaveText('Garage');
  await expect(card.getByTestId('camera-status')).toHaveAttribute('data-state', 'offline');
  await expect(card.getByTestId('camera-card-proxy')).toHaveCount(0);
  // No model or firmware in the sidebar: they are on Settings.
  await expect(page.getByTestId('live-camera-model')).toHaveCount(0);
});

// Klaus, 2026-10-04: the popup over the timeline names the clip's types with
// icons, says Still over the stills, and has one size for both. The pointer
// rests on the playhead (the bar's centre is `at` at any zoom).
test('the timeline popup shows the clip’s types, or Still, in one box size', async ({ page }, info) => {
  test.skip(info.project.name === 'phone', 'hover: desktop only');
  const hoverCentre = async () => {
    const bar = (await page.getByTestId('timeline').boundingBox())!;
    await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2 + 6);
    await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2);
    await expect(page.getByTestId('scrub-preview')).toBeVisible();
    await page.waitForTimeout(300); // the picture after its 150 ms rest
    return (await page.getByTestId('scrub-preview').boundingBox())!;
  };
  const clipAt = chicagoMs(chicagoToday(), '08:15:20'); // Den's person recording (two person events)
  await page.goto(`/app/video?cam=cam1&date=${chicagoToday()}&at=${clipAt}`);
  await expect(badge(page)).toHaveText(/· SD$/);
  const overClip = await hoverCentre();
  const person = page.locator('[data-testid="scrub-kind"][data-kind="person"]');
  await expect(person).toHaveAttribute('aria-label', 'Person 2x');
  await expect(person).toHaveText('2x');
  await expect(person.locator('svg')).toBeVisible();
  await expect(page.getByTestId('scrub-kind').first()).toHaveAttribute('data-kind', 'person'); // its only type
  const stillAt = outsideDemoClips(Math.floor((Date.now() - 3 * 60_000) / 1000) * 1000); // Den's preview tiles: the last ten minutes
  const stillDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(stillAt));
  await page.goto(`/app/video?cam=cam1&date=${stillDay}&at=${stillAt}`);
  await expect(page.getByTestId('source-badge')).toHaveText(/Stills 1 FPS|Preview 1 FPS/);
  const overStill = await hoverCentre();
  await expect(page.getByTestId('scrub-kind')).toHaveCount(1);
  await expect(page.getByTestId('scrub-kind')).toHaveAttribute('data-kind', 'still');
  await expect(page.getByTestId('scrub-kind')).toHaveAttribute('aria-label', 'Still');
  expect(Math.round(overStill.width)).toBe(Math.round(overClip.width));
  expect(Math.round(overStill.height)).toBe(Math.round(overClip.height));
});

// Klaus, 2026-10-04: with the pointer resting on the timeline while it
// plays, the popup follows the time moving under it.
test('the timeline popup follows playback under a resting pointer', async ({ page }, info) => {
  test.skip(info.project.name === 'phone', 'hover: desktop only');
  const at = outsideDemoClips(Math.floor((Date.now() - 4 * 60_000) / 1000) * 1000); // Den's preview tiles: the last ten minutes, not a demo clip
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(at));
  await page.goto(`/app/video?cam=cam1&date=${day}&at=${at}`);
  await expect(page.getByTestId('source-badge')).toHaveText(/Stills 1 FPS|Preview 1 FPS/);
  // The page has its first picture before the bar is measured and hovered
  // (issue #213: a bar that moves afterwards leaves the pointer elsewhere).
  await expect(page.getByTestId('strip-still').or(page.getByTestId('strip-preview'))).toBeVisible();
  await page.getByTestId('play-toggle').click();
  await expect(page.getByTestId('play-toggle')).toHaveAttribute('aria-pressed', 'true');
  const bar = (await page.getByTestId('timeline').boundingBox())!;
  await page.mouse.move(bar.x + bar.width / 2 - 1, bar.y + bar.height / 2 + 6);
  await page.mouse.move(bar.x + bar.width / 2 - 1, bar.y + bar.height / 2);
  const time = page.getByTestId('scrub-preview').getByTestId('strip-cursor-time');
  await expect(time).toBeVisible();
  const first = await time.textContent();
  await expect.poll(() => time.textContent(), { timeout: 5000 }).not.toBe(first);
  await expect(page.getByTestId('scrub-kind')).toHaveAttribute('data-kind', 'still');
  await page.mouse.move(bar.x + bar.width / 2, bar.y - 60); // off the bar: no popup
  await expect(page.getByTestId('scrub-preview')).toHaveCount(0);
});
