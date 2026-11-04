import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { expect, test, type Page, type Route } from '@playwright/test';
import { signIn } from './session';
import { expandAllHours } from './hours';
import { chicagoIso, chicagoMs } from './fakeProxyData';

// While the playhead is inside an event's span, its card is highlighted
// (Klaus, 2026-11-04). The list doesn't follow: a card scrolled away, filtered
// out or in a collapsed hour isn't brought back, and shows the highlight as
// soon as it is on screen again.
test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL!);
});

const chicagoDay = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(ms));
// Yesterday: all in the past, whatever time of day this runs.
const DAY = () => chicagoDay(Date.now() - 86_400_000);

function event(date: string, start: string, end: string, trigger: string) {
  const compact = (t: string) => t.replaceAll(':', '');
  const s = chicagoMs(date, start);
  const e = chicagoMs(date, end);
  return {
    id: `${date.replaceAll('-', '')}-${compact(start)}-${compact(end)}`, start: chicagoIso(date, start), end: chicagoIso(date, end),
    durationSec: (e - s) / 1000, triggers: [trigger], sizeSub: 1, sizeMain: 1,
  };
}
// A and B overlap; a gap; C; and enough others for the list to scroll.
function day(date: string) {
  const pad = (n: number) => String(n).padStart(2, '0');
  const others = Array.from({ length: 12 }, (_, i) => pad(6 + i)).flatMap((h) =>
    ['15', '30', '45'].map((m) => event(date, `${h}:${m}:00`, `${h}:${m}:20`, 'motion')));
  return {
    a: event(date, '10:00:00', '10:00:20', 'person'),
    b: event(date, '10:00:10', '10:00:30', 'vehicle'),
    c: event(date, '10:02:00', '10:02:04', 'motion'),
    others,
  };
}

// Longer than any event here: the player treats a seek past a video's end as that clip's end.
const CLIP_S = 30;
let mp4: Buffer;
test.beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'cams-e2e-highlight-'));
  execFileSync(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10', '-t', String(CLIP_S),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '10', '-movflags', '+faststart', join(dir, 'clip.mp4')]);
  mp4 = readFileSync(join(dir, 'clip.mp4'));
});

function serveMp4(route: Route) {
  const m = /bytes=(\d+)-(\d*)/.exec(route.request().headers()['range'] ?? '');
  if (!m) return route.fulfill({ status: 200, contentType: 'video/mp4', headers: { 'Accept-Ranges': 'bytes' }, body: mp4 });
  const from = Number(m[1]);
  const to = m[2] ? Math.min(Number(m[2]), mp4.length - 1) : mp4.length - 1;
  return route.fulfill({
    status: 206, contentType: 'video/mp4', body: mp4.subarray(from, to + 1),
    headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${from}-${to}/${mp4.length}` },
  });
}

// `events` on `date`; every clip plays; a filter change is never saved for the shared user.
async function stub(page: Page, date: string, events: ReturnType<typeof event>[]) {
  await page.route('**/api/preferences', async (route) => {
    if (route.request().method() !== 'GET') return route.fulfill({ json: route.request().postDataJSON() });
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), eventFilter: ['person', 'vehicle', 'pet', 'motion'] } });
  });
  await page.route(/\/api\/cameras\/cam1\/events\?date=/, async (route) => {
    if (new URL(route.request().url()).searchParams.get('date') !== date) return route.fallback();
    await route.fulfill({ json: { date, events, downloads: 'ok' } });
  });
  await page.route(/\/api\/cameras\/cam1\/clips\/[^/]+\/video/, serveMp4);
}

const marked = (page: Page) => page.locator('[data-testid="event-card"][data-at-playhead="true"]');
const card = (page: Page, id: string) => page.locator(`[data-testid="event-card"][data-clip-id="${id}"]`);
async function expectMarked(page: Page, ids: string[]) {
  await expect.poll(async () => (await marked(page).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.clipId!))).sort()).toEqual([...ids].sort());
}

async function open(page: Page, hms: string) {
  const date = DAY();
  const d = day(date);
  await stub(page, date, [d.a, d.b, d.c, ...d.others]);
  await page.goto(`/app/video?cam=cam1&date=${date}&at=${chicagoMs(date, hms)}`);
  await expect(page.getByTestId('mode-badge')).toHaveAttribute('data-mode', 'rec');
  await expandAllHours(page);
  return d;
}

test('follows seeking and stepping, while paused: overlaps, gaps, and a bar besides the colour', async ({ page }) => {
  const { a, b, c } = await open(page, '10:00:05');
  await expectMarked(page, [a.id]);
  const bar = await card(page, a.id).evaluate((el) => getComputedStyle(el.closest('li')!, '::after').width);
  expect(bar).toBe('4px');

  await page.getByTestId('fwd-10').click(); // 10:00:15
  await expectMarked(page, [a.id, b.id]);
  await expect(page.locator('[data-testid="event-card"][aria-current="true"]')).toHaveCount(1); // the one the player shows

  await page.getByTestId('fwd-10').click(); // 10:00:25
  await expectMarked(page, [b.id]);
  await page.getByTestId('fwd-10').click(); // 10:00:35, the gap
  await expectMarked(page, []);
  await page.getByTestId('next-clip').click();
  await expectMarked(page, [c.id]);
  await page.getByTestId('prev-clip').click(); // B's start
  await expectMarked(page, [a.id, b.id]);
});

test('comes and goes while playing', async ({ page }) => {
  const { c } = await open(page, '10:01:58');
  await expectMarked(page, []);
  await page.getByTestId('play-toggle').click();
  await expect(card(page, c.id)).toHaveAttribute('data-at-playhead', 'true', { timeout: 10_000 }); // from the gap into C
  await expect(card(page, c.id)).not.toHaveAttribute('data-at-playhead', 'true', { timeout: 15_000 }); // and out of it
  await expectMarked(page, []);
});

test('a filtered-out card stays out, and shows it as soon as the filter lets it back', async ({ page }) => {
  const { a, b } = await open(page, '10:00:25'); // inside B only
  await expectMarked(page, [b.id]);
  await page.locator('.side').getByTestId('filter-person').click();
  await expect(card(page, b.id)).toHaveCount(0);
  await expect(card(page, a.id)).toBeVisible();
  await expectMarked(page, []);
  await page.locator('.side').getByTestId('filter-all').click();
  await expect(card(page, b.id)).toHaveAttribute('data-at-playhead', 'true');
});

test('a collapsed hour stays collapsed, and its card shows it when opened', async ({ page }) => {
  const { a, b } = await open(page, '10:00:05');
  const hour = page.locator('[data-testid="hour-group"][data-hour="10"]');
  await hour.getByTestId('hour-toggle').click();
  await expect(hour.getByTestId('hour-toggle')).toHaveAttribute('aria-expanded', 'false');
  await page.getByTestId('fwd-10').click(); // 10:00:15, inside A and B
  await expect(hour.getByTestId('hour-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(marked(page)).toHaveCount(0);
  await hour.getByTestId('hour-toggle').click();
  await expectMarked(page, [a.id, b.id]);
});

test('the list stays put: a card scrolled away is left there, and shows it when scrolled back', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'the list scrolls by itself on a desktop');
  const { a, b, c } = await open(page, '10:00:35'); // the gap
  const list = page.getByTestId('event-scroll');
  await expectMarked(page, []);

  // A's card out of the list's view, at whichever end leaves it far away.
  await list.evaluate((el, id) => {
    const r = () => el.querySelector(`[data-clip-id="${id}"]`)!.getBoundingClientRect();
    el.scrollTop = 0;
    const box = el.getBoundingClientRect();
    if (r().top < box.bottom) el.scrollTop = el.scrollHeight;
  }, a.id);
  const scrollTop = await list.evaluate((el) => el.scrollTop);
  const outOfView = () => list.evaluate((el, id) => {
    const r = el.querySelector(`[data-clip-id="${id}"]`)!.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    return r.bottom <= box.top || r.top >= box.bottom;
  }, a.id);
  expect(await outOfView()).toBe(true);

  await page.getByTestId('back-10').click(); // 10:00:25, inside B
  await expectMarked(page, [b.id]);
  await page.getByTestId('back-10').click(); // 10:00:15, inside A and B
  await expectMarked(page, [a.id, b.id]);
  await page.getByTestId('next-clip').click(); // a step: C
  await expectMarked(page, [c.id]);
  await page.getByTestId('prev-clip').click(); // and back: A and B
  await expectMarked(page, [a.id, b.id]);
  // Long enough for a scroll on its way (the list's own, after a tick).
  await page.waitForTimeout(300);
  expect(await list.evaluate((el) => el.scrollTop)).toBe(scrollTop);
  expect(await outOfView()).toBe(true);

  await card(page, a.id).scrollIntoViewIfNeeded();
  await expect(card(page, a.id)).toBeInViewport();
  await expect(card(page, a.id)).toHaveAttribute('data-at-playhead', 'true');
});

test('a link to a spot still brings that card into view', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'the list scrolls by itself on a desktop');
  const date = DAY();
  const d = day(date);
  await stub(page, date, [d.a, d.b, d.c, ...d.others]);
  await page.goto(`/app/video?cam=cam1&date=${date}&at=${chicagoMs(date, '10:00:05')}`);
  await expect(card(page, d.a.id)).toBeInViewport();
  await expect(card(page, d.a.id)).toHaveAttribute('data-at-playhead', 'true');
});

test('live shows no highlight, even with a clip reaching past now; a recording does again', async ({ page }) => {
  const now = Date.now();
  const today = chicagoDay(now);
  const hms = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(ms));
  // Today's only (a camera clock ahead of the browser's): from the day's start at the earliest.
  const start = Math.max(now - 20_000, chicagoMs(today, '00:00:00'));
  const running = { ...event(today, hms(start), hms(start), 'motion'), start: new Date(start).toISOString(), end: new Date(now + 10_000).toISOString(), durationSec: 30 };
  await stub(page, today, [running]);
  await page.goto('/app/video');
  await expect(page.getByTestId('mode-badge')).toHaveAttribute('data-mode', 'live');
  await expect(card(page, running.id)).toBeVisible();
  await expect(marked(page)).toHaveCount(0);
  await expect(page.locator('[data-testid="event-card"][aria-current="true"]')).toHaveCount(0);

  await page.getByTestId('back-10').click();
  await expect(page.getByTestId('mode-badge')).toHaveAttribute('data-mode', 'rec');
  await expectMarked(page, [running.id]);
});
