import { expect, test, type Page } from '@playwright/test';
import { chicagoMs, FAKE_PROXY_PORT } from './fakeProxyData';
import { signIn } from './session';

// "Save clip around this" (#179 phase 3, spec 2026-10-04-still-checks-ui-design
// §5), against the fake cam-proxy implementing cam-proxy's `at` compositions.
// Each test uses a random minute of yesterday of its own (desktop and phone
// run at once), given one still per second by a test hook.
const HOOKS = `http://127.0.0.1:${FAKE_PROXY_PORT - 2}`;
const chicagoDate = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(ms));
const SHOTS = process.env.AROUND_SHOTS; // a folder: screenshots of the dialog (desktop/phone, light/dark)

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL!);
  // Yesterday's minutes are older than the fake's oldest seeded still: no lower bound here.
  await context.route('**/api/cameras/cam1/extent', (r) => r.fulfill({ json: { oldest: null, stills: null } }));
});

async function aSecond(page: Page): Promise<{ at: number; date: string; minute: number }> {
  const date = chicagoDate(Date.now() - 86_400_000);
  const hh = String(1 + Math.floor(Math.random() * 21)).padStart(2, '0');
  const mm = String(Math.floor(Math.random() * 60)).padStart(2, '0');
  const minute = chicagoMs(date, `${hh}:${mm}:00`);
  const at = minute + (20 + Math.floor(Math.random() * 20)) * 1000; // ±10 s stay in the minute
  expect((await page.request.post(`${HOOKS}/stills-minute`, { data: { cam: 'cam1', minute } })).ok()).toBe(true);
  return { at, date, minute };
}
const openAround = async (page: Page, s: { at: number; date: string }) => {
  await page.goto(`/app/timeline?cam=cam1&date=${s.date}&t=${s.at}`);
  await expect(page.getByTestId('timeline-still')).toHaveAttribute('src', `/api/cameras/cam1/stills/${s.at}.jpg`);
  await page.getByTestId('still-around-button').click();
  await expect(page.getByTestId('compose-dialog')).toHaveAttribute('aria-label', /^Save clip around /);
};
// Generate, wait for the result, and fetch what Save would download.
async function generateAndSave(page: Page): Promise<void> {
  await page.getByTestId('compose-generate').click();
  await expect(page.getByTestId('compose-player')).toBeVisible({ timeout: 15_000 });
  const save = page.getByTestId('compose-save');
  await expect(save).toHaveAttribute('aria-disabled', 'false');
  const href = (await save.getAttribute('href'))!;
  expect(href).toMatch(/name=cam1-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-around\.mp4$/);
  const r = await page.request.get(href);
  expect(r.status()).toBe(200);
  expect(r.headers()['content-type']).toBe('video/mp4');
  expect(r.headers()['content-disposition']).toMatch(/^attachment; filename="cam1-.*-around\.mp4"$/);
}

test('save around a still-only second: -10/+10, stills only, generated and saved', async ({ page }, info) => {
  const s = await aSecond(page);
  await openAround(page, s);
  await expect(page.getByTestId('compose-length')).toHaveText('Result: 21s · at most 5m');
  await expect(page.getByTestId('compose-made-of')).toHaveText('Made of: Stills only (1 per second)');
  await expect(page.getByTestId('compose-size').locator('option')).toHaveText(['SD 896×512 (original)', '640×360', '1280×720 (upscaled)', '1920×1080 (upscaled)']);
  if (SHOTS) {
    const size = info.project.name === 'phone' ? 'phone' : 'desktop';
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      await page.screenshot({ path: `${SHOTS}/${size}-${theme}-dialog.png` });
    }
    await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
  }
  await page.getByTestId('compose-size').selectOption('1080p');
  await expect(page.getByTestId('compose-length')).toHaveText('Result: 21s · at most 2m');
  await generateAndSave(page);
  if (SHOTS) {
    const size = info.project.name === 'phone' ? 'phone' : 'desktop';
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      await page.screenshot({ path: `${SHOTS}/${size}-${theme}-result.png` });
    }
  }
});

test('save around a clip second: the FTP clip and stills before it', async ({ page }) => {
  const s = await aSecond(page);
  expect((await page.request.post(`${HOOKS}/ftp-clip`, { data: { cam: 'cam1', start: s.at - 4000, end: s.at + 30_000 } })).ok()).toBe(true);
  await openAround(page, s);
  await expect(page.getByTestId('compose-made-of')).toHaveText(/^Made of: FTP clip [^–]+–[^–]+ and stills \(1 per second\)$/);
  // Only the clip: 4 s before, 10 s after.
  await page.getByTestId('compose-pre').fill('4');
  await expect(page.getByTestId('compose-made-of')).toHaveText(/^Made of: FTP clip [^–]+–[^–]+$/);
  await expect(page.getByTestId('compose-length')).toHaveText('Result: 15s · at most 5m');
  await generateAndSave(page);
});

test('refused when nothing covers the window (stills gone, no clip)', async ({ page }) => {
  const s = await aSecond(page);
  await page.goto(`/app/timeline?cam=cam1&date=${s.date}&t=${s.at}`);
  await expect(page.getByTestId('timeline-still')).toBeVisible();
  // Retention took the minute's stills meanwhile.
  expect((await page.request.post(`${HOOKS}/stills-clear`, { data: { cam: 'cam1', from: s.minute, to: s.minute + 60_000 } })).ok()).toBe(true);
  await page.getByTestId('still-around-button').click();
  await expect(page.getByTestId('compose-nothing')).toHaveText('Nothing is kept around this second (stills and clips are kept 7 days).');
  await expect(page.getByTestId('compose-generate')).toHaveCount(0);
  // The relay passes the proxy's refusal through.
  const r = await page.request.post('/api/cameras/cam1/compositions', { data: { at: s.at, preS: 10, postS: 10, size: 'sd', badge: true } });
  expect(r.status()).toBe(409);
  expect(await r.json()).toEqual({ error: 'nothing_to_compose', detail: 'no clip or still covers any second of this window' });
  await page.getByTestId('compose-close').click();
  await expect(page.getByTestId('compose-dialog')).toHaveCount(0);
});
