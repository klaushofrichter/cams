import { expect, test, type Page } from '@playwright/test';
import { signIn } from './session';
import { FAKE_PROXY_PORT, FAKE_PROXY_TOKEN, motionStillMs, vehicleDetectionMs } from './fakeProxyData';

// The simulated cameras' demo clips (cam-sim DEMO_CLIPS, CAMSIM_SEED_CLIPS=demo):
// today 08:15:10 person, 09:30:00 vehicle, 12:05:05 motion, 17:45:40 pet;
// yesterday 07:00:00 motion, 22:15:10 person. Browser zone = America/Chicago.
// e2e/cameras.json: cam1 "Den" (cam-sim on 8098) and porch "Porch" (a separate
// cam-sim on 8097, see e2e/sims.ts) both start with the same demo
// clips (CAMSIM_SEED_CLIPS=demo), so they share the
// same clip data even though they're different processes; garage is offline.
test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL!);
});

// A card by its clip's start time (the list is newest first).
const card = (page: Page, hhmmss: string) => page.locator(`[data-testid="event-card"][data-clip-id*="-${hhmmss}-"]`);

async function openEvents(page: Page) {
  await page.goto('/app/recordings?panel=events');
  await expect(page.getByTestId('event-card')).toHaveCount(4);
}

// The playwright.config.ts timezoneId is America/Chicago; the simulator's clips
// are keyed on the browser's local (i.e. Chicago) date, so "today" for the
// tests must be computed the same way rather than in the runner's own zone.
function chicagoToday(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

test('events list shows today\'s recordings with triggers and thumbnails', async ({ page }) => {
  await openEvents(page);
  await expect(page.getByTestId('event-card').first()).toContainText('17:45:40'); // newest first
  await expect(card(page, '081510')).toContainText('Person');
  const thumb = page.getByTestId('event-thumb').first();
  await expect.poll(() => thumb.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
});

// Issue #157: a vehicle card's thumbnail is the proxy's still at the second
// the vehicle was detected (the fake's Den event 6 s in, with a still of its
// own), not the start of the recording; a motion card keeps the still 2 s in.
async function thumbBytes(page: Page, hhmmss: string): Promise<Buffer> {
  const thumb = card(page, hhmmss).getByTestId('event-thumb');
  await thumb.scrollIntoViewIfNeeded(); // lazy
  await expect.poll(() => thumb.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  return (await page.request.get((await thumb.getAttribute('src'))!)).body();
}
const proxyStill = async (page: Page, ts: number) =>
  (await page.request.get(`http://127.0.0.1:${FAKE_PROXY_PORT}/api/cameras/cam1/stills/${ts}.jpg`, { headers: { Authorization: `Bearer ${FAKE_PROXY_TOKEN}` } })).body();

test('a vehicle card shows the still from the moment it was detected', async ({ page }) => {
  await openEvents(page);
  expect(Buffer.compare(await thumbBytes(page, '093000'), await proxyStill(page, vehicleDetectionMs()))).toBe(0);
});

test('a motion card keeps the still 2 s into the recording', async ({ page }) => {
  await openEvents(page);
  expect(Buffer.compare(await thumbBytes(page, '120505'), await proxyStill(page, motionStillMs()))).toBe(0);
});

test('selecting an event plays it and puts it in the URL', async ({ page }) => {
  await openEvents(page);
  await card(page, '120505').click();
  await expect(page).toHaveURL(/clip=\d{8}-120505-120530/);
  const video = page.getByTestId('clip-video');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState >= 2 && v.currentTime > 0.5), { timeout: 15_000 }).toBe(true);
  await expect(card(page, '120505')).toHaveAttribute('aria-current', 'true');
});

test('skip, pause and next/previous recording work', async ({ page }) => {
  await openEvents(page);
  await card(page, '081510').click();
  const video = page.getByTestId('clip-video');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime > 0.3), { timeout: 15_000 }).toBe(true);
  await page.getByTestId('play-toggle').click();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  const before = await video.evaluate((v: HTMLVideoElement) => v.currentTime);
  await page.getByTestId('fwd-10').click();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(before + 5);
  await page.getByTestId('back-10').click();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeLessThan(before + 5);
  await page.getByTestId('next-clip').click();
  await expect(page).toHaveURL(/clip=\d{8}-093000-093020/);
  await page.getByTestId('prev-clip').click();
  await expect(page).toHaveURL(/clip=\d{8}-081510-081535/);
});

// ⏮ << < ▶ > >> ⏭ (Klaus, 2026-10-03): one-second steps beside the 10 s ones;
// a step on a paused clip shows that frame. One row on a phone too.
test('one-second steps move a paused clip, and the bar fits one row', async ({ page }) => {
  await openEvents(page);
  await card(page, '081510').click();
  const video = page.getByTestId('clip-video');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime > 2.5), { timeout: 15_000 }).toBe(true);
  await page.getByTestId('play-toggle').click();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  const t0 = await video.evaluate((v: HTMLVideoElement) => v.currentTime);
  await page.getByTestId('back-1').click();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(t0 - 1, 0);
  await page.getByTestId('fwd-1').click();
  await page.getByTestId('fwd-1').click();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(t0 + 1, 0);
  // the new frame is decoded, not a pending seek
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => !v.seeking && v.readyState >= 2)).toBe(true);
  expect(await video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);

  for (const [id, name] of [['back-10', 'Back 10 seconds'], ['back-1', 'Back 1 second'], ['fwd-1', 'Forward 1 second'], ['fwd-10', 'Forward 10 seconds']]) {
    await expect(page.getByRole('button', { name, exact: true })).toHaveAttribute('data-testid', id);
  }
  const ids = ['prev-clip', 'back-10', 'back-1', 'play-toggle', 'fwd-1', 'fwd-10', 'next-clip'];
  const boxes = await Promise.all(ids.map(async (id) => (await page.getByTestId(id).boundingBox())!));
  const width = page.viewportSize()!.width;
  for (let i = 0; i < boxes.length; i++) {
    expect(Math.abs(boxes[i].y - boxes[0].y)).toBeLessThan(2); // one row
    expect(boxes[i].x + boxes[i].width).toBeLessThanOrEqual(width);
    if (i) expect(boxes[i].x).toBeGreaterThan(boxes[i - 1].x); // in this order
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('filters narrow the list and an empty filter says so', async ({ page }) => {
  await keepPrefsLocal(page);
  await openEvents(page);
  await page.getByTestId('filter-person').click();
  await expect(page.getByTestId('event-card')).toHaveCount(1);
  await expect(page).not.toHaveURL(/filter=/); // the saved preference only (Klaus, 2026-10-03)
  await page.getByTestId('filter-all').click();
  await expect(page.getByTestId('event-card')).toHaveCount(4);
});

test('the cursor carries across panels and back from another page', async ({ page }, testInfo) => {
  await openEvents(page);
  await card(page, '093000').click();
  // leave and come back through the menu
  if (testInfo.project.name === 'phone') {
    await page.getByTestId('hamburger').click();
    await page.getByTestId('drawer').getByTestId('nav-live').click();
    await page.getByTestId('hamburger').click();
    await page.getByTestId('drawer').getByTestId('nav-history').click();
  } else {
    await page.getByTestId('sidebar').getByTestId('nav-live').click();
    await page.getByTestId('sidebar').getByTestId('nav-history').click();
  }
  await expect(page.locator('[data-testid="event-card"][aria-current="true"]')).toHaveAttribute('data-clip-id', /-093000-093020$/);
});

test('a deep link restores the selection after reload', async ({ page }) => {
  await openEvents(page);
  await card(page, '174540').click();
  const url = page.url();
  await page.goto(url);
  await expect(page.locator('[data-testid="event-card"][aria-current="true"]')).toHaveAttribute('data-clip-id', /-174540-174605$/);
});

test('clicking the timeline selects the recording under the click', async ({ page }) => {
  await page.goto('/app/recordings?panel=history');
  const seg = page.locator('[data-testid="timeline-seg"][data-clip-id$="-120505-120530"]');
  await expect(seg).toBeVisible();
  const box = (await seg.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page).toHaveURL(/clip=\d{8}-120505-120530/);
});

// iPhone, 2026-09-29: selecting a clip on the strip scrolled the page down to
// its card in the list, and the video left the screen.
test('on a phone, selecting a clip on the strip keeps the page where it is', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'phone layout only');
  await page.goto('/app/recordings?panel=history');
  const seg = page.locator('[data-testid="timeline-seg"][data-clip-id$="-081510-081535"]'); // the oldest: the lowest card
  await expect(seg).toBeVisible();
  // The app may scroll its own content area rather than the window: measure
  // where the video is on the screen.
  const video = page.locator('.player .box');
  const before = (await video.boundingBox())!.y;
  const box = (await seg.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page).toHaveURL(/clip=\d{8}-081510-081535/);
  await page.waitForTimeout(500);
  // The video stays on the screen (a small shift from the header's contents is fine).
  const after = (await video.boundingBox())!.y;
  expect(after).toBeGreaterThanOrEqual(0);
  expect(Math.abs(after - before)).toBeLessThan(40);
});

// Klaus, 2026-09-29: on a phone, a tap on a card's thumbnail scrolls up to
// the player; a tap elsewhere on the card keeps the list in view.
test('on a phone, the thumbnail brings the player into view, the rest of the card does not', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'phone layout only');
  await page.goto('/app/recordings?panel=history');
  const video = page.locator('.player .box');
  const card = page.locator('[data-testid="event-card"][data-clip-id$="-081510-081535"]');
  await card.scrollIntoViewIfNeeded();
  expect((await video.boundingBox())!.y).toBeLessThan(0); // scrolled away
  // A touch on the card's text: it lies over the card's button and lets the touch through (issue #113).
  const meta = (await page.locator('li', { has: card }).locator('.meta strong').boundingBox())!;
  await page.touchscreen.tap(meta.x + 5, meta.y + meta.height / 2);
  await expect(card).toHaveAttribute('aria-current', 'true');
  await page.waitForTimeout(600);
  expect((await video.boundingBox())!.y).toBeLessThan(0); // still the list
  await card.locator('[data-testid="event-thumb"]').click();
  await expect.poll(async () => (await video.boundingBox())!.y).toBeGreaterThanOrEqual(0);
});

// Klaus, 2026-09-29: collapse or expand all hour groups; "Expand hours"
// only when every hour is collapsed.
test('the hours button collapses and expands them all, and offers Collapse hours once one is opened', async ({ page }) => {
  await page.goto('/app/recordings?panel=history');
  const btn = page.getByTestId('hours-toggle');
  const toggles = page.getByTestId('hour-toggle');
  await expect(toggles.first()).toBeVisible();
  await expect(btn).toHaveText('Collapse hours');
  await btn.click();
  await expect(btn).toHaveText('Expand hours');
  for (const t of await toggles.all()) await expect(t).toHaveAttribute('aria-expanded', 'false');
  await toggles.first().click();
  await expect(btn).toHaveText('Collapse hours');
  await btn.click();
  await btn.click();
  for (const t of await toggles.all()) await expect(t).toHaveAttribute('aria-expanded', 'true');
});

test('previous day shows yesterday\'s recordings; a day without any says so', async ({ page }) => {
  await openEvents(page);
  await page.getByTestId('day-prev').click();
  await expect(page.getByTestId('event-card')).toHaveCount(2);
  // Before the oldest content: History opens on the oldest day instead.
  await page.goto('/app/recordings?date=2001-01-01&panel=events');
  await expect.poll(() => new URL(page.url()).searchParams.get('date')).not.toBe('2001-01-01');
});

test('downloads return MP4 attachments with readable names', async ({ page }) => {
  // Den's fake proxy holds no SD recordings (503), so whether the dialog offers
  // 4K depends on a recent camera download (mainAvailable); this test is about
  // the file's name, so the dialog is told 4K is there.
  await page.route('**/full-quality', (r) => r.fulfill({ json: { available: true } }));
  await page.goto('/app/recordings?panel=history');
  await page.getByTestId('event-download').first().click();
  await page.getByTestId('compose-size').selectOption('4k');
  const href = await page.getByTestId('compose-save').getAttribute('href');
  const res = await page.request.get(href!);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe('video/mp4');
  expect(res.headers()['content-disposition']).toMatch(/^attachment; filename="cam1-\d{4}-\d{2}-\d{2}_17-45-40-main\.mp4"$/); // the newest is first
});

// Final review, minor 4: a camera without a cam-proxy saves 4K as before: the
// plain link, no /full-quality question.
test('a camera without a cam-proxy saves 4K straight from the link, asking nothing', async ({ page }) => {
  let asked = 0;
  page.on('request', (req) => {
    if (req.url().endsWith('/full-quality')) asked++;
  });
  await page.goto(`/app/recordings?cam=porch&date=${chicagoToday()}&panel=history`);
  await page.getByTestId('event-download').first().click();
  await page.getByTestId('compose-size').selectOption('4k');
  const download = page.waitForEvent('download');
  await page.getByTestId('compose-save').click();
  expect((await download).suggestedFilename()).toMatch(/^porch-\d{4}-\d{2}-\d{2}_17-45-40-main\.mp4$/);
  expect(asked).toBe(0);
});

test('the Live panel lists today’s events, newest first, and plays one', async ({ page }) => {
  await page.goto('/app/live');
  const rows = page.getByTestId('live-latest');
  await expect(rows.first()).toBeVisible();
  const times = await rows.evaluateAll((els) => els.map((e) => e.parentElement!.querySelector('[data-testid="live-latest-time"]')!.textContent!));
  expect(times.length).toBeGreaterThan(1);
  expect(times.length).toBeLessThanOrEqual(5); // Klaus, 2026-09-29: up to five
  expect([...times].sort().reverse()).toEqual(times);
  await rows.first().click();
  await expect(page.getByTestId('live-badge')).toHaveCount(0);
  await expect(page.getByTestId('source-badge')).toContainText(/SD 10 FPS|Stills|No recording/);
  await expect(page).toHaveURL(/\/app\/recordings\?.*at=\d+.*panel=history/); // History (Klaus, 2026-09-28)
});

test('the video stays in place between Live and History', async ({ page }) => {
  await page.goto('/app/live');
  const box = () => page.locator('.player .box').boundingBox();
  await expect(page.getByTestId('live-panel')).toBeVisible();
  const a = await box();
  await page.getByTestId('panel-tab-history').click();
  await expect(page.getByTestId('page-title')).toHaveText('History');
  const b = await box();
  expect(b).toEqual(a);
});

// --- Pinned review fixes, with no automated coverage yet ---

test('a cold-load deep link to a second camera stays on it', async ({ page }) => {
  const today = chicagoToday();
  await page.goto(`/app/recordings?cam=porch&date=${today}&panel=events`);
  await expect(page.getByTestId('camera-picker')).toHaveValue('porch');
  await expect(page).toHaveURL(/[?&]cam=porch(&|$)/);
  await page.reload();
  await expect(page.getByTestId('camera-picker')).toHaveValue('porch');
  await expect(page).toHaveURL(/[?&]cam=porch(&|$)/);
});

test('the header picker on Recordings switches the page and does not flip back', async ({ page }) => {
  await openEvents(page);
  await card(page, '081510').click();
  await expect(page).toHaveURL(/clip=/);
  await page.getByTestId('camera-picker').selectOption('porch');
  await expect(page).toHaveURL(/[?&]cam=porch(&|$)/);
  // The strip opens the new camera on its own first recording, not Den's clip.
  await expect(page).toHaveURL(/cam=porch.*clip=\d{8}-081510-081535/);
  // wait for the switched camera's own events to load (settles the effects
  // that sync the picker and the URL) and confirm the picker held.
  await expect(page.getByTestId('event-card')).toHaveCount(4);
  await expect(page.getByTestId('camera-picker')).toHaveValue('porch');
});

test('a picker choice made on Live survives navigating through the sidebar', async ({ page }, testInfo) => {
  // First create a saved cursor for cam1 by visiting recordings and
  // selecting a clip on cam1.
  await openEvents(page);
  await card(page, '081510').click();
  await expect(page).toHaveURL(/[?&]cam=cam1(&|$)/);

  await page.goto('/app/live');
  await page.getByTestId('camera-picker').selectOption('porch');
  await expect(page.getByTestId('camera-picker')).toHaveValue('porch');

  if (testInfo.project.name === 'phone') {
    await page.getByTestId('hamburger').click();
    await page.getByTestId('drawer').getByTestId('nav-history').click();
  } else {
    await page.getByTestId('sidebar').getByTestId('nav-history').click();
  }
  await expect(page.getByTestId('camera-picker')).toHaveValue('porch');
  await expect(page).toHaveURL(/[?&]cam=porch(&|$)/);
});

// Picking a zoom or an event filter saves it as a preference; every test here
// shares one user, so the save is answered in the browser and never reaches
// the server (e2e/event-filter.spec.ts saves the filter for real, as its own users).
async function keepPrefsLocal(page: import('@playwright/test').Page) {
  const current = await (await page.request.get('/api/preferences')).json();
  await page.route('**/api/preferences', async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...current, ...route.request().postDataJSON() }) });
  });
}

test('zoom is kept when an event card is clicked, and across pages', async ({ page }) => {
  await keepPrefsLocal(page);
  await openEvents(page);
  await page.getByTestId('zoom-3').click();
  await expect(page.getByTestId('zoom-3')).toHaveAttribute('aria-pressed', 'true');
  await card(page, '093000').click();
  await expect(page.getByTestId('zoom-3')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.bar-skeleton')).toHaveCount(0);
  await expect(page.getByTestId('timeline')).toBeVisible();
  // Another page and back, without a reload.
  await page.evaluate(() => { history.pushState({}, '', '/app/live'); dispatchEvent(new PopStateEvent('popstate')); });
  await expect(page.getByTestId('page-title')).toHaveText('Live');
  await page.evaluate(() => history.back());
  await expect(page.getByTestId('zoom-3')).toHaveAttribute('aria-pressed', 'true');
});

test('clip clicks do not re-fetch the day\'s events', async ({ page }) => {
  await openEvents(page);
  await page.waitForLoadState('networkidle'); // the strip's own day loads (one day either side) land first
  // The day's own list: the strip may load a neighbouring day when the
  // window moves, which is new data, not a re-fetch.
  const day = new URL(page.url()).searchParams.get('date');
  let eventsRequests = 0;
  page.on('request', (req) => {
    if (/\/api\/cameras\/[^/]+\/events\?/.test(req.url()) && req.url().includes(`date=${day}`)) eventsRequests++;
  });
  await card(page, '081510').click();
  await card(page, '093000').click();
  await card(page, '120505').click();
  await expect(card(page, '120505')).toHaveAttribute('aria-current', 'true');
  // Lets any in-flight request actually land before counting: without this,
  // a slow or still-pending events fetch could resolve after the assertion
  // below and be missed entirely rather than caught as a failure.
  await page.waitForLoadState('networkidle');
  expect(eventsRequests).toBe(0);
});

test('History opens on the day\'s first recording', async ({ page }) => {
  await page.goto('/app/recordings?panel=history');
  await expect(page).toHaveURL(/clip=\d{8}-081510-081535/);
});

test('events are grouped by hour and a busy hour starts collapsed', async ({ page }) => {
  await page.goto('/app/recordings?panel=events');
  await expect(page.getByTestId('hour-group')).toHaveCount(4); // 08, 09, 12, 17 in the demo clips
  await expect(page.getByTestId('hour-count').first()).toHaveText('1 event');
});

// Isolated in its own describe: page.clock.install() replaces the page's
// timers wholesale, which is risky alongside the other tests' real video
// playback (mpegts.js and <video> rely on real timers/rAF).
test.describe('today auto-refresh', () => {
  // Porch: no cam-proxy, so it polls (Den's proxy stream replaces polling, Plan 6).
  test('today refreshes on its own and keeps the selection', async ({ page }) => {
    await page.clock.install();
    await page.goto('/app/recordings?cam=porch&panel=events');
    await expect(page.getByTestId('event-card')).toHaveCount(4);
    await card(page, '093000').click();
    const first = await page.getByTestId('events-updated').textContent();
    const requests: string[] = [];
    page.on('request', (r) => r.url().includes('/events?') && requests.push(r.url()));
    await page.clock.runFor(61_000);
    await expect.poll(() => requests.length).toBeGreaterThan(0);
    await expect(page.getByTestId('events-updated')).not.toHaveText(first!);
    await expect(page.locator('[data-testid="event-card"][aria-current="true"]')).toHaveAttribute('data-clip-id', /-093000-093020$/);
  });
});

// Plan 5: a camera that refuses every recording download (the real camera
// since 2026-09-26). After a few refused thumbnails the server's breaker
// opens, and Recordings says so instead of showing silent black boxes.
test('a camera that refuses downloads gets a clear banner', async ({ page }) => {
  await page.goto('/app/recordings?cam=shed&panel=events');
  await expect(card(page, '081510')).toBeVisible();
  // Lazy thumbnails load once visible; their 503s trigger a re-check.
  await expect(page.getByTestId('recordings-unavailable')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('recordings-unavailable')).toContainText('camera-side problem');
});


// Plan 6: Barn refuses downloads like Shed, but has a cam-proxy whose clip
// (the fake in test/proxy/fakeProxy.ts, one clip covering today) plays.
test('a camera with a cam-proxy plays its recordings from the proxy', async ({ page }) => {
  await page.goto('/app/recordings?cam=barn&panel=events');
  await card(page, '081510').click();
  const video = page.locator('video').first();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
  await expect(page.getByTestId('recordings-unavailable')).toHaveCount(0);
});

// The continuous strip (spec 2026-09-27).
test('the strip plays proxy stills in real time, and says so', async ({ page }) => {
  const at = Date.now() - 5 * 60_000;
  await page.goto(`/app/recordings?cam=barn&panel=history&at=${at}`);
  await expect(page.getByTestId('source-badge')).toHaveText('Stills 1 FPS');
  await expect.poll(() => page.getByTestId('strip-still').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  const before = new URL(page.url()).searchParams.get('at');
  await page.getByTestId('play-toggle').click();
  await expect.poll(() => new URL(page.url()).searchParams.get('at'), { timeout: 10_000 }).not.toBe(before);
});

test('a stretch with nothing recorded says so', async ({ page }) => {
  // Shed: no proxy, no event at 00:01 (the browser's day, not the runner's).
  const earlyToday = await page.evaluate(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 1).getTime(); });
  await page.goto(`/app/recordings?cam=shed&panel=history&at=${earlyToday}`);
  await expect(page.getByTestId('source-badge')).toHaveText('No recording');
  await expect(page.getByTestId('strip-empty')).toBeVisible();
});

test('dragging the strip to yesterday changes the date and the list', async ({ page }) => {
  await keepPrefsLocal(page); // the zoom is a shared user's preference
  // In the browser's zone (America/Chicago), not the runner's (UTC on CI):
  // between 00:00 and 05:00 UTC they are different days.
  const earlyToday = await page.evaluate(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 30).getTime(); });
  await page.goto(`/app/recordings?panel=history&at=${earlyToday}`);
  await page.getByTestId('zoom-3').click();
  const bar = page.getByTestId('timeline');
  const box = (await bar.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.95, box.y + 20, { steps: 8 }); // ~1.35 h back
  await page.mouse.up();
  const today = await page.evaluate(() => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`; });
  await expect.poll(() => new URL(page.url()).searchParams.get('date')).not.toBe(today);
  await expect(page.getByTestId('day-picker')).not.toHaveValue(today);
});

test('an old link with clip and t opens at that moment', async ({ page }) => {
  await openEvents(page);
  const id = await card(page, '120505').getAttribute('data-clip-id');
  const date = new URL(page.url()).searchParams.get('date');
  await page.goto(`/app/recordings?date=${date}&clip=${id}&t=3&panel=history`);
  await expect(page.locator('[data-testid="event-card"][aria-current="true"]')).toHaveAttribute('data-clip-id', id!);
  await expect(page.getByTestId('source-badge')).toHaveText('SD 10 FPS');
});

test('on a phone the strip and controls fit the width', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'phone layout');
  await page.goto('/app/recordings?panel=history');
  await expect(page.getByTestId('timeline')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  // The seven zooms, 24 h to 1 min, on one row (Klaus, 2026-10-04).
  const zooms = page.locator('[data-testid^="zoom-"]');
  await expect(zooms).toHaveText(['24 h', '6 h', '3 h', '1 h', '30 min', '10 min', '1 min']);
  const boxes = await zooms.evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ top: r.top, right: r.right, left: r.left })));
  for (const b of boxes) {
    expect(b.top).toBe(boxes[0].top);
    expect(b.left).toBeGreaterThanOrEqual(0);
    expect(b.right).toBeLessThanOrEqual(390);
  }
});

// Edges and the info line (Klaus, 2026-09-28).
test('⇥ goes to now and stops there; the line under the video names time, source and trigger', async ({ page }) => {
  await page.goto('/app/recordings?cam=barn&panel=history&at=' + (Date.now() - 5 * 60_000));
  await page.getByTestId('strip-now').click();
  await expect(page.getByTestId('strip-now')).toBeDisabled();
  // Within seconds of now (the fake proxy's stills stop when it started, so
  // the source there may be stills or nothing).
  await expect.poll(async () => Date.now() - Number(new URL(page.url()).searchParams.get('at'))).toBeLessThan(15_000);
  await openEvents(page);
  await card(page, '081510').click(); // 08:15:10, person
  await expect(page.getByTestId('strip-info')).toContainText(/SD 10 FPS · Person/);
});

test('an old Events link opens History; the menu has no Events entry', async ({ page }) => {
  await page.goto('/app/recordings?panel=events');
  await expect(page.getByTestId('panel-tab-history')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('panel-tab-events')).toHaveCount(0);
  await expect(page.getByTestId('nav-events')).toHaveCount(0);
});

// Klaus, 2026-09-29: Downloads joined History (a download button on each card).
test('an old Downloads link opens History; the menu has no Downloads entry', async ({ page }) => {
  await page.goto('/app/recordings?panel=downloads');
  await expect(page.getByTestId('panel-tab-history')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('panel-tab-downloads')).toHaveCount(0);
  await expect(page.getByTestId('nav-downloads')).toHaveCount(0);
  await expect(page.getByTestId('event-download').first()).toBeVisible();
});

// Live events (Klaus, 2026-09-28): the fake proxy sends a person event for
// Barn (no other test counts Barn's requests, so the reloads it causes are harmless).
test('a new event shows at once: a top-bar notification and a "recording…" entry', async ({ page }) => {
  await keepPrefsLocal(page); // the zoom change below must not reach the shared user
  await page.goto('/app/recordings?cam=barn&panel=history');
  await expect(page.getByTestId('timeline')).toBeVisible();
  const push = () => page.request.post(`http://127.0.0.1:${FAKE_PROXY_PORT - 2}/push`, { data: { cam: 'barn', type: 'camera-event', data: { eventId: 99, kind: 'person', phase: 'start', ts: Date.now(), source: 'onvif' } } });
  // Until the page is subscribed, an event can go by unseen: send until one shows.
  await expect.poll(async () => {
    await push();
    await page.waitForTimeout(250);
    return (await page.getByTestId('live-notice').allTextContents()).join('').trim(); // no waiting
  }, { timeout: 15_000 }).toBe('Person on Barn');
  await expect(page.getByTestId('event-pending').first()).toContainText('Person');
  // The events sent 0.25 s apart are one recording: one entry (Klaus, 2026-09-30).
  await expect(page.getByTestId('event-pending')).toHaveCount(1);
  // Its text sits right beside the red dot, not where a card's text clears the thumbnail (review fix).
  const pending = page.getByTestId('event-pending').first();
  await expect(pending.locator('.meta')).toHaveCSS('margin-left', '0px');
  const dot = (await pending.locator('.dot').boundingBox())!;
  const meta = (await pending.locator('.meta').boundingBox())!;
  expect(meta.x - (dot.x + dot.width)).toBeLessThanOrEqual(12);
  // Another preference change (the zoom) keeps it (review #1).
  await page.getByTestId('zoom-3').click();
  await expect(page.getByTestId('event-pending').first()).toContainText('Person');
});


test('names the source of recordings and thumbnails: cam-proxy or camera (Klaus, 2026-09-28)', async ({ page }) => {
  // Den's fake cam-proxy holds no SD recordings (it answers 503), so cams
  // falls back, and clips would come from the proxy's FTP copies.
  await page.goto('/app/recordings?panel=history&cam=cam1');
  await expect(page.getByTestId('recordings-source')).toHaveText('Source of recordings and thumbnails: cam-proxy (FTP copies)');
  await page.goto('/app/recordings?panel=history&cam=porch');
  await expect(page.getByTestId('recordings-source')).toHaveText('Source of recordings and thumbnails: camera');
});

// Wide windows (Klaus, 2026-09-28): the whole app, top bar included, is
// centred with equal margins; no gap between the sidebar and the video.
test('a wide window centres the whole app, top bar included', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'desktop only');
  await page.setViewportSize({ width: 2400, height: 1000 });
  await page.goto('/app/recordings?panel=history&cam=cam1');
  await expect(page.getByTestId('event-card').first()).toBeVisible();
  const top = (await page.locator('.topbar').boundingBox())!;
  const side = (await page.getByTestId('sidebar').boundingBox())!;
  const box = (await page.locator('.player .box').boundingBox())!;
  expect(top.x).toBeGreaterThan(100); // margins, not full width
  expect(Math.abs(top.x - (2400 - (top.x + top.width)))).toBeLessThan(2); // equal either side
  expect(Math.abs(side.x - top.x)).toBeLessThan(2); // the sidebar starts where the top bar does
  expect(box.x - (side.x + side.width)).toBeLessThan(40); // just the page padding before the video
  // A window no wider than the app fills it, as before.
  await page.setViewportSize({ width: 1400, height: 1000 });
  expect((await page.locator('.topbar').boundingBox())!.x).toBe(0);
});

// Issue #69 items.
test('a day that failed to load names no source', async ({ page }) => {
  await page.route(/\/api\/cameras\/cam1\/events\?date=/, (r) => r.fulfill({ status: 502, json: { error: 'camera_offline' } }));
  await page.goto('/app/recordings?panel=history&cam=cam1');
  await expect(page.getByText('The recordings could not be loaded')).toBeVisible();
  await expect(page.getByTestId('recordings-source')).toHaveCount(0);
});

test('filter chips do not add browser history entries', async ({ page }) => {
  await keepPrefsLocal(page);
  await page.goto('/app/recordings?panel=history&cam=cam1');
  await expect(page.getByTestId('event-card').first()).toBeVisible();
  const before = await page.evaluate(() => history.length);
  await page.getByTestId('filter-person').click();
  await page.getByTestId('filter-vehicle').click();
  await expect(page.getByTestId('filter-vehicle')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => history.length)).toBe(before);
  await expect(page).not.toHaveURL(/filter=/);
});
