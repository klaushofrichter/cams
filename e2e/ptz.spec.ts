// e2e/ptz.spec.ts
// The PTZ panel (cam-proxy spec 2026-10-30-ptz-capabilities-design §8.2):
// Barn's fake cam-proxy reports a pan/tilt/zoom camera with positions
// (e2e/fakeProxyData.ts); Den's reports none. Positions live in the one
// shared fake, so this file runs on its own, one size after the other
// (playwright.config.ts: ptz-desktop, ptz-phone).
import { expect, test, type Page } from '@playwright/test';
import { signIn } from './session';
import { FAKE_PROXY_PORT } from './fakeProxyData';

const HOOKS = `http://127.0.0.1:${FAKE_PROXY_PORT - 2}`;
interface Call { cam: string; op: string; body: Record<string, unknown> }

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ context, baseURL, request }) => {
  await signIn(context, baseURL!);
  expect((await request.post(`${HOOKS}/ptz-reset`, { data: { cam: 'barn' } })).ok()).toBe(true);
});

const calls = async (page: Page): Promise<Call[]> => (await page.request.get(`${HOOKS}/ptz-calls?cam=barn`)).json();
const rows = (page: Page) => page.getByTestId('ptz-row');
const row = (page: Page, name: string) => rows(page).filter({ hasText: name });

async function openPanel(page: Page) {
  await page.goto('/app/video?cam=barn');
  await expect(page.getByTestId('ptz-panel')).toBeVisible();
  if ((await page.getByTestId('ptz-toggle').getAttribute('aria-expanded')) !== 'true') await page.getByTestId('ptz-toggle').click();
  await expect(page.getByTestId('ptz-body')).toBeVisible();
}

async function savePosition(page: Page, name?: string) {
  await page.getByTestId('ptz-save').click();
  const input = page.getByTestId('ptz-save-input');
  await expect(input).toBeFocused();
  if (name !== undefined) await input.fill(name);
  await input.press('Enter');
  await expect(input).toHaveCount(0);
}

test('no panel for a camera without PTZ, nor in a recording', async ({ page }) => {
  await page.goto('/app/video?cam=cam1');
  await expect(page.getByTestId('live-controls')).toBeVisible();
  await expect(page.getByTestId('ptz-panel')).toHaveCount(0);
  await page.goto('/app/video?cam=barn');
  await expect(page.getByTestId('ptz-panel')).toBeVisible();
  // Directly above the events list and its filter.
  const panel = await page.getByTestId('ptz-panel').boundingBox();
  const filter = await page.getByTestId('event-filter').boundingBox();
  const controls = await page.getByTestId('live-controls').boundingBox();
  expect(panel!.y).toBeGreaterThan(controls!.y);
  expect(panel!.y).toBeLessThan(filter!.y);
  await page.goto('/app/recordings?panel=history&cam=barn');
  await expect(page.getByTestId('mode-badge')).toHaveAttribute('data-mode', 'rec');
  await expect(page.getByTestId('ptz-panel')).toHaveCount(0);
});

test('collapsed by default, open after a reload once opened', async ({ page }) => {
  await page.goto('/app/video?cam=barn');
  await expect(page.getByTestId('ptz-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('ptz-body')).toHaveCount(0);
  await page.getByTestId('ptz-toggle').click();
  await expect(page.getByTestId('ptz-body')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('ptz-toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('ptz-body')).toBeVisible();
  await page.getByTestId('ptz-toggle').click();
  await expect(page.getByTestId('ptz-body')).toHaveCount(0);
});

test('a tap sends one short move; holding a direction sends repeated moves, then stop', async ({ page }) => {
  await openPanel(page);
  const right = page.getByTestId('ptz-dir-right');
  await right.hover();
  await page.mouse.down();
  await page.mouse.up();
  await expect.poll(async () => (await calls(page)).length).toBe(1);
  expect((await calls(page))[0]).toMatchObject({ op: 'move', body: { direction: 'right', durationMs: 400 } });
  await resetPtz(page);
  await right.hover();
  await page.mouse.down();
  await page.waitForTimeout(1000);
  await page.mouse.up();
  await expect.poll(async () => (await calls(page)).at(-1)?.op).toBe('stop');
  const all = await calls(page);
  const moves = all.filter((c) => c.op === 'move');
  expect(moves.length).toBeGreaterThanOrEqual(3);
  expect(moves[0].body).toMatchObject({ direction: 'right', durationMs: 400 });
  expect(moves.at(-1)!.body).toMatchObject({ direction: 'right', durationMs: 600 });
  expect(all.filter((c) => c.op === 'stop')).toHaveLength(1);
});

async function resetPtz(page: Page) {
  expect((await page.request.post(`${HOOKS}/ptz-reset`, { data: { cam: 'barn' } })).ok()).toBe(true);
}

test('zoom in held, then stop', async ({ page }) => {
  await openPanel(page);
  await page.getByTestId('ptz-zoom-in').hover();
  await page.mouse.down();
  await page.waitForTimeout(600);
  await page.mouse.up();
  await expect.poll(async () => (await calls(page)).at(-1)?.op).toBe('stop');
  expect((await calls(page))[0]).toMatchObject({ op: 'zoom', body: { direction: 'in', durationMs: 400 } });
});

test('save, sort, make Home and delete positions', async ({ page }) => {
  await openPanel(page);
  await expect(page.getByTestId('ptz-empty')).toBeVisible();
  await savePosition(page); // "Position 1", the first: Home
  await expect(rows(page)).toHaveCount(1);
  await expect(row(page, 'Position 1').getByTestId('ptz-home-mark')).toBeVisible();
  await savePosition(page, 'Gate');
  await expect(rows(page)).toHaveText([/Position 1/, /Gate/]);
  // ↓ on the first row
  await row(page, 'Position 1').getByTestId('ptz-down').click();
  await expect(rows(page)).toHaveText([/Gate/, /Position 1/]);
  await expect.poll(async () => (await calls(page)).some((c) => c.op === 'order')).toBe(true);
  // Make Home on Gate
  await row(page, 'Gate').getByTestId('ptz-make-home').click();
  await expect(row(page, 'Gate').getByTestId('ptz-home-mark')).toBeVisible();
  await expect(row(page, 'Position 1').getByTestId('ptz-home-mark')).toHaveCount(0);
  // Go
  await row(page, 'Position 1').getByTestId('ptz-go').click();
  await expect.poll(async () => (await calls(page)).some((c) => c.op === 'go')).toBe(true);
  // Delete Position 1 through the confirm row
  await row(page, 'Position 1').getByTestId('ptz-delete').click();
  await expect(page.getByTestId('ptz-confirm')).toContainText('Delete “Position 1”?');
  await page.getByTestId('ptz-confirm-delete').click();
  await expect(rows(page)).toHaveText([/Gate/]);
  // Home can't go while another position exists
  await savePosition(page, 'Door');
  await row(page, 'Gate').getByTestId('ptz-delete').click();
  await expect(page.getByTestId('ptz-confirm')).toContainText("Home can't be deleted while other positions exist.");
  await expect(page.getByTestId('ptz-confirm-delete')).toHaveCount(0);
  await page.getByTestId('ptz-confirm-ok').click();
  await expect(rows(page)).toHaveText([/Gate/, /Door/]);
  // Rename inline
  await row(page, 'Door').getByTestId('ptz-rename').click();
  await page.getByTestId('ptz-rename-input').fill('Front door');
  await page.getByTestId('ptz-rename-input').press('Enter');
  await expect(rows(page)).toHaveText([/Gate/, /Front door/]);
});

test('a missing position says so and can be saved again', async ({ page }) => {
  await openPanel(page);
  await savePosition(page, 'Gate');
  const id = await row(page, 'Gate').getAttribute('data-id');
  expect((await page.request.post(`${HOOKS}/ptz-missing`, { data: { cam: 'barn', id } })).ok()).toBe(true);
  await page.reload();
  await expect(row(page, 'Gate')).toContainText('Not on the camera — save again');
  await expect(row(page, 'Gate').getByTestId('ptz-go')).toHaveCount(0);
  await row(page, 'Gate').getByTestId('ptz-resave').click();
  await expect(row(page, 'Gate')).not.toContainText('Not on the camera');
  await expect(row(page, 'Gate').getByTestId('ptz-go')).toBeVisible();
});

test('drag to sort (desktop)', async ({ page }, info) => {
  test.skip(info.project.name.includes('phone'), 'no drag handles on a touch screen; ↑↓ there');
  await openPanel(page);
  await savePosition(page, 'One');
  await savePosition(page, 'Two');
  await savePosition(page, 'Three');
  await row(page, 'Three').getByTestId('ptz-grip').dragTo(row(page, 'One'));
  await expect(rows(page)).toHaveText([/Three/, /One/, /Two/]);
  const order = (await calls(page)).filter((c) => c.op === 'order').at(-1);
  expect((order!.body.ids as string[]).length).toBe(3);
});

test('the list shows five rows and scrolls beyond', async ({ page }) => {
  await openPanel(page);
  for (const n of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) await savePosition(page, n);
  await expect(rows(page)).toHaveCount(7);
  const list = page.getByTestId('ptz-positions');
  const box = await list.boundingBox();
  const rowBox = await rows(page).first().boundingBox();
  expect(Math.round(box!.height)).toBeLessThanOrEqual(Math.round(rowBox!.height * 5) + 1);
  expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
});
