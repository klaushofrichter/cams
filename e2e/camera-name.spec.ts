import { expect, test, type Page } from '@playwright/test';
import { signIn } from './session';

// Renaming a camera (design reolink/camera-name-design.md): Settings → Camera
// name → Save goes through cams to Den's cam-proxy (the fake, PUT
// /control/camera/name), and every open page switches to the new name on the
// proxy's `camera` message: no reload. The camera id (cam1) never changes.
//
// Den's name is shared by every spec, so this file runs in its own projects
// (playwright.config.ts: camera-name-desktop, then camera-name-phone), after
// desktop and phone, and puts the name back.
const NEW = 'Den Loft (2)';

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL!);
});

async function rename(page: Page, name: string): Promise<void> {
  const input = page.getByTestId('camera-name-input');
  await input.fill(name);
  await page.getByTestId('save-camera-name').click();
  await expect(page.getByTestId('settings-card-name').getByTestId('save-state')).toHaveAttribute('data-state', 'saved');
  await expect(input).toHaveValue(name); // the name read back
}

test.afterEach(async ({ page, baseURL }) => {
  // Back to Den even when the test failed half-way (same-origin PUT).
  await page.request.put(`${baseURL}/api/cameras/cam1/name`, { data: { name: 'Den' }, headers: { Origin: new URL(baseURL!).origin } });
});

test('a rename shows at once in the picker, the titles and on other open pages', async ({ page, context }) => {
  const live = await context.newPage();
  await live.goto('/app/live');
  await expect(live.getByTestId('camera-picker')).toHaveValue('cam1');
  await expect(live.getByTestId('camera-card-name')).toHaveText('Den');
  await expect(live).toHaveTitle('● Live · Den · cams');

  await page.goto('/app/settings');
  await expect(page.getByTestId('camera-name-input')).toHaveValue('Den');
  await rename(page, NEW);
  const option = (p: Page) => p.getByTestId('camera-picker').locator('option[value="cam1"]');
  await expect(option(page)).toHaveText(NEW);
  await expect(page.getByTestId('settings-card-detection')).toContainText(`What ${NEW} records.`);

  // The other page heard it on the event stream, without a reload.
  await expect(option(live)).toHaveText(NEW);
  await expect(live.getByTestId('camera-card-name')).toHaveText(NEW); // the Video page's camera card (spec 2026-10-04)
  await expect(live).toHaveTitle(`● Live · ${NEW} · cams`);
  await expect(live.getByTestId('camera-picker')).toHaveValue('cam1'); // the id stays
  await live.close();

  // A fresh load gets the name from the server.
  await page.reload();
  await expect(page.getByTestId('camera-name-input')).toHaveValue(NEW);
  await expect(option(page)).toHaveText(NEW);

  await rename(page, 'Den');
  await expect(option(page)).toHaveText('Den');
});
