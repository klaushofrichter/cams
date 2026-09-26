import { expect, test } from '@playwright/test';
import { signIn } from './session';

// Den (cam1) is backed by the mock camera on 8098; Porch is backed by a
// second, separate mock on 8097 that's started with
// MOCK_SETTINGS_FAILURES=SetWhiteLed (playwright.config.ts), so every
// spotlight write on Porch comes back rejected. That lets the "partial save"
// test below exercise a real rejected-field response without making Den's
// mock -- which live.spec.ts and live-teardown.spec.ts also depend on --
// reject writes.
//
// Isolation: every test that mutates a camera's settings targets Porch, not
// Den, and restores what it changed at the end, because the mock's
// in-memory state lives for the whole e2e run. Den's OSD name is therefore
// never written by this file, so the "settings cards load the camera state"
// test can assert its default value on any project without racing a writer.
// The tests that DO mutate Porch (or the one shared preferences file, see
// PREFS_FILE in e2e/env.ts) are confined to the `desktop` project via
// `test.skip`, and this whole file runs with `mode: 'serial'` so that, within
// one project, a mutating test's writes and restores never interleave with
// another test's reads. Projects still run in parallel with each other, but
// since only `desktop` ever writes to Porch or the preferences file, nothing
// on `phone` can observe a half-applied write.
test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL!);
});

test('settings cards load the camera state', async ({ page }) => {
  await page.goto('/app/settings');
  await expect(page.getByTestId('settings-card-detection')).toBeVisible();
  await expect(page.getByTestId('recording-toggle')).toBeChecked();
  await expect(page.getByTestId('osd-name')).toHaveValue('Den');
  await expect(page.getByTestId('device-model')).toHaveText('RLC-1224A');
  await expect(page.getByTestId('device-storage')).toContainText('of 59.6 GB used');
});

test('saving a camera setting shows the success state and persists', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'mutates Porch, which is shared mock-camera state; avoid racing with other projects');
  await page.goto('/app/settings');
  await page.getByTestId('camera-picker').selectOption({ label: 'Porch' });
  const name = page.getByTestId('osd-name');
  await expect(name).toBeVisible();
  await name.fill(`Porch ${Date.now() % 1000}`);
  const value = await name.inputValue();
  await page.getByTestId('save-image').click();
  await expect(page.getByTestId('settings-card-image').getByTestId('save-state')).toHaveAttribute('data-state', 'saved');
  // Settings has no ?cam= in the URL (unlike Recordings), so a reload goes
  // back to the default camera (cam1/Den); re-pick Porch to see its
  // persisted value, proving the change reached the camera rather than just
  // the in-page edit buffer.
  await page.reload();
  await page.getByTestId('camera-picker').selectOption({ label: 'Porch' });
  await expect(page.getByTestId('osd-name')).toHaveValue(value);
  // restore, so other tests see the default name
  await page.getByTestId('osd-name').fill('Porch');
  await page.getByTestId('save-image').click();
  await expect(page.getByTestId('settings-card-image').getByTestId('save-state')).toHaveAttribute('data-state', 'saved');
});

test('a rejected field shows the error next to it while the others save', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'mutates Porch, which is shared mock-camera state; avoid racing with other projects');
  await page.goto('/app/settings');
  await page.getByTestId('camera-picker').selectOption({ label: 'Porch' });
  await expect(page.getByTestId('spotlight-mode')).toBeVisible();
  await page.getByTestId('spotlight-mode').selectOption('off');
  await page.getByTestId('daynight-select').selectOption('color');
  await page.getByTestId('save-image').click();
  const card = page.getByTestId('settings-card-image');
  await expect(card.getByTestId('save-state')).toHaveAttribute('data-state', 'partial');
  await expect(card.getByTestId('field-error-spotlight')).toBeVisible();
  await expect(page.getByTestId('daynight-select')).toHaveValue('color');
  // restore the field that actually changed on the camera; the spotlight
  // write was rejected by the mock, so the camera's own mode never moved.
  await page.getByTestId('daynight-select').selectOption('auto');
  await page.getByTestId('save-image').click();
  await expect(card.getByTestId('save-state')).toHaveAttribute('data-state', 'saved');
});

// Read-only (nothing is saved): Save stays disabled while the name is invalid.
test('an OSD name over 31 bytes or with invisible characters cannot be saved', async ({ page }) => {
  await page.goto('/app/settings');
  const name = page.getByTestId('osd-name');
  await expect(name).toHaveValue('Den');
  await name.fill('門'.repeat(11));
  await expect(page.getByTestId('osd-name-bytes')).toHaveText('33/31 bytes');
  await expect(page.getByTestId('osd-name-error')).toContainText('at most 31 bytes');
  await expect(page.getByTestId('save-image')).toBeDisabled();
  await name.fill('\u200bDen');
  await expect(page.getByTestId('osd-name-error')).toContainText('invisible');
  await expect(page.getByTestId('save-image')).toBeDisabled();
  await name.fill('Den 2');
  await expect(page.getByTestId('osd-name-error')).toHaveCount(0);
  await expect(page.getByTestId('save-image')).toBeEnabled();
});

test('an offline camera shows a clear message instead of a spinner', async ({ page }) => {
  await page.goto('/app/settings');
  await page.getByTestId('camera-picker').selectOption({ label: 'Garage' });
  await expect(page.getByTestId('settings-card-detection').getByRole('alert')).toContainText('could not be loaded');
});

test('reboot needs a second click and can be cancelled', async ({ page }) => {
  await page.goto('/app/settings');
  await page.getByTestId('reboot-button').click();
  await expect(page.getByTestId('reboot-confirm')).toBeVisible();
  await page.getByTestId('reboot-cancel').click();
  await expect(page.getByTestId('reboot-confirm')).toHaveCount(0);
  const state = await (await page.request.get('http://127.0.0.1:8098/__state')).json();
  expect(state.reboots).toBe(0);
});

// The server's answer is faked, so no camera is actually rebooted.
test('a reboot refused by the cooldown says to wait', async ({ page }) => {
  await page.route('**/api/cameras/*/reboot', (route) => route.fulfill({ status: 429, json: { error: 'reboot_cooldown' } }));
  await page.goto('/app/settings');
  await page.getByTestId('reboot-button').click();
  await page.getByTestId('reboot-confirm').click();
  await expect(page.getByTestId('reboot-status')).toHaveText('Rebooted recently; wait a minute.');
});

test('preferences save and apply', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'preferences live in one shared file; only run this in one project to avoid a race');
  await page.goto('/app/settings');
  await page.getByTestId('pref-zoom').selectOption('6');
  await page.getByTestId('save-prefs').click();
  await expect(page.getByTestId('settings-card-prefs').getByTestId('save-state')).toHaveAttribute('data-state', 'saved');
  await page.goto('/app/recordings?panel=history');
  await expect(page.getByTestId('zoom-6')).toHaveAttribute('aria-pressed', 'true');
  // restore
  await page.goto('/app/settings');
  await page.getByTestId('pref-zoom').selectOption('24');
  await page.getByTestId('save-prefs').click();
  await expect(page.getByTestId('settings-card-prefs').getByTestId('save-state')).toHaveAttribute('data-state', 'saved');
});

test('the camera web UI link points at the LAN address and says it is home-network only', async ({ page }) => {
  await page.goto('/app/live');
  const link = page.getByTestId('camera-webui-link');
  await expect(link).toHaveAttribute('href', 'https://127.0.0.1/');
  await expect(link).toHaveAttribute('title', /home network only/);
  await expect(link).toHaveAttribute('target', '_blank');
  await page.goto('/app/settings');
  await expect(page.getByTestId('device-webui-link')).toHaveAttribute('href', 'https://127.0.0.1/');
  await expect(page.getByTestId('settings-card-device')).toContainText("isn't reachable from the internet");
});

test('about shows version, build, cameras and licences', async ({ page }) => {
  await page.goto('/app/about');
  await expect(page.getByTestId('about-version')).toBeVisible();
  await expect(page.getByTestId('about-build')).toBeVisible();
  await expect(page.getByTestId('about-cameras')).toContainText('RLC-1224A');
  await expect(page.getByTestId('about-cameras')).toContainText('Garage: offline');
  await expect(page.getByTestId('about-licences')).toContainText('mpegts.js');
});
