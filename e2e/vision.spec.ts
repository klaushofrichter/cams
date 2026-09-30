import { expect, test, type Page } from '@playwright/test';
import { FAKE_PROXY_PORT } from './fakeProxyData';
import { signIn } from './session';

// Vision in cams (spec 2026-09-30-analytics-in-cams-design, in cam-proxy).
// Den (cam1) has cam-sim's demo recordings (today 08:15:10 person, …) and the
// fake cam-proxy. A test hook stores an analysis for today's person card, and
// the stream message announces it, as cam-proxy does. The fake and cams keep
// state across tests and projects, so each analysis carries a unique subtype
// and the tests look for that.
const HOOKS = `http://127.0.0.1:${FAKE_PROXY_PORT - 2}`;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const box = { x0: 0.2, y0: 0.3, x1: 0.4, y1: 0.9 };
interface Card { id: string; start: string; end: string; triggers: string[] }

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL!);
});

async function personCard(page: Page): Promise<Card> {
  const r = await page.request.get(`/api/cameras/cam1/events?date=${today()}`);
  expect(r.ok()).toBe(true);
  const card = ((await r.json()) as { events: Card[] }).events.find((e) => e.triggers.includes('person'));
  expect(card, "cam-sim's demo person clip of today").toBeTruthy();
  return card!;
}

// Stores an analysis of the card's person event and sends its stream message.
async function analyse(page: Page, card: Card): Promise<{ eventId: number; stillTs: number; subtype: string }> {
  const eventId = 100_000 + Math.floor(Math.random() * 900_000);
  const subtype = `e2e-${eventId}`;
  const start = Date.parse(card.start) + 1000;
  const stillTs = start + 1000;
  const msg = { eventId, kind: 'person', start, end: start + 4000, provider: 'google-vision', status: 'ok', reason: null, stillTs, summary: [{ category: 'person', subtype, score: 0.84, box }] };
  const objects = [{ name: 'Person', score: 0.84, box }, { name: 'Ceiling fan', score: 0.7, box: { x0: 0.5, y0: 0.05, x1: 0.8, y1: 0.2 } }];
  expect((await page.request.post(`${HOOKS}/analyses`, { data: { cam: 'cam1', analysis: { ...msg, objects } } })).ok()).toBe(true);
  expect((await page.request.post(`${HOOKS}/push`, { data: { cam: 'cam1', type: 'analysis', data: msg } })).ok()).toBe(true);
  return { eventId, stillTs, subtype };
}

const badge = (page: Page, card: Card) => page.locator(`[data-testid="event-card"][data-clip-id="${card.id}"]`).locator('[data-testid="vision-badge"][data-kind="agree"]');

test('a card shows Vision’s confidence next to the camera’s label', async ({ page }) => {
  const card = await personCard(page);
  const { subtype } = await analyse(page, card);
  await page.goto(`/app/recordings?cam=cam1&panel=history&date=${today()}`);
  await expect(badge(page, card)).toHaveText(/^✦ Vision \d+%$/);
  await expect(badge(page, card)).toHaveAttribute('title', new RegExp(subtype));
});

test('a new analysis updates the open page without a reload', async ({ page }) => {
  const card = await personCard(page);
  // The push must come after the page's EventSource is attached.
  const stream = page.waitForResponse((r) => r.url().includes('/api/events/stream'));
  await page.goto(`/app/recordings?cam=cam1&panel=history&date=${today()}`);
  await stream;
  await expect(page.locator(`[data-testid="event-card"][data-clip-id="${card.id}"]`)).toBeVisible();
  const { subtype } = await analyse(page, card);
  await expect(badge(page, card)).toHaveAttribute('title', new RegExp(subtype), { timeout: 15_000 });
});

test('Live’s recent events show the badge too', async ({ page }) => {
  const card = await personCard(page);
  const { subtype } = await analyse(page, card);
  await page.goto('/app/live');
  await page.getByTestId('camera-picker').selectOption('cam1');
  await expect(page.getByTestId('live-recent').locator(`[data-testid="vision-badge"][data-kind="agree"][title*="${subtype}"]`).first()).toBeVisible();
});

test('the Timeline marks the analysed second and shows its boxes; "Open in History" lands paused', async ({ page }) => {
  const card = await personCard(page);
  const { stillTs } = await analyse(page, card);
  const minute = Math.floor(stillTs / 60_000) * 60_000;
  await page.goto(`/app/timeline?cam=cam1&date=${today()}`);
  const tile = page.locator(`[data-testid="timeline-minute"][data-minute="${minute}"]`);
  await expect(tile).toHaveClass(/analysed/);
  await tile.click();
  const second = page.locator(`[data-testid="timeline-second"][data-ts="${stillTs}"]`);
  await expect(second).toHaveClass(/analysed/);
  await second.click();
  await expect(page.getByTestId('timeline-still')).toHaveAttribute('src', `/api/cameras/cam1/stills/${stillTs}.jpg`);
  await expect(page.locator('[data-testid="timeline-boxes"] rect')).toHaveCount(1);
  await page.getByTestId('timeline-show-all').check();
  await expect(page.locator('[data-testid="timeline-boxes"] rect')).toHaveCount(2);
  await page.getByTestId('timeline-open-history').click();
  await expect.poll(() => new URL(page.url()).searchParams.get('at')).toBe(String(stillTs));
  await expect(page.getByTestId('source-badge')).toBeVisible();
  await expect(page.getByTestId('play-toggle')).toHaveAttribute('aria-pressed', 'false');
});
