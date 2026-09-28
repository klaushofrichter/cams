// Production freeze 2026-09-28: cam2 (cam-sim) drops preview tiles, and the
// strip compared every boundary with every run each second. Live and History
// must stay responsive with previews like that.
import { expect, test, type Page } from '@playwright/test';
import { signIn } from './session';
// Previews like cam2's: many single missing tiles plus ~2000 real holes over 72 h.
function minutes(from: number, to: number) {
  const out = [];
  for (let m = Math.ceil(from / 60_000) * 60_000; m <= to; m += 60_000) {
    const k = m / 60_000;
    out.push({ minute: m, cols: 10, rows: 6, tileW: 160, tileH: 90, intervalS: 1,
      present: Array.from({ length: 60 }, (_, i) => !((k * 60 + i) % 7 === 3 || (k % 2 === 0 && i >= 20 && i < 24))) });
  }
  return out;
}
async function lag(page: Page) {
  const t = Date.now();
  await Promise.race([page.evaluate(() => 1), new Promise((r) => setTimeout(r, 10_000))]);
  return Date.now() - t;
}
for (const url of ['/app/live', '/app/recordings?panel=history']) {
  test(`gappy previews stay responsive on ${url}`, async ({ context, baseURL, page }) => {
    await signIn(context, baseURL!);
    await page.route(/\/api\/cameras\/cam1\/previews\?/, (r) => {
      const u = new URL(r.request().url());
      return r.fulfill({ json: minutes(Number(u.searchParams.get('from')), Number(u.searchParams.get('to'))) });
    });
    await page.goto(url);
    await page.getByTestId('camera-picker').selectOption('cam1');
    const lags: number[] = [];
    for (let i = 0; i < 8; i++) { await page.waitForTimeout(1000); lags.push(await lag(page)); }
    expect(Math.max(...lags)).toBeLessThan(300);
  });
}
