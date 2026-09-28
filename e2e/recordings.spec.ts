import { expect, test, type Page } from '@playwright/test';
import { signIn } from './session';

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
  await expect(page.getByTestId('event-card').first()).toContainText('08:15:10');
  await expect(page.getByTestId('event-card').first()).toContainText('Person');
  const thumb = page.getByTestId('event-thumb').first();
  await expect.poll(() => thumb.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
});

test('selecting an event plays it and puts it in the URL', async ({ page }) => {
  await openEvents(page);
  await page.getByTestId('event-card').nth(2).click();
  await expect(page).toHaveURL(/clip=\d{8}-120505-120530/);
  const video = page.getByTestId('clip-video');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState >= 2 && v.currentTime > 0.5), { timeout: 15_000 }).toBe(true);
  await expect(page.getByTestId('event-card').nth(2)).toHaveAttribute('aria-current', 'true');
});

test('skip, pause and next/previous recording work', async ({ page }) => {
  await openEvents(page);
  await page.getByTestId('event-card').first().click();
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

test('filters narrow the list and an empty filter says so', async ({ page }) => {
  await openEvents(page);
  await page.getByTestId('filter-person').click();
  await expect(page.getByTestId('event-card')).toHaveCount(1);
  await expect(page).toHaveURL(/filter=person/);
  await page.getByTestId('filter-all').click();
  await expect(page.getByTestId('event-card')).toHaveCount(4);
});

test('the cursor carries across panels and back from another page', async ({ page }, testInfo) => {
  await openEvents(page);
  await page.getByTestId('event-card').nth(1).click();
  await page.getByTestId('panel-tab-downloads').click();
  await expect(page.locator('[data-testid="download-row"][aria-current="true"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="download-row"][aria-current="true"]')).toHaveAttribute('data-clip-id', /-093000-093020$/);
  // leave and come back through the menu
  if (testInfo.project.name === 'phone') {
    await page.getByTestId('hamburger').click();
    await page.getByTestId('drawer').getByTestId('nav-live').click();
    await page.getByTestId('hamburger').click();
    await page.getByTestId('drawer').getByTestId('nav-events').click();
  } else {
    await page.getByTestId('sidebar').getByTestId('nav-live').click();
    await page.getByTestId('sidebar').getByTestId('nav-events').click();
  }
  await expect(page.locator('[data-testid="event-card"][aria-current="true"]')).toHaveAttribute('data-clip-id', /-093000-093020$/);
});

test('a deep link restores the selection after reload', async ({ page }) => {
  await openEvents(page);
  await page.getByTestId('event-card').nth(3).click();
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

test('previous day shows yesterday\'s recordings; a day without any says so', async ({ page }) => {
  await openEvents(page);
  await page.getByTestId('day-prev').click();
  await expect(page.getByTestId('event-card')).toHaveCount(2);
  await page.goto('/app/recordings?date=2001-01-01&panel=events');
  await expect(page.getByTestId('no-recordings')).toBeVisible();
});

test('downloads return MP4 attachments with readable names', async ({ page }) => {
  await page.goto('/app/recordings?panel=downloads');
  const href = await page.getByTestId('download-main').first().getAttribute('href');
  const res = await page.request.get(href!);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe('video/mp4');
  expect(res.headers()['content-disposition']).toMatch(/^attachment; filename="cam1-\d{4}-\d{2}-\d{2}_08-15-10-main\.mp4"$/);
});

test('the Live page mini timeline opens a recording', async ({ page }) => {
  await page.goto('/app/live');
  const bar = page.getByTestId('live-timeline');
  const seg = bar.getByTestId('timeline-seg').first();
  await expect(seg).toBeVisible();
  // On the phone viewport the timeline sits below the fold. Locator.click()
  // with a `position` offset re-derives the element's box internally right
  // before dispatching, and on this page that lands the synthetic event
  // off-target (the surrounding sticky top bar interferes with its
  // actionability scroll) -- so scroll into view ourselves and dispatch a
  // real mouse click at the coordinates we measured, which is reliable here.
  await bar.scrollIntoViewIfNeeded();
  await expect(seg).toBeInViewport();
  // Retried as a whole: a scroll that lands mid-animation (or a stale box
  // measured just before a layout shift) can make a single measure+click
  // pass land off-target, so re-measure and re-click until the navigation
  // actually happens.
  await expect(async () => {
    const segBox = (await seg.boundingBox())!;
    const y = segBox.y + segBox.height / 2;
    await page.mouse.click(segBox.x + segBox.width / 2, y);
    await expect(page).toHaveURL(/\/app\/recordings\?.*clip=\d{8}-081510-081535/);
  }).toPass({ timeout: 10_000 });
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
  await page.getByTestId('event-card').first().click();
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
  await page.getByTestId('event-card').first().click();
  await expect(page).toHaveURL(/[?&]cam=cam1(&|$)/);

  await page.goto('/app/live');
  await page.getByTestId('camera-picker').selectOption('porch');
  await expect(page.getByTestId('camera-picker')).toHaveValue('porch');

  if (testInfo.project.name === 'phone') {
    await page.getByTestId('hamburger').click();
    await page.getByTestId('drawer').getByTestId('nav-events').click();
  } else {
    await page.getByTestId('sidebar').getByTestId('nav-events').click();
  }
  await expect(page.getByTestId('camera-picker')).toHaveValue('porch');
  await expect(page).toHaveURL(/[?&]cam=porch(&|$)/);
});

// Picking a zoom saves it as a preference; every test here shares one user,
// so the save is answered in the browser and never reaches the server.
async function keepZoomLocal(page: import('@playwright/test').Page) {
  const current = await (await page.request.get('/api/preferences')).json();
  await page.route('**/api/preferences', async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...current, ...route.request().postDataJSON() }) });
  });
}

test('zoom is kept when an event card is clicked, and across pages', async ({ page }) => {
  await keepZoomLocal(page);
  await openEvents(page);
  await page.getByTestId('zoom-3').click();
  await expect(page.getByTestId('zoom-3')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('event-card').nth(1).click();
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
  await page.getByTestId('event-card').nth(0).click();
  await page.getByTestId('event-card').nth(1).click();
  await page.getByTestId('event-card').nth(2).click();
  await expect(page.getByTestId('event-card').nth(2)).toHaveAttribute('aria-current', 'true');
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
    await page.getByTestId('event-card').nth(1).click();
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
  await expect(page.getByTestId('event-card').first()).toBeVisible();
  // Lazy thumbnails load once visible; their 503s trigger a re-check.
  await expect(page.getByTestId('recordings-unavailable')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('recordings-unavailable')).toContainText('camera-side problem');
});


// Plan 6: Barn refuses downloads like Shed, but has a cam-proxy whose clip
// (the fake in test/proxy/fakeProxy.ts, one clip covering today) plays.
test('a camera with a cam-proxy plays its recordings from the proxy', async ({ page }) => {
  await page.goto('/app/recordings?cam=barn&panel=events');
  await page.getByTestId('event-card').first().click();
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
  const d = new Date();
  const earlyToday = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 1).getTime(); // Shed: no proxy, no event at 00:01
  await page.goto(`/app/recordings?cam=shed&panel=history&at=${earlyToday}`);
  await expect(page.getByTestId('source-badge')).toHaveText('No recording');
  await expect(page.getByTestId('strip-empty')).toBeVisible();
});

test('dragging the strip to yesterday changes the date and the list', async ({ page }) => {
  await keepZoomLocal(page); // the zoom is a shared user's preference
  const d = new Date();
  const earlyToday = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 30).getTime();
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
  const id = await page.getByTestId('event-card').nth(2).getAttribute('data-clip-id');
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
});
