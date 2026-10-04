import { expect, test, type Page } from '@playwright/test';
import { signIn } from './session';
import { FILTER_EMAILS } from './env';
import { eventCount, expandAllHours } from './hours';

// The event filter is one preference for live and the recordings (Klaus,
// 2026-10-03; one Video page since 2026-10-04): a chip changes both, across
// mode switches and reloads. It is
// saved for real, so each project signs in as its own user (e2e/env.ts).
// Today's demo clips (cam-sim DEMO_CLIPS): 08:15:10 person, 09:30:00
// vehicle, 12:05:05 motion, 17:45:40 pet.
// One user per project: this file's tests take turns.
test.describe.configure({ mode: 'serial' });
test.beforeEach(async ({ context, baseURL, page }, testInfo) => {
  await signIn(context, baseURL!, FILTER_EMAILS[testInfo.project.name as keyof typeof FILTER_EMAILS]);
  await setSaved(page, ['person', 'vehicle', 'pet', 'motion']);
});
test.afterEach(async ({ page }) => {
  await setSaved(page, ['person', 'vehicle', 'pet', 'motion']);
});

async function setSaved(page: Page, eventFilter: string[]) {
  expect((await page.request.put('/api/preferences', { data: { eventFilter } })).status()).toBe(200);
}
const saved = async (page: Page) => (await (await page.request.get('/api/preferences')).json()).eventFilter as string[];
const side = (page: Page) => page.locator('.side');

async function expectChips(page: Page, scope: ReturnType<Page['locator']>, on: string[]) {
  for (const k of ['all', 'person', 'vehicle', 'pet', 'motion']) {
    await expect(scope.getByTestId(`filter-${k}`)).toHaveAttribute('aria-pressed', String(on.includes(k)));
  }
}
const kindsOf = (page: Page) => page.getByTestId('event-card').evaluateAll((els) => els.map((e) => [...e.closest('li')!.querySelectorAll('.tag')].map((t) => t.textContent!.trim()).join(', ')));

// One filter for live and recordings (Klaus, 2026-10-03; one Video page, 2026-10-04).
test('a filter set live is the recordings’ too, after a reload, and back', async ({ page }) => {
  await page.goto('/app/video');
  await expect(page.getByTestId('mode-badge')).toHaveAttribute('data-mode', 'live');
  await expect.poll(() => eventCount(page)).toBe(4);
  await expectChips(page, side(page), ['all']);

  await side(page).getByTestId('filter-person').click();
  await expect.poll(() => eventCount(page)).toBe(1);
  await expandAllHours(page);
  expect(await kindsOf(page)).toEqual(['Person']);
  await expect.poll(() => saved(page)).toEqual(['person']);

  await page.getByTestId('back-10').click(); // a recording
  await expect(page.getByTestId('mode-badge')).toHaveAttribute('data-mode', 'rec');
  await expectChips(page, side(page), ['person']);
  await expect.poll(() => eventCount(page)).toBe(1);

  await page.reload();
  await expect.poll(() => eventCount(page)).toBe(1);
  await expectChips(page, side(page), ['person']);

  // and the other way: the recording's change is live's
  await side(page).getByTestId('filter-vehicle').click();
  await expect.poll(() => eventCount(page)).toBe(2);
  await expect.poll(() => saved(page)).toEqual(['person', 'vehicle']);
  await page.getByTestId('strip-now').click(); // ⇥: live
  await expect(page.getByTestId('mode-badge')).toHaveAttribute('data-mode', 'live');
  await expectChips(page, side(page), ['person', 'vehicle']);
  await expect.poll(() => eventCount(page)).toBe(2);
  await page.reload();
  await expect.poll(() => eventCount(page)).toBe(2);
  await expectChips(page, side(page), ['person', 'vehicle']);
  await expandAllHours(page);
  expect(await kindsOf(page)).toEqual(['Vehicle', 'Person']); // newest first

  // All again: every event
  await side(page).getByTestId('filter-all').click();
  await expect.poll(() => eventCount(page)).toBe(4);
  await expect.poll(() => saved(page)).toEqual(['person', 'vehicle', 'pet', 'motion']);
});

test('an old link’s filter= is ignored: the saved filter shows, and the URL drops it', async ({ page }) => {
  await setSaved(page, ['pet']);
  await page.goto('/app/recordings?panel=history&cam=cam1&filter=person');
  await expect.poll(() => eventCount(page)).toBe(1);
  await expandAllHours(page);
  await expect(page.getByTestId('event-card')).toHaveAttribute('data-clip-id', /-174540-/);
  await expectChips(page, side(page), ['pet']);
  await expect(page).not.toHaveURL(/filter=/);
  // with a date and a time too (nothing else rewrites that URL at once)
  await page.goto(`/app/recordings?cam=cam1&date=${await page.evaluate(() => new Date().toLocaleDateString('en-CA'))}&panel=history&filter=all`);
  await expect.poll(() => eventCount(page)).toBe(1);
  await expect(page).not.toHaveURL(/filter=/);
});

test('the last kind turned off live is All', async ({ page }) => {
  await page.goto('/app/video');
  await side(page).getByTestId('filter-pet').click();
  await expect.poll(() => eventCount(page)).toBe(1);
  await side(page).getByTestId('filter-pet').click();
  await expectChips(page, side(page), ['all']);
  await expect.poll(() => eventCount(page)).toBe(4);
});
