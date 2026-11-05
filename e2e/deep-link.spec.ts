import { expect, test, type Page } from '@playwright/test';
import { signIn } from './session';
import { chicagoMs } from './fakeProxyData';
import { event, shownAt as shown, stubDay, urlAt, YESTERDAY } from './stubDay';

// A reload keeps the moment (to the second) and play or pause, and a link
// with a time opens there (Klaus, 2026-11-05): the URL says `at` in epoch
// seconds and `play=1` while playing; old links (`at` in ms, `clip` and `t`)
// still open where they did.
test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL!);
});

const badge = (page: Page) => page.getByTestId('mode-badge');
const play = (page: Page) => page.getByTestId('play-toggle');
function setup(page: Page) {
  const date = YESTERDAY();
  const a = event(date, '10:00:00', '10:00:25', 'person');
  const b = event(date, '10:00:25', '10:00:50', 'vehicle');
  return stubDay(page, date, [a, b]).then(() => ({ date, a, b }));
}

test('a reload while paused keeps the second, paused', async ({ page }) => {
  const { date } = await setup(page);
  const at = chicagoMs(date, '10:00:05');
  await page.goto(`/app/video?cam=cam1&date=${date}&at=${at}`); // an old link: ms
  await expect(badge(page)).toHaveAttribute('data-mode', 'rec');
  await page.getByTestId('fwd-10').click();
  await page.getByTestId('fwd-1').click();
  await expect.poll(() => shown(page, date)).toBe(at + 11_000);
  // The URL has it at once, in seconds.
  await expect.poll(() => new URL(page.url()).searchParams.get('at')).toBe(String((at + 11_000) / 1000));
  await page.reload();
  await expect(badge(page)).toHaveAttribute('data-mode', 'rec');
  await expect.poll(() => shown(page, date)).toBe(at + 11_000);
  await expect(play(page)).toHaveAttribute('aria-pressed', 'false');
  await page.waitForTimeout(1500);
  expect(await shown(page, date)).toBe(at + 11_000);
});

test('a reload while playing goes on playing from there, within a second', async ({ page }) => {
  const { date } = await setup(page);
  const at = chicagoMs(date, '10:00:02');
  await page.goto(`/app/video?cam=cam1&date=${date}&at=${at}`);
  await expect(badge(page)).toHaveAttribute('data-mode', 'rec');
  await play(page).click();
  await expect.poll(() => shown(page, date), { timeout: 10_000 }).toBeGreaterThanOrEqual(at + 4000);
  await expect(page).toHaveURL(/[?&]play=1(&|$)/);
  const before = await shown(page, date);
  await page.reload();
  await expect(badge(page)).toHaveAttribute('data-mode', 'rec');
  await expect(play(page)).toHaveAttribute('aria-pressed', 'true');
  // Restored no more than a second before what was on screen, and playing on.
  const after = await shown(page, date);
  expect(after).toBeGreaterThanOrEqual(before - 1000);
  expect(after).toBeLessThan(before + 4000);
  await expect.poll(() => shown(page, date), { timeout: 10_000 }).toBeGreaterThan(after);
  // Paused: the URL drops play=1.
  await play(page).click();
  await expect(page).not.toHaveURL(/play=/);
});

test('playing replaces the URL every second, without a history entry each', async ({ page }) => {
  const { date } = await setup(page);
  const at = chicagoMs(date, '10:00:02');
  await page.goto(`/app/video?cam=cam1&date=${date}&at=${at}`);
  await expect(badge(page)).toHaveAttribute('data-mode', 'rec');
  const entries = await page.evaluate(() => history.length);
  await play(page).click();
  await expect.poll(() => shown(page, date), { timeout: 10_000 }).toBeGreaterThan(at + 1000); // under way
  const seen = new Set<string>();
  for (let i = 0; i < 12; i++) {
    seen.add(new URL(page.url()).searchParams.get('at')!);
    await page.waitForTimeout(250);
  }
  expect(seen.size).toBeGreaterThanOrEqual(3); // about one a second in 3 s
  expect(await page.evaluate(() => history.length)).toBe(entries);
  for (const s of seen) expect(s).toMatch(/^\d{10}$/);
});

test('a link opens at its moment in another browser: paused, or playing with play=1', async ({ browser, baseURL, page }) => {
  const { date } = await setup(page);
  const at = chicagoMs(date, '10:00:30');
  for (const [link, playing] of [[`/app/video?cam=cam1&date=${date}&at=${at / 1000}`, false], [`/app/video?cam=cam1&date=${date}&at=${at / 1000}&play=1`, true]] as const) {
    const other = await browser.newContext({ timezoneId: 'America/Chicago' }); // no sessionStorage, no history
    await signIn(other, baseURL!);
    const p = await other.newPage();
    await stubDay(p, date, [event(date, '10:00:00', '10:00:25', 'person'), event(date, '10:00:25', '10:00:50', 'vehicle')]);
    await p.goto(link);
    await expect(badge(p)).toHaveAttribute('data-mode', 'rec');
    await expect(p.locator('[data-testid="event-card"][aria-current="true"]')).toHaveAttribute('data-clip-id', /-100025-100050$/);
    await expect(play(p)).toHaveAttribute('aria-pressed', String(playing));
    const t = await shown(p, date);
    if (playing) await expect.poll(() => shown(p, date), { timeout: 10_000 }).toBeGreaterThan(t);
    else expect(t).toBe(at);
    await other.close();
  }
});

test('old links still open where they did: `at` in ms, and clip with t', async ({ page }) => {
  const { date, b } = await setup(page);
  await page.goto(`/app/video?cam=cam1&date=${date}&at=${chicagoMs(date, '10:00:07')}`);
  await expect.poll(() => shown(page, date)).toBe(chicagoMs(date, '10:00:07'));
  await page.goto(`/app/video?cam=cam1&date=${date}&clip=${b.id}&t=5`);
  await expect.poll(() => shown(page, date)).toBe(chicagoMs(date, '10:00:30'));
  await expect(play(page)).toHaveAttribute('aria-pressed', 'false');
});

test('a link to a time without a recording opens there, as the page does for any such time', async ({ page }) => {
  const { date } = await setup(page);
  const at = chicagoMs(date, '11:30:00');
  await page.goto(`/app/video?cam=cam1&date=${date}&at=${at / 1000}`);
  await expect(badge(page)).toHaveAttribute('data-mode', 'rec');
  await expect.poll(() => shown(page, date)).toBe(at);
  await expect(play(page)).toHaveAttribute('aria-pressed', 'false');
  expect(urlAt(page.url())).toBe(at);
});

test('a reload while live stays live', async ({ page }) => {
  await page.goto('/app/video');
  await expect(badge(page)).toHaveAttribute('data-mode', 'live');
  await page.getByTestId('back-10').click();
  await expect(badge(page)).toHaveAttribute('data-mode', 'rec');
  await page.getByTestId('strip-now').click();
  await expect(badge(page)).toHaveAttribute('data-mode', 'live');
  await expect(page).toHaveURL(/\/app\/video$/);
  await page.reload();
  await expect(badge(page)).toHaveAttribute('data-mode', 'live');
  await expect(page).toHaveURL(/\/app\/video$/);
});
