import { expect, test, type Page } from '@playwright/test';
import { signIn } from './session';
import { FILTER_EMAILS } from './env';

// The event filter is one preference for History and Live (Klaus,
// 2026-10-03): a chip on either panel changes both, across panel switches
// and reloads, and the Live panel's most recent events follow it. It is
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
const live = (page: Page) => page.getByTestId('live-recent');

async function expectChips(page: Page, scope: ReturnType<Page['getByTestId']>, on: string[]) {
  for (const k of ['all', 'person', 'vehicle', 'pet', 'motion']) {
    await expect(scope.getByTestId(`filter-${k}`)).toHaveAttribute('aria-pressed', String(on.includes(k)));
  }
}

test('a filter set on Live is History’s too, after a panel switch and a reload, and back', async ({ page }) => {
  await page.goto('/app/live');
  await expect(live(page).getByTestId('live-latest')).toHaveCount(4);
  await expectChips(page, live(page), ['all']);

  await live(page).getByTestId('filter-person').click();
  await expect(live(page).getByTestId('live-latest')).toHaveCount(1);
  await expect(live(page).getByTestId('live-latest-kinds')).toHaveText('Person');
  await expect.poll(() => saved(page)).toEqual(['person']);

  await page.getByTestId('panel-tab-history').click();
  await expect(page.getByTestId('page-title')).toHaveText('History');
  const list = page.locator('.side');
  await expectChips(page, list, ['person']);
  await expect(page.getByTestId('event-card')).toHaveCount(1);

  await page.reload();
  await expect(page.getByTestId('event-card')).toHaveCount(1);
  await expectChips(page, list, ['person']);

  // and the other way: History's change is Live's
  await list.getByTestId('filter-vehicle').click();
  await expect(page.getByTestId('event-card')).toHaveCount(2);
  await expect.poll(() => saved(page)).toEqual(['person', 'vehicle']);
  await page.getByTestId('panel-tab-live').click();
  await expectChips(page, live(page), ['person', 'vehicle']);
  await expect(live(page).getByTestId('live-latest')).toHaveCount(2);
  await page.reload();
  await expect(live(page).getByTestId('live-latest')).toHaveCount(2);
  await expectChips(page, live(page), ['person', 'vehicle']);
  const kinds = await live(page).getByTestId('live-latest-kinds').allTextContents();
  expect(kinds).toEqual(['Vehicle', 'Person']); // newest first

  // All again: every event, on both
  await live(page).getByTestId('filter-all').click();
  await expect(live(page).getByTestId('live-latest')).toHaveCount(4);
  await expect.poll(() => saved(page)).toEqual(['person', 'vehicle', 'pet', 'motion']);
});

test('the last kind turned off on Live is All, as on History', async ({ page }) => {
  await page.goto('/app/live');
  await live(page).getByTestId('filter-pet').click();
  await expect(live(page).getByTestId('live-latest')).toHaveCount(1);
  await live(page).getByTestId('filter-pet').click();
  await expectChips(page, live(page), ['all']);
  await expect(live(page).getByTestId('live-latest')).toHaveCount(4);
});
