import { expect, test, type Page } from '@playwright/test';
import { signIn } from './session';
import { expandAllHours } from './hours';

// The Video sidebar on a desktop (Klaus, 2026-10-03; one page 2026-10-04):
// only the event list (cards and hour titles) scrolls; the camera card, the
// controls, the filter chips and "Collapse hours" stay at the top, and the
// page itself doesn't scroll.
// The phone layout (stacked) is unchanged.
test.skip(() => test.info().project.name !== 'desktop', 'the side-by-side layout is the desktop one');
test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL!);
});

// A long day: 36 events, three an hour from 06:00 (Chicago, CDT), so the
// list is taller than the window.
async function longDay(page: Page) {
  await page.route(/\/api\/cameras\/cam1\/events\?date=/, async (route) => {
    const date = new URL(route.request().url()).searchParams.get('date')!;
    const ymd = date.replaceAll('-', '');
    const pad = (n: number) => String(n).padStart(2, '0');
    const kinds = [['person'], ['vehicle'], ['motion'], ['pet']];
    const events = Array.from({ length: 36 }, (_, i) => {
      const h = 6 + Math.floor(i / 3);
      const m = (i % 3) * 15;
      const t = `${pad(h)}${pad(m)}`;
      return {
        id: `${ymd}-${t}00-${t}20`, start: `${date}T${pad(h)}:${pad(m)}:00-05:00`, end: `${date}T${pad(h)}:${pad(m)}:20-05:00`,
        durationSec: 20, triggers: kinds[i % 4], sizeSub: 1, sizeMain: 1,
      };
    });
    await route.fulfill({ json: { date, events, downloads: 'ok' } });
  });
}

const inViewport = async (page: Page, testId: string) => {
  const b = (await page.getByTestId(testId).first().boundingBox())!;
  const v = page.viewportSize()!;
  return b.y >= 0 && b.y + b.height <= v.height && b.x >= 0 && b.x + b.width <= v.width;
};

test('only the event list scrolls; the camera, the controls, Collapse hours and the filter stay', async ({ page }) => {
  await longDay(page);
  await page.goto('/app/recordings?panel=history&cam=cam1');
  await expandAllHours(page); // all 12 hours, whatever the time of day
  await expect(page.getByTestId('event-card')).toHaveCount(36);
  const list = page.getByTestId('event-scroll');
  const main = page.locator('main.main');
  expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  expect(await main.evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true); // no page scrollbar

  await list.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await expect.poll(() => list.evaluate((el) => Math.ceil(el.scrollTop + el.clientHeight) >= el.scrollHeight)).toBe(true);
  expect(await main.evaluate((el) => el.scrollTop)).toBe(0);
  expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0);
  for (const id of ['camera-card', 'live-controls', 'hours-toggle', 'filter-all', 'filter-motion']) {
    expect(await inViewport(page, id), id).toBe(true);
  }
  // the last card is in view, inside the list
  const last = page.getByTestId('event-card').last();
  await expect(last).toBeInViewport();
  const lb = (await last.boundingBox())!;
  const box = (await list.boundingBox())!;
  expect(lb.y + lb.height).toBeLessThanOrEqual(box.y + box.height + 1);

  // a window that gets shorter keeps the same: the list gives way (below
  // about 700 px the player column itself no longer fits, as before)
  await page.setViewportSize({ width: 1440, height: 720 });
  await expect.poll(() => main.evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true);
  for (const id of ['camera-card', 'hours-toggle', 'filter-all']) expect(await inViewport(page, id), id).toBe(true);
  const side = (await page.locator('aside.side').boundingBox())!;
  expect(side.y + side.height).toBeLessThanOrEqual(720);
});

test('live, the sidebar keeps the camera, the controls and the filter in place too', async ({ page }) => {
  await longDay(page);
  await page.setViewportSize({ width: 1440, height: 720 });
  await page.goto('/app/video');
  await expect(page.getByTestId('mode-badge')).toHaveAttribute('data-mode', 'live');
  await expandAllHours(page);
  await expect(page.getByTestId('event-card')).toHaveCount(36);
  const main = page.locator('main.main');
  await expect.poll(() => main.evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true);
  for (const id of ['camera-card', 'live-controls', 'filter-all', 'filter-motion']) expect(await inViewport(page, id), id).toBe(true);
  const rows = page.getByTestId('event-scroll');
  await rows.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await expect.poll(() => rows.evaluate((el) => Math.ceil(el.scrollTop + el.clientHeight) >= el.scrollHeight)).toBe(true);
  for (const id of ['camera-card', 'filter-all']) expect(await inViewport(page, id), id).toBe(true);
  expect(await main.evaluate((el) => el.scrollTop)).toBe(0);
});
