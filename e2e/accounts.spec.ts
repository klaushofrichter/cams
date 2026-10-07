import { expect, test } from '@playwright/test';
import { ADMIN_USERS } from './env';
import { E2E_ACCOUNTS } from './fakeAdmin';
import { signInAccount } from './session';

// Migration P4 (M §9.5, R4-13): a person in two accounts that both have a
// camera "cam1" picks one after sign-in, switches in the menu, and sees only
// that account's camera; nothing of the other account's camera state stays.
test.describe.configure({ mode: 'serial' });

test('two accounts: the picker, the switch, only the chosen account\'s cam1', async ({ page, context, baseURL }, info) => {
  const phone = info.project.name.includes('phone');
  await signInAccount(context, baseURL!, ADMIN_USERS.both); // several accounts, none chosen
  await page.goto('/');
  await expect(page).toHaveURL(/\/app\/accounts$/);
  await expect(page.getByTestId(`account-${E2E_ACCOUNTS.home}`)).toContainText('Admin');
  await expect(page.getByTestId(`account-${E2E_ACCOUNTS.beta}`)).toContainText('Viewer');
  await page.getByTestId(`account-${E2E_ACCOUNTS.home}`).click();
  await expect(page).toHaveURL(/\/app\/video/);
  await expect(page.getByTestId('camera-picker').locator('option')).toHaveText(['Den']);
  const cams = await page.evaluate(async () => (await (await fetch('/api/cameras')).json()) as { id: string; name: string }[]);
  expect(cams.map((c) => [c.id, c.name])).toEqual([['cam1', 'Den']]);
  // camera state the pages keep per tab
  await page.evaluate(() => sessionStorage.setItem('cams-cursor', JSON.stringify({ cam: 'cam1', cursor: 1 })));
  // Switch account
  if (phone) {
    await page.getByTestId('hamburger').click();
    await page.getByTestId('drawer-switch-account').click();
  } else await page.getByTestId('switch-account').click();
  await expect(page).toHaveURL(/\/app\/accounts$/);
  await page.getByTestId(`account-${E2E_ACCOUNTS.beta}`).click();
  await expect(page).toHaveURL(/\/app\/video/);
  await expect(page.getByTestId('camera-picker').locator('option')).toHaveText(['Porch']);
  expect(await page.evaluate(() => sessionStorage.getItem('cams-cursor'))).toBeNull();
  const beta = await page.evaluate(async () => (await (await fetch('/api/cameras')).json()) as { id: string; name: string }[]);
  expect(beta.map((c) => [c.id, c.name])).toEqual([['cam1', 'Porch']]);
  // The other account's archive isn't reachable from here.
  const arch = await page.evaluate(async () => (await (await fetch('/api/archive')).json()) as { proxies: unknown[] });
  expect(arch.proxies).toEqual([]);
});

test('one account: straight in, no "Switch account"', async ({ page, context, baseURL }, info) => {
  await signInAccount(context, baseURL!, ADMIN_USERS.alpha);
  await page.goto('/');
  await expect(page).toHaveURL(/\/app\/video/);
  if (!info.project.name.includes('phone')) {
    await expect(page.getByTestId('account-name')).toHaveText('Home');
    await expect(page.getByTestId('switch-account')).toHaveCount(0);
  }
});
