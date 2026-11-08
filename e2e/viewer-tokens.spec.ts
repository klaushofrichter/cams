import { expect, test, type Page } from '@playwright/test';
import { FAKE_ADMIN_HOOKS } from './env';
import { E2E_VIEWER_TOKENS } from './fakeAdmin';
import qr from '../test/fixtures/viewer-token-qr.json';

// Viewer tokens, the cams side (cams-admin design
// docs/superpowers/specs/2026-11-05-viewer-tokens-design.md §9), against the
// cams-admin-mode server and its fake cams-admin (projects admin-desktop and
// admin-phone; the fake pulls every second). Paste, the link (fragment out of
// the address at once, then the confirm step), the scanner (a QR code drawn
// on a canvas stands in for the camera: getUserMedia is stubbed with the
// canvas's stream, read by jsQR or by a stubbed BarcodeDetector), an expired
// token, a revoke that signs the session out after the next pull, the
// picker for two accounts, and About's "Signed in as".
test.describe.configure({ mode: 'serial' });

const T = E2E_VIEWER_TOKENS;
const revoke = (ids: string[]) => fetch(`http://127.0.0.1:${FAKE_ADMIN_HOOKS}/viewer-tokens`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revoked: ids }) });
// Through the browser context's cookies, not the page: the page itself leaves once it notices.
const meStatus = (page: Page) => page.request.get('/api/me').then((r) => r.status());

async function expectSignedInAs(page: Page, name: string) {
  await expect(page).toHaveURL(/\/app\/video/);
  await expect(page.getByTestId('camera-picker').locator('option')).toHaveText(['Den']);
  await page.goto('/app/about');
  await expect(page.getByTestId('about-signed-in')).toHaveText(new RegExp(`^${name}, valid until .+`));
}

// The camera: a canvas showing the fixture's QR code (6 px a module, quiet
// zone 4), its stream handed out by getUserMedia. `detector`: a stubbed
// BarcodeDetector answering the code's text; otherwise none, so jsQR reads
// the frames (the iOS Safari path).
async function fakeCamera(page: Page, detector: boolean) {
  await page.addInitScript(({ rows, text, detector }) => {
    const w = window as unknown as Record<string, unknown>;
    if (detector) {
      w.BarcodeDetector = class {
        static async getSupportedFormats() { return ['qr_code']; }
        async detect() { return [{ rawValue: text }]; }
      };
    } else delete w.BarcodeDetector;
    navigator.mediaDevices.getUserMedia = async () => {
      const px = 6, quiet = 4, n = rows.length + 2 * quiet;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = n * px;
      const ctx = canvas.getContext('2d')!;
      const paint = () => {
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#000';
        rows.forEach((row, r) => [...row].forEach((bit, c) => bit === '1' && ctx.fillRect((c + quiet) * px, (r + quiet) * px, px, px)));
      };
      paint();
      setInterval(paint, 100); // a stream sends frames when the canvas is drawn
      return canvas.captureStream(10);
    };
  }, { rows: qr.rows, text: qr.text, detector });
}

test('the sign-in page links to "Sign in with a token"; a token in the query is refused', async ({ page }) => {
  await page.goto('/signin');
  const link = page.getByTestId('viewer-token-link');
  await expect(link).toHaveText('Sign in with a token');
  await link.click();
  await expect(page).toHaveURL(/\/token$/);
  await expect(page.getByTestId('vt-input')).toBeVisible();
  await expect(page.getByTestId('vt-scan')).toBeVisible(); // localhost is a secure page
  const r = await page.request.get(`/token?t=${T.paste.token}`);
  expect(r.status()).toBe(400);
});

test('paste: signed in as a viewer of the token\'s account; About says who', async ({ page, context }) => {
  await page.goto('/token');
  await page.getByTestId('vt-input').fill(`  ${T.paste.token} `);
  await page.getByTestId('vt-submit').click();
  await expectSignedInAs(page, T.paste.name);
  const session = (await context.cookies()).find((c) => c.name === 'session')!;
  expect(session.httpOnly).toBe(true);
  expect(session.value).not.toContain(T.paste.token);
  const me = await page.evaluate(async () => (await (await fetch('/api/me')).json()) as { role: string; via: string });
  expect(me).toMatchObject({ role: 'viewer', via: 'viewer-token' });
  await expect(page.getByTestId('about-role')).toHaveText('Viewer');
});

test('an admin token (role "admin"): an admin of its account; About says so', async ({ page }) => {
  await page.goto('/token');
  await page.getByTestId('vt-input').fill(T.admin.token);
  await page.getByTestId('vt-submit').click();
  await expectSignedInAs(page, T.admin.name);
  await expect(page.getByTestId('about-role')).toHaveText('Admin');
  const me = await page.evaluate(async () => (await (await fetch('/api/me')).json()) as { role: string; via: string });
  expect(me).toMatchObject({ role: 'admin', via: 'viewer-token' });
  expect(await page.evaluate(async () => (await fetch('/api/admin/held')).status)).toBe(200);
});

test('the link: the fragment leaves the address at once, then "Sign in as \'<name>\'?" and one button', async ({ page }) => {
  await page.goto(`/token#t=${T.link.token}`);
  await expect(page.getByTestId('vt-confirm-text')).toHaveText(`Sign in as '${T.link.name}'?`);
  expect(new URL(page.url()).hash).toBe('');
  expect(page.url()).not.toContain(T.link.token);
  await expect(page.getByTestId('vt-confirm-valid')).toHaveText(/^Valid until .+ \(6 days left\)$/); // the fake's tokens last 7 days, rounded down
  expect(await meStatus(page)).toBe(401); // nothing signed in before the click
  await page.getByTestId('vt-signin').click();
  await expectSignedInAs(page, T.link.name);
});

test('About shows the time left, and it moves with the clock', async ({ page }) => {
  await page.clock.install();
  await page.goto('/token');
  await page.getByTestId('vt-input').fill(T.paste.token);
  await page.getByTestId('vt-submit').click();
  await expectSignedInAs(page, T.paste.name);
  const line = page.getByTestId('about-signed-in');
  await expect(line).toHaveText(/, valid until .+ \(6 days left\)$/);
  await page.clock.fastForward(25 * 3_600_000);
  await expect(line).toHaveText(/ \(5 days left\)$/);
  await page.clock.fastForward(119.5 * 3_600_000);
  await expect(line).toHaveText(/ \(\d+ hours left\)$/);
});

test('an expired token is refused, by link and by paste', async ({ page, context }) => {
  await page.goto(`/token#t=${T.expired.token}`);
  await expect(page.getByTestId('vt-error')).toContainText('expired or been revoked');
  await expect(page.getByTestId('vt-confirm')).toHaveCount(0);
  await page.getByTestId('vt-input').fill(T.expired.token);
  await page.getByTestId('vt-submit').click();
  await expect(page.getByTestId('vt-error')).toContainText('expired or been revoked');
  await expect(page).toHaveURL(/\/token$/);
  expect((await context.cookies()).map((c) => c.name)).not.toContain('session');
});

test('a revoke in cams-admin signs the session out after the next pull', async ({ page }, info) => {
  const t = info.project.name.includes('phone') ? T.revokePhone : T.revokeDesktop;
  await page.goto(`/token#t=${t.token}`);
  await page.getByTestId('vt-signin').click();
  await expect(page).toHaveURL(/\/app\/video/);
  await expect(page.getByTestId('camera-picker').locator('option')).toHaveText(['Den']);
  try {
    await revoke([t.id]);
    await expect.poll(() => meStatus(page), { timeout: 15_000 }).toBe(401);
    // The app's pages are closed to it again: back to the token page.
    await page.goto('/app/video');
    await expect(page).toHaveURL(/\/token$/);
    await page.goto(`/token#t=${t.token}`);
    await expect(page.getByTestId('vt-error')).toContainText('expired or been revoked');
  } finally {
    await revoke([]);
  }
});

test('a token with two accounts: the picker, both as viewer', async ({ page }) => {
  await page.goto('/token');
  await page.getByTestId('vt-input').fill(T.two.token);
  await page.getByTestId('vt-submit').click();
  await expect(page).toHaveURL(/\/app\/accounts$/);
  await expect(page.getByTestId('account-acc_00000000000000000HME')).toContainText('Viewer');
  await expect(page.getByTestId('account-acc_00000000000000000BTA')).toContainText('Viewer');
  await page.getByTestId('account-acc_00000000000000000BTA').click();
  await expect(page).toHaveURL(/\/app\/video/);
  await expect(page.getByTestId('camera-picker').locator('option')).toHaveText(['Porch']);
});

for (const detector of [false, true]) {
  test(`the scanner (${detector ? 'BarcodeDetector' : 'jsQR'}): the code read from the camera, then the confirm step`, async ({ page }) => {
    await fakeCamera(page, detector);
    await page.goto('/token');
    await page.getByTestId('vt-scan').click();
    await expect(page.getByTestId('vt-confirm-text')).toHaveText(`Sign in as '${T.scan.name}'?`, { timeout: 15_000 });
    await expect(page.getByTestId('vt-video')).toHaveCount(0); // the camera is let go
    await page.getByTestId('vt-signin').click();
    await expectSignedInAs(page, T.scan.name);
  });
}
