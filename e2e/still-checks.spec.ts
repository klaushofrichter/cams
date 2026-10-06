import { expect, test, type Page } from '@playwright/test';
import { chicagoMs, FAKE_PROXY_PORT, vehicleDetectionMs } from './fakeProxyData';
import { expandAllHours } from './hours';
import { signIn } from './session';
import { CONTROL_TOKEN, SIMS } from './sims';

// Still checks on the Timeline (cams #179, spec 2026-10-04-still-checks-ui-design),
// against the fake cam-proxy implementing cam-proxy's still checks contract.
// The fake keeps its checks across tests and projects (desktop and phone run
// at once), so each test checks a second of its own: a random minute of
// yesterday, given one still per second by a test hook.
const HOOKS = `http://127.0.0.1:${FAKE_PROXY_PORT - 2}`;
const chicagoDate = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(ms));
const yesterday = () => chicagoDate(Date.now() - 86_400_000);
const box = { x0: 0.2, y0: 0.3, x1: 0.45, y1: 0.9 };
const SHOTS = process.env.CHECKS_SHOTS; // a folder: screenshots of the result (desktop/phone, light/dark)

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL!);
  // Yesterday's minutes are older than the fake's oldest seeded still, which
  // would end the second steps there: no lower bound in these specs.
  await context.route('**/api/cameras/cam1/extent', (r) => r.fulfill({ json: { oldest: null, stills: null } }));
});

// A second of yesterday with a still, and what Vision answers for it.
async function aSecond(page: Page, answer: 'person' | 'nothing'): Promise<{ at: number; date: string; minute: number }> {
  const date = yesterday();
  const hh = String(1 + Math.floor(Math.random() * 21)).padStart(2, '0');
  const mm = String(Math.floor(Math.random() * 60)).padStart(2, '0');
  const minute = chicagoMs(date, `${hh}:${mm}:00`);
  const at = minute + (5 + Math.floor(Math.random() * 50)) * 1000;
  expect((await page.request.post(`${HOOKS}/stills-minute`, { data: { cam: 'cam1', minute } })).ok()).toBe(true);
  const summary = answer === 'person' ? [{ category: 'person', subtype: 'person', score: 0.84, box }] : [];
  const objects = [...(answer === 'person' ? [{ mid: '/m/01g317', name: 'Person', score: 0.84, box }] : []), { mid: '/m/0fan', name: 'Ceiling fan', score: 0.6, box: { x0: 0.6, y0: 0.05, x1: 0.85, y1: 0.2 } }];
  expect((await page.request.post(`${HOOKS}/check-answer`, { data: { cam: 'cam1', at, summary, objects } })).ok()).toBe(true);
  return { at, date, minute };
}

const openAt = (page: Page, s: { at: number; date: string }) => page.goto(`/app/timeline?cam=cam1&date=${s.date}&t=${s.at}`);

test('check a second: the boxes, the findings, the ✧ mark and a list entry', async ({ page }, info) => {
  const s = await aSecond(page, 'person');
  await openAt(page, s);
  await expect(page.getByTestId('timeline-still')).toHaveAttribute('src', `/api/cameras/cam1/stills/${s.at}.jpg`);
  const button = page.getByTestId('still-check-button');
  await expect(button).toHaveText('✧ Check with Vision');
  await expect(button).toBeEnabled();
  await expect(page.getByTestId('still-check-usage')).toContainText('this month');
  await expect(page.locator('[data-testid="timeline-boxes"] rect')).toHaveCount(0);
  await button.click();
  await expect(page.getByTestId('still-check-result')).toContainText('✧ Vision: Person 84%');
  await expect(button).toHaveText(/^✧ Checked /);
  await expect(button).toBeDisabled();
  await expect(page.getByTestId('timeline-still')).toHaveAttribute('src', /\/api\/cameras\/cam1\/still-checks\/\d+\.jpg$/);
  await expect(page.locator('[data-testid="timeline-boxes"] rect')).toHaveCount(1);
  // The object list (#158).
  await page.getByTestId('timeline-show-all').check();
  await expect(page.getByTestId('still-object')).toHaveCount(2);
  // The marks.
  await expect(page.locator(`[data-testid="timeline-second"][data-ts="${s.at}"] [data-testid="timeline-check-mark"]`)).toHaveText('✧');
  await expect(page.locator(`[data-testid="timeline-minute"][data-minute="${s.minute}"]`)).toHaveClass(/checked/);
  // The day's list.
  await page.getByTestId('checks-chip').click();
  await expect(page.locator(`[data-testid="checks-row"][data-ts="${s.at}"]`)).toContainText('Person 84%');
  if (SHOTS) {
    // The Pi's budget as the design gives it (the fake allows 1000 checks a day for the suite).
    await page.route('**/api/cameras/cam1/analytics', (r) => r.fulfill({ json: { enabled: true, paused: null, month: { calls: 14, limit: 1000 }, today: { calls: 2, cap: 30 }, checks: { today: 2, cap: 10 } } }));
    await page.reload();
    await expect(page.getByTestId('still-check-usage')).toHaveText('14 of 1000 Vision calls this month · 2 of 10 manual checks done today');
    await page.getByTestId('checks-chip').click();
    const size = info.project.name === 'phone' ? 'phone' : 'desktop';
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      await page.getByTestId('still-check').evaluate((el) => el.scrollIntoView({ block: 'end' }));
      await page.screenshot({ path: `${SHOTS}/${size}-${theme}-result.png` });
      await page.getByTestId('checks-list').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${SHOTS}/${size}-${theme}-list.png` });
    }
  }
});

test('the same second again is the stored answer; an event’s analysis answers too', async ({ page }) => {
  const s = await aSecond(page, 'nothing');
  const first = await page.request.post('/api/cameras/cam1/still-checks', { data: { at: s.at } });
  expect(first.status()).toBe(201);
  const again = await page.request.post('/api/cameras/cam1/still-checks', { data: { at: s.at } });
  expect(again.status()).toBe(200);
  expect(await again.json()).toMatchObject({ reused: true, source: 'check', check: { stillTs: s.at, summary: [] } });
  // The page knows that one: its result at once, "nothing relevant", no button press.
  await openAt(page, s);
  await expect(page.getByTestId('still-check-result')).toContainText('nothing relevant');
  await expect(page.getByTestId('still-check-button')).toHaveText(/^✧ Checked /);
  // A second the automatic analysis already sent (it found nothing, so no ✦):
  // the button asks, and the answer says where it came from.
  const other = s.at + 1000;
  const eventId = 200_000 + Math.floor(Math.random() * 700_000);
  const analysis = { eventId, kind: 'person', start: other - 1000, end: other + 3000, provider: 'google-vision', status: 'ok', reason: null, stillTs: other, summary: [], objects: [] };
  expect((await page.request.post(`${HOOKS}/analyses`, { data: { cam: 'cam1', analysis } })).ok()).toBe(true);
  await page.getByTestId('timeline-second-next').click();
  await expect.poll(() => new URL(page.url()).searchParams.get('t')).toBe(String(other));
  await expect(page.getByTestId('still-check-button')).toHaveText('✧ Check with Vision');
  await page.getByTestId('still-check-button').click();
  await expect(page.getByTestId('still-check-reused')).toContainText('Analysed before with its event, no new call');
});

test('disabled with the reason when Vision is off, and an error in words', async ({ page }) => {
  const s = await aSecond(page, 'nothing');
  await page.route('**/api/cameras/cam1/analytics', (r) =>
    r.fulfill({ json: { enabled: false, paused: null, month: { calls: 14, limit: 1000 }, today: { calls: 2, cap: 30 }, checks: { today: 0, cap: 10 } } }),
  );
  await openAt(page, s);
  await expect(page.getByTestId('still-check-button')).toBeDisabled();
  await expect(page.getByTestId('still-check-reason')).toHaveText('Vision is off for this camera');
  await page.unroute('**/api/cameras/cam1/analytics');
  await page.route('**/api/cameras/cam1/still-checks', (r) => (r.request().method() === 'POST' ? r.fulfill({ status: 429, json: { error: 'limit', reason: 'checks' } }) : r.fallback()));
  await page.reload();
  await page.getByTestId('still-check-button').click();
  await expect(page.getByTestId('still-check-error')).toHaveText("Today's checks are used");
  await expect(page.getByTestId('still-check-button')).toBeEnabled();
});

test('a check made in another tab shows live: the list, the marks, the open still', async ({ page, context }) => {
  const s = await aSecond(page, 'person');
  const watcher = await context.newPage();
  const stream = watcher.waitForResponse((r) => r.url().includes('/api/events/stream'));
  await openAt(watcher, s);
  await stream;
  await expect(watcher.getByTestId('still-check-button')).toHaveText('✧ Check with Vision');
  await watcher.getByTestId('checks-chip').click();
  await expect(watcher.getByTestId('checks-list')).toBeVisible();
  await expect(watcher.locator(`[data-testid="checks-row"][data-ts="${s.at}"]`)).toHaveCount(0);
  await openAt(page, s);
  await page.getByTestId('still-check-button').click();
  await expect(page.getByTestId('still-check-result')).toContainText('Person 84%');
  await expect(watcher.locator(`[data-testid="checks-row"][data-ts="${s.at}"]`)).toContainText('Person 84%', { timeout: 15_000 });
  await expect(watcher.locator(`[data-testid="timeline-minute"][data-minute="${s.minute}"]`)).toHaveClass(/checked/);
  await expect(watcher.getByTestId('still-check-result')).toContainText('Person 84%');
  await expect(watcher.locator('[data-testid="timeline-boxes"] rect')).toHaveCount(1);
});

test('◀ ✧ ▶ and Shift+arrows step between the day’s checks', async ({ page }) => {
  const s = await aSecond(page, 'nothing');
  const a = s.at, b = s.at + 2000;
  for (const at of [a, b]) {
    const r = await page.request.post('/api/cameras/cam1/still-checks', { data: { at } });
    expect(r.ok(), await r.text()).toBe(true);
  }
  await openAt(page, { at: a + 1000, date: s.date });
  await expect(page.getByTestId('timeline-large-time')).toBeVisible();
  await page.getByTestId('timeline-check-next').click();
  await expect(page.getByTestId('timeline-still')).toHaveAttribute('src', /still-checks\/\d+\.jpg$/);
  await expect.poll(() => new URL(page.url()).searchParams.get('t')).toBe(String(b));
  await page.keyboard.press('Shift+ArrowLeft');
  await expect.poll(() => new URL(page.url()).searchParams.get('t')).toBe(String(a));
  await page.keyboard.press('ArrowRight'); // plain arrows: one second (#159)
  await expect.poll(() => new URL(page.url()).searchParams.get('t')).toBe(String(a + 1000));
});

test('a check that finds the card’s label confirms the card like an automatic analysis', async ({ page }) => {
  const at = vehicleDetectionMs();
  test.skip(Date.now() < at + 2000, "Den's vehicle second is later today");
  const vehicle = [{ category: 'vehicle', subtype: 'car', score: 0.91, box }];
  expect((await page.request.post(`${HOOKS}/check-answer`, { data: { cam: 'cam1', at, summary: vehicle, objects: [{ name: 'Car', score: 0.91, box }] } })).ok()).toBe(true);
  const r = await page.request.post('/api/cameras/cam1/still-checks', { data: { at } });
  expect(r.ok()).toBe(true);
  const date = chicagoDate(at);
  await page.goto(`/app/recordings?cam=cam1&panel=history&date=${date}`);
  const card = page.locator('li', { has: page.locator('[data-testid="event-card"]') }).filter({ has: page.locator('[data-testid="vision-badge"][data-kind="agree"][title*="Car"]') });
  await expect(card.first()).toBeVisible({ timeout: 15_000 });
  await card.first().locator('[data-testid="vision-badge"][data-kind="agree"]').click();
  await expect(page.getByTestId('vision-dialog-checked')).toContainText('checked by hand');
});

// A check that confirms a card reaches the Video page without a reload
// (Klaus, 2026-10-04: a pet card stayed "Vision: not confirmed" after a
// Timeline check until the browser reloaded). Each test gets a person
// recording of its own on Barn (a camera with a cam-proxy whose past days no
// other spec uses), two days ago at a random minute, seeded into cam-sim; a
// `clip` message makes cams list the day again (and the days next to it, so
// not today), as cam-proxy's does for a new recording.
const BARN = `http://127.0.0.1:${SIMS.barn.control}`;
async function aPersonCard(page: Page): Promise<{ date: string; minute: number; clipId: string }> {
  await page.context().route('**/api/cameras/barn/extent', (r) => r.fulfill({ json: { oldest: null, stills: null } }));
  const date = chicagoDate(Date.now() - 2 * 86_400_000);
  const hh = String(1 + Math.floor(Math.random() * 21)).padStart(2, '0');
  const mm = String(Math.floor(Math.random() * 60)).padStart(2, '0');
  const r = await page.request.post(`${BARN}/sim/api/recordings/seed`, { headers: { Authorization: `Bearer ${CONTROL_TOKEN}` }, data: { clips: [{ daysAgo: 2, start: `${hh}${mm}00`, end: `${hh}${mm}40`, triggers: ['person'] }] } });
  expect(r.status(), await r.text()).toBe(201);
  const minute = chicagoMs(date, `${hh}:${mm}:00`);
  expect((await page.request.post(`${HOOKS}/stills-minute`, { data: { cam: 'barn', minute } })).ok()).toBe(true);
  for (let s = 0; s < 40; s++) {
    expect((await page.request.post(`${HOOKS}/check-answer`, { data: { cam: 'barn', at: minute + s * 1000, summary: [{ category: 'person', subtype: 'person', score: 0.77, box }], objects: [{ mid: '/m/01g317', name: 'Person', score: 0.77, box }] } })).ok()).toBe(true);
  }
  expect((await page.request.post(`${HOOKS}/push`, { data: { cam: 'barn', type: 'clip', data: { ts: minute } } })).ok()).toBe(true);
  const clipId = `${date.replace(/-/g, '')}-${hh}${mm}00-${hh}${mm}40`;
  // cams lists it (the message is handled asynchronously).
  await expect.poll(async () => ((await (await page.request.get(`/api/cameras/barn/events?date=${date}`)).json()) as { events: { id: string }[] }).events.some((e) => e.id === clipId)).toBe(true);
  return { date, minute, clipId };
}
const cardBadge = (page: Page, clipId: string) => page.locator('li', { has: page.locator(`[data-testid="event-card"][data-clip-id="${clipId}"]`) }).locator('[data-testid="vision-badge"][data-kind="agree"]');
async function menu(page: Page, id: string) {
  if (await page.getByTestId('hamburger').isVisible()) {
    await page.getByTestId('hamburger').click();
    await page.getByTestId('drawer').getByTestId(`nav-${id}`).click();
  } else await page.getByTestId('sidebar').getByTestId(`nav-${id}`).click();
}

test('a Timeline check that confirms a card of a past day: back on the Video page by the menu, the card says so, no reload', async ({ page }) => {
  const c = await aPersonCard(page);
  await page.goto(`/app/video?cam=barn&date=${c.date}&at=${c.minute + 10_000}`);
  await expandAllHours(page);
  await expect(page.locator(`[data-testid="event-card"][data-clip-id="${c.clipId}"]`)).toBeVisible();
  await expect(cardBadge(page, c.clipId)).toHaveCount(0);
  await page.evaluate(() => ((window as unknown as { noReload: boolean }).noReload = true));
  await page.getByTestId('show-in-timeline').click();
  await expect(page).toHaveURL(/\/app\/timeline\?/);
  await expect(page.getByTestId('still-check-button')).toHaveText('✧ Check with Vision');
  await page.getByTestId('still-check-button').click();
  await expect(page.getByTestId('still-check-result')).toContainText('Person 77%');
  // The menu opens the Video page on today; the day is picked there (no reload).
  await menu(page, 'video');
  await expect(page).toHaveURL(/\/app\/video/);
  await page.getByTestId('day-picker').fill(c.date);
  await expect(page.getByTestId('events-day')).toHaveText(`Events on ${c.date}`);
  await expandAllHours(page); // the day pick collapsed its far hours
  await expect(cardBadge(page, c.clipId)).toHaveText('✦ Vision 77%', { timeout: 15_000 });
  expect(await page.evaluate(() => (window as unknown as { noReload?: boolean }).noReload)).toBe(true);
});

test('a check made in another tab updates the open Video page’s card live', async ({ page, context }) => {
  const c = await aPersonCard(page);
  const watcher = await context.newPage();
  const stream = watcher.waitForResponse((r) => r.url().includes('/api/events/stream'));
  await watcher.goto(`/app/video?cam=barn&date=${c.date}&at=${c.minute + 5000}`);
  await stream;
  await expandAllHours(watcher);
  await expect(watcher.locator(`[data-testid="event-card"][data-clip-id="${c.clipId}"]`)).toBeVisible();
  await expect(cardBadge(watcher, c.clipId)).toHaveCount(0);
  const r = await page.request.post('/api/cameras/barn/still-checks', { data: { at: c.minute + 20_000 } });
  expect(r.status(), await r.text()).toBe(201);
  await expect(cardBadge(watcher, c.clipId)).toHaveText('✦ Vision 77%', { timeout: 15_000 });
});
