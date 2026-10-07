import { expect, test } from '@playwright/test';
import { ADMIN_USERS } from './env';
import { E2E_ACCOUNTS } from './fakeAdmin';
import { signInAccount } from './session';

// Migration P4 (M §9.5, R4-9): a viewer watches; changing is for admins.
test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ context, baseURL }) => {
  await signInAccount(context, baseURL!, ADMIN_USERS.both, E2E_ACCOUNTS.beta);
});

test('live works; Settings shows values without Save; a rename is refused 403', async ({ page }) => {
  await page.goto('/app/video');
  await expect(page.getByTestId('camera-picker').locator('option')).toHaveText(['Porch']);
  await expect.poll(async () => page.evaluate(async () => ((await (await fetch('/api/cameras/cam1/status')).json()) as { online: boolean }).online)).toBe(true);
  await page.goto('/app/settings');
  await expect(page.getByTestId('settings-card-detection')).toBeVisible();
  await expect(page.getByTestId('recording-toggle')).toBeVisible();
  await expect(page.getByTestId('save-detection')).toHaveCount(0);
  await expect(page.getByTestId('save-image')).toHaveCount(0);
  await expect(page.getByTestId('reboot-button')).toHaveCount(0);
  await expect(page.getByTestId('save-camera-name')).toHaveCount(0);
  await expect(page.getByTestId('camera-name-readonly')).toHaveText('Porch');
  await expect(page.getByTestId('save-prefs')).toBeVisible(); // own preferences stay
  const status = await page.evaluate(async () => (await fetch('/api/cameras/cam1/name', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Hacked' }) })).status);
  expect(status).toBe(403);
});

test('recordings answer for a viewer', async ({ page }) => {
  await page.goto('/app/video');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
  const r = await page.evaluate(async (d) => (await fetch(`/api/cameras/cam1/events?date=${d}`)).status, today);
  expect(r).toBe(200);
});
