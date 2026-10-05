// e2e/archive.spec.ts
// The Archive (cams spec 2026-10-05-archive-design), against the fake
// cam-proxy's Archive (test/proxy/fakeArchive.ts, cam-proxy's archive
// contract). Barn's fake proxy holds one long FTP clip covering today
// (e2e/fakeProxyData.ts); its 08:15:10 card is a person recording. Desktop
// and phone run at once against the one fake: each test names its clips
// uniquely and finds them by search.
import { readFileSync } from 'fs';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { zipNames } from '../test/proxy/fakeArchive';
import { signIn } from './session';

const SHOTS = process.env.ARCHIVE_SHOTS; // a folder: screenshots (desktop/phone, light/dark)

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL!);
});

const card = (page: Page, id = '-081510-') => page.locator('li', { has: page.locator(`[data-testid="event-card"][data-clip-id*="${id}"]`) });
const unique = (info: TestInfo) => `e2e ${info.project.name} ${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
async function shots(page: Page, info: TestInfo, what: string) {
  if (!SHOTS) return;
  const size = info.project.name === 'phone' ? 'phone' : 'desktop';
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/${size}-${theme}-${what}.png` });
  }
  await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
}
// The row of the clip named `name` (searched for, so the other project's clips don't show).
async function findRow(page: Page, name: string) {
  await page.getByTestId('archive-search').fill(name);
  const row = page.getByTestId('archive-row').filter({ has: page.getByTestId('archive-name-cell').filter({ hasText: name }) });
  await expect(row).toHaveCount(1);
  return row;
}

test('archive a composed clip from Save, play it, edit its labels, download a ZIP, delete it', async ({ page }, info) => {
  test.setTimeout(90_000);
  const name = unique(info);
  await page.goto('/app/recordings?panel=history&cam=barn');
  await card(page).getByTestId('event-download').click();
  await page.getByTestId('compose-post').fill('10');
  // Archive needs what Save would download: here the composed result.
  await expect(page.getByTestId('compose-archive')).toBeDisabled();
  await page.getByTestId('compose-generate').click();
  await expect(page.getByTestId('compose-player')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('compose-archive').click();

  // The archive step: default name, a year, Person (the card) and SD (the size) preselected.
  await expect(page.getByTestId('compose-dialog')).toHaveAttribute('aria-label', 'Archive clip');
  await expect(page.getByTestId('archive-name')).toHaveValue(/^\d{4}-\d{2}-\d{2} 08:15:10 Barn$/);
  await expect(page.getByTestId('archive-retention-days')).toHaveValue('365');
  const chip = (l: string) => page.getByTestId('archive-labels').locator(`[data-testid="label-chip"][data-label="${l}"]`);
  await expect(chip('Person')).toHaveAttribute('aria-pressed', 'true');
  await expect(chip('SD')).toHaveAttribute('aria-pressed', 'true');
  await expect(chip('Pet')).toHaveAttribute('aria-pressed', 'false');
  // Cancel goes back to the Save dialog, with its result.
  await page.getByTestId('archive-cancel').click();
  await expect(page.getByTestId('compose-player')).toBeVisible();
  await page.getByTestId('compose-archive').click();
  await page.getByTestId('archive-name').fill(name);
  await page.getByTestId('label-input').fill('two words');
  await page.getByTestId('label-add').click();
  await expect(page.getByTestId('label-error')).toHaveText('A label is one word: letters and digits only.');
  await page.getByTestId('label-input').fill('Fox');
  await page.getByTestId('label-input').press('Enter');
  await expect(page.getByTestId('archive-labels').getByTestId('label-custom')).toHaveText(/Fox/);
  await shots(page, info, 'archive-step');
  await page.getByTestId('archive-submit').click();
  await expect(page.getByTestId('archive-done')).toContainText(name);
  await page.getByTestId('archive-open').click();

  // The Archive page, the new clip highlighted. Barn's proxy is Den's: its
  // archive is reached through cam1, the first camera that uses it.
  await expect(page).toHaveURL(/\/app\/archive\?item=cam1%3A\d+$/);
  await expect(page.getByTestId('page-title')).toHaveText('Archive');
  const row = await findRow(page, name);
  await expect(row.getByTestId('archive-label')).toHaveText(['Person', 'SD', 'Fox']);
  await expect(row.getByTestId('archive-expires')).toContainText(/in 36[45] days/);
  await page.getByTestId('archive-search').fill('');
  await shots(page, info, 'archive-page');
  await findRow(page, name);

  // Play: the video through cams's relay, the controls, the metadata.
  await row.getByTestId('archive-thumb').click();
  const player = page.getByTestId('archive-player');
  await expect(player).toBeVisible();
  await expect(player.getByTestId('archive-source')).toHaveText(/^Composed: SD, pre-roll 0 s, post-roll 10 s/);
  await expect(player.getByTestId('archive-meta-labels')).toHaveText('Person, SD, Fox');
  await player.getByTestId('archive-play').click();
  await expect.poll(() => page.getByTestId('archive-video').evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 10_000 }).toBeGreaterThan(0.2);
  await player.getByTestId('archive-play').click(); // pause
  await player.getByTestId('archive-back10').click();
  await expect.poll(() => page.getByTestId('archive-video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBe(0);
  await player.getByTestId('archive-fwd1').click();
  await expect.poll(() => page.getByTestId('archive-video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(1, 1);
  await expect(player.getByTestId('archive-time')).toHaveText(/^0:01 \/ 0:0\d$/);
  await shots(page, info, 'archive-player');
  await player.getByTestId('archive-player-close').click();

  // Edit the labels: Pet on, Fox off.
  await row.getByTestId('archive-edit').click();
  const edit = page.getByTestId('archive-edit-dialog');
  await expect(edit.getByTestId('archive-edit-name')).toHaveValue(name);
  await edit.locator('[data-testid="label-chip"][data-label="Pet"]').click();
  await edit.getByRole('button', { name: 'Remove Fox' }).click();
  await edit.getByTestId('archive-edit-save').click();
  await expect(edit).toHaveCount(0);
  await expect(row.getByTestId('archive-label')).toHaveText(['Person', 'SD', 'Pet']);

  // A ZIP of the selection: the clip, its metadata and its thumbnail.
  await row.getByTestId('archive-select').click();
  await expect(page.getByTestId('archive-selected-count')).toHaveText('1 selected');
  const [zip] = await Promise.all([page.waitForEvent('download'), page.getByTestId('archive-bulk-zip').click()]);
  expect(zip.suggestedFilename()).toMatch(/^archive-barn-\d{8}-\d{6}\.zip$/);
  const names = zipNames(readFileSync((await zip.path())!));
  expect(names.map((n) => n.replace(/^.* \((\d+)\)/, '($1)').replace(/\(\d+\)/, '(id)'))).toEqual(['(id).mp4', '(id).json', '(id).jpg']);
  expect(names[0].startsWith(name)).toBe(true);

  // Delete, after the confirmation naming the count.
  await page.getByTestId('archive-bulk-delete').click();
  const confirm = page.getByTestId('archive-confirm');
  await expect(confirm).toHaveAttribute('aria-label', 'Delete 1 clip?');
  await confirm.getByTestId('archive-confirm-cancel').click();
  await expect(row).toHaveCount(1);
  await page.getByTestId('archive-bulk-delete').click();
  await page.getByTestId('archive-confirm-delete').click();
  await expect(row).toHaveCount(0);
  await expect(page.getByTestId('archive-notice')).toHaveText('Deleted 1 clip.');
});

test('archive a plain SD save, select a range with shift-click, set retention, delete both', async ({ page }, info) => {
  test.setTimeout(90_000);
  const name = unique(info);
  await page.goto('/app/recordings?panel=history&cam=barn');
  for (const n of [`${name} a`, `${name} b`]) {
    await card(page).getByTestId('event-download').click();
    // A plain save: Archive at once, no Generate.
    await page.getByTestId('compose-archive').click();
    await page.getByTestId('archive-name').fill(n);
    await page.getByTestId('archive-submit').click();
    await expect(page.getByTestId('archive-done')).toBeVisible();
    await page.getByTestId('archive-close').click();
    await expect(page.getByTestId('compose-dialog')).toHaveCount(0);
  }
  await page.goto('/app/archive');
  await page.getByTestId('archive-search').fill(name);
  const rows = page.getByTestId('archive-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.first().getByTestId('archive-label')).toHaveText(['Person', 'SD']);
  // The recorded time links to the Video page while Barn still holds it.
  const rec = rows.first().getByTestId('archive-recorded');
  await expect(rec).toHaveAttribute('href', /^\/app\/video\?cam=barn&date=\d{4}-\d{2}-\d{2}&at=\d+$/);
  // Select all shown, then none; then a range by shift-click.
  await page.getByTestId('archive-select-all').click();
  await expect(page.getByTestId('archive-selected-count')).toHaveText('2 selected');
  await page.getByTestId('archive-select-all').click();
  await expect(page.getByTestId('archive-bulk')).toHaveCount(0);
  await rows.nth(0).getByTestId('archive-select').click();
  await rows.nth(1).getByTestId('archive-select').click({ modifiers: ['Shift'] });
  await expect(page.getByTestId('archive-selected-count')).toHaveText('2 selected');
  await page.getByTestId('archive-bulk-retention').click();
  await page.getByTestId('archive-edit-retention-forever').check();
  await page.getByTestId('archive-edit-save').click();
  await expect(rows.getByTestId('archive-expires')).toHaveText([/forever/, /forever/]);
  await page.getByTestId('archive-bulk-delete').click();
  await expect(page.getByTestId('archive-confirm')).toHaveAttribute('aria-label', 'Delete 2 clips?');
  await page.getByTestId('archive-confirm-delete').click();
  await expect(rows).toHaveCount(0);
  // "No clip matches", or the empty Archive when the other project's clips are gone too.
  await expect(page.getByTestId('archive-none-shown').or(page.getByTestId('archive-empty'))).toBeVisible();
});

test('the Archive is in the menu, and a camera without a proxy has no Archive button', async ({ page }, info) => {
  await page.goto('/app/recordings?panel=history&cam=porch');
  await card(page, '-').first().getByTestId('event-download').click();
  await expect(page.getByTestId('compose-save')).toBeVisible();
  await expect(page.getByTestId('compose-archive')).toHaveCount(0);
  await page.getByTestId('compose-close').click();
  if (info.project.name === 'phone') {
    await page.getByTestId('hamburger').click();
    await page.getByTestId('drawer').getByTestId('nav-archive').click();
  } else await page.getByTestId('sidebar').getByTestId('nav-archive').click();
  await expect(page).toHaveURL('/app/archive');
  await expect(page.getByTestId('page-title')).toHaveText('Archive');
  await expect(page.getByTestId('archive-summary')).toContainText(/\d+ clips?/);
});
