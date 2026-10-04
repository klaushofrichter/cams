import { expect, test, type Page } from '@playwright/test';
import { signIn } from './session';

// Video page stage 2 (spec docs/superpowers/specs/2026-10-04-video-page-design.md):
// hours more than 6 h from the viewed time collapse when the viewer lands on
// a new spot, never while dragging or playing; hand toggles survive a later
// landing; thumbnails load only near the screen.
test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL!);
});

// A long day for cam1: three events an hour, 00:00 to 23:40 (Chicago), any date.
async function longDay(page: Page) {
  await page.route(/\/api\/cameras\/cam1\/events\?date=/, async (route) => {
    const date = new URL(route.request().url()).searchParams.get('date')!;
    const ymd = date.replaceAll('-', '');
    const pad = (n: number) => String(n).padStart(2, '0');
    const events = Array.from({ length: 72 }, (_, i) => {
      const h = Math.floor(i / 3);
      const m = (i % 3) * 20;
      const t = `${pad(h)}${pad(m)}`;
      return { id: `${ymd}-${t}00-${t}20`, start: `${date}T${pad(h)}:${pad(m)}:00-05:00`, end: `${date}T${pad(h)}:${pad(m)}:20-05:00`, durationSec: 20, triggers: ['motion'], sizeSub: 1, sizeMain: 1 };
    });
    await route.fulfill({ json: { date, events, downloads: 'ok' } });
  });
}
const yesterday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(Date.now() - 86_400_000));
const openHours = (page: Page) =>
  page.locator('[data-testid="hour-group"]:has([data-testid="hour-toggle"][aria-expanded="true"])').evaluateAll((els) => els.map((e) => Number((e as HTMLElement).dataset.hour)).sort((a, b) => a - b));
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const hourToggle = (page: Page, h: number) => page.locator(`[data-testid="hour-group"][data-hour="${h}"] [data-testid="hour-toggle"]`);

test('a landing collapses far hours; dragging does not; a day pick does; hand toggles survive', async ({ page }) => {
  await longDay(page);
  const day = yesterday();
  const at = Date.parse(`${day}T12:30:00-05:00`);
  await page.goto(`/app/video?cam=cam1&date=${day}&at=${at}`);
  await expect.poll(() => openHours(page)).toEqual(range(6, 18));

  // Dragging the strip (a move back of hours) changes nothing.
  const bar = (await page.getByTestId('timeline').boundingBox())!;
  await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2);
  await page.mouse.down();
  for (let dx = 10; dx <= 200; dx += 10) await page.mouse.move(bar.x + bar.width / 2 + dx, bar.y + bar.height / 2);
  await page.mouse.up();
  await expect.poll(async () => Number(new URL(page.url()).searchParams.get('at'))).toBeLessThan(at - 3_600_000);
  expect(await openHours(page)).toEqual(range(6, 18));

  // Hand toggles, then a landing (a card): they stay; the card's hour opens.
  await hourToggle(page, 22).click(); // open a far hour
  await hourToggle(page, 17).click(); // close a near one
  await page.locator('[data-testid="event-card"][data-clip-id$="-220000-220020"]').click();
  await expect(page.getByTestId('mode-badge')).toHaveAttribute('data-mode', 'rec');
  await expect.poll(() => openHours(page)).toEqual(range(15, 23).filter((h) => h !== 17)); // 15:00–16:00 ends exactly 6 h before 22:00

  // A day pick is a landing at its first event (00:00), and forgets the toggles.
  await page.getByTestId('day-next').click(); // today, a day with recordings
  await expect.poll(() => openHours(page)).toEqual(range(0, 6));
});

test('thumbnails load near the screen only, more as the list scrolls', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'the list scrolls by itself on a desktop');
  await longDay(page);
  const thumbs = new Set<string>();
  page.on('request', (r) => { if (r.url().endsWith('/thumb.jpg')) thumbs.add(r.url()); });
  const day = yesterday();
  await page.goto(`/app/video?cam=cam1&date=${day}&at=${Date.parse(`${day}T12:30:00-05:00`)}`);
  await expect.poll(() => openHours(page)).toEqual(range(6, 18));
  const cards = await page.getByTestId('event-card').count();
  expect(cards).toBe(13 * 3); // collapsed hours render no cards, so no thumbnails
  await expect.poll(() => thumbs.size).toBeGreaterThan(0);
  await page.waitForTimeout(800);
  const first = thumbs.size;
  expect(first).toBeLessThan(cards / 2);
  // Review of #175: the margin is the list's own (it scrolls inside the
  // sidebar): a card just below its visible part already has its thumbnail.
  const list = page.getByTestId('event-scroll');
  const below = await list.evaluate((el) => {
    const bottom = el.getBoundingClientRect().bottom;
    const cards = [...el.querySelectorAll<HTMLElement>('[data-testid="event-card"]')];
    const c = cards.find((x) => { const t = x.getBoundingClientRect().top; return t > bottom + 100 && t < bottom + 250; });
    return c?.dataset.clipId ?? null;
  });
  expect(below).not.toBeNull();
  await expect.poll(() => [...thumbs].some((u) => u.includes(`/clips/${below}/thumb.jpg`))).toBe(true);
  await list.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await expect.poll(() => thumbs.size).toBeGreaterThan(first);
  // Only the open hours' cards were ever asked for.
  for (const u of thumbs) expect(Number(/-(\d{2})\d{4}-\d{6}\/thumb/.exec(u)![1])).toBeGreaterThanOrEqual(6);
});
