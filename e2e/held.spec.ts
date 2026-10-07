import { expect, test } from '@playwright/test';
import { ADMIN_USERS, FAKE_ADMIN_HOOKS } from './env';
import { E2E_ACCOUNTS } from './fakeAdmin';
import { signInAccount } from './session';

// Migration P4 (M6, M §9.7): cams-admin moves Home's cam1 to another camera
// (Den's sim → Shed's); cams keeps the old address until an admin confirms.
test.describe.configure({ mode: 'serial' });

const setHost = (homeHost: string) => fetch(`http://127.0.0.1:${FAKE_ADMIN_HOOKS}/snapshot`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ homeHost }) });
const heldCount = (page: import('@playwright/test').Page) => page.evaluate(async () => ((await (await fetch('/api/admin/held')).json()) as { items: unknown[] }).items.length);
const osdName = (page: import('@playwright/test').Page) => page.evaluate(async () => ((await (await fetch('/api/cameras/cam1/settings')).json()) as { image: { osd: { name: string } } }).image.osd.name);

test('a changed camera address is held until an admin confirms; viewers see no banner', async ({ page, context, browser, baseURL }) => {
  await signInAccount(context, baseURL!, ADMIN_USERS.alpha, E2E_ACCOUNTS.home);
  await page.goto('/app/video');
  const before = await osdName(page); // Den's sim (camera-name.spec.ts may rename it meanwhile)
  expect(before).not.toBe('Shed');
  await setHost('127.0.0.1:8096');
  await expect.poll(() => heldCount(page), { timeout: 15_000 }).toBe(1); // the next pull (1 s here)
  await page.reload();
  await expect(page.getByTestId('held-banner')).toBeVisible();
  await expect(page.getByTestId('held-banner')).toContainText('127.0.0.1:8098');
  await expect(page.getByTestId('held-banner')).toContainText('127.0.0.1:8096');
  expect(await osdName(page)).not.toBe('Shed'); // still the old camera
  // A viewer (of the other account) sees no banner.
  const other = await browser.newContext();
  await signInAccount(other, baseURL!, ADMIN_USERS.both, E2E_ACCOUNTS.beta);
  const vp = await other.newPage();
  await vp.goto(`${baseURL}/app/video`);
  await expect(vp.getByTestId('camera-picker')).toBeVisible();
  await expect(vp.getByTestId('held-banner')).toHaveCount(0);
  await other.close();
  await page.getByTestId('held-confirm-cam1').click();
  await expect(page.getByTestId('held-banner')).toHaveCount(0);
  await expect.poll(() => osdName(page)).toBe('Shed');
  // back, for the next project
  await setHost('127.0.0.1:8098');
  await expect.poll(() => heldCount(page), { timeout: 15_000 }).toBe(1);
  await page.evaluate(async () => {
    const items = ((await (await fetch('/api/admin/held')).json()) as { items: { camsId: string; digest: string }[] }).items.map((h) => ({ camsId: h.camsId, digest: h.digest }));
    await fetch('/api/admin/held/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) });
  });
  await expect.poll(() => osdName(page)).not.toBe('Shed');
});
