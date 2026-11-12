/**
 * Qualities that are easy to lose without noticing: the start page does not
 * jump while it loads, a phone fetches no more than this page needs, the
 * screenshots are no larger than they are drawn, and nothing errors along the
 * way.
 */
import { expect } from '@playwright/test';
import { test, expectAllPicturesLoaded, PUBLIC_PAGES, reportCspViolations, scrollThrough, watchProblems } from './helpers';

test('@live nothing jumps while the start page loads (layout shift)', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __cls: number }).__cls = 0;
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries() as unknown as { value: number; hadRecentInput: boolean }[]) {
          if (!e.hadRecentInput) (window as unknown as { __cls: number }).__cls += e.value;
        }
      }).observe({ type: 'layout-shift', buffered: true });
    } catch {
      /* no layout-shift entries in this engine */
    }
  });
  await page.goto('/');
  await scrollThrough(page);
  await expectAllPicturesLoaded(page);
  // Only Chromium reports layout shifts; elsewhere this reads 0. Every
  // screenshot has its width and height, so its box is there before it is.
  const cls = await page.evaluate(() => (window as unknown as { __cls: number }).__cls);
  expect(cls).toBeLessThan(0.02);
});

test('@live every screenshot holds its place before it arrives', async ({ page }) => {
  const missing = await (async () => {
    await page.goto('/');
    return page.locator('img').evaluateAll((imgs) => imgs.filter((i) => !i.getAttribute('width') || !i.getAttribute('height')).map((i) => i.getAttribute('src')));
  })();
  expect(missing).toEqual([]);
});

test('@live a phone fetches no more than the start page needs', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'phone projects only');
  // Counted from the responses rather than the Resource Timing entries,
  // which WebKit reports as 0 bytes for the screenshots.
  const bodies: Promise<{ url: string; bytes: number }>[] = [];
  page.on('response', (r) => {
    const u = new URL(r.url());
    if (u.origin !== new URL(page.url() || r.url()).origin || r.status() !== 200) return;
    bodies.push(r.body().then((b) => ({ url: u.pathname, bytes: b.length }), () => ({ url: u.pathname, bytes: 0 })));
  });
  await page.goto('/', { waitUntil: 'load' });
  await scrollThrough(page);
  await expectAllPicturesLoaded(page);
  const entries = await Promise.all(bodies);
  // The budget for THIS page, measured on https://cams.skylar.technology on
  // 2026-11-11 with a Pixel 7 profile, the whole page scrolled: the page, its
  // scripts and stylesheets (uncompressed: the cluster sends them as they
  // are) 157 KB; the screenshots, all 14 fetched once scrolled to, 317 KB,
  // the largest 44 KB. About a third more than that, so a new screenshot or a
  // heavier bundle is a decision, not an accident.
  const text = entries.filter((e) => !/\.(webp|png|svg|ico|jpe?g)$/.test(e.url));
  const textBytes = text.reduce((n, e) => n + e.bytes, 0);
  expect(textBytes, text.map((e) => `${e.url} ${e.bytes}`).join('\n')).toBeLessThan(TEXT_BUDGET);
  const pictures = entries.filter((e) => /\.(webp|png|jpe?g|svg)$/.test(e.url));
  const pictureBytes = pictures.reduce((n, e) => n + e.bytes, 0);
  expect(pictureBytes, pictures.map((e) => `${e.url} ${e.bytes}`).join('\n')).toBeLessThan(PICTURE_BUDGET);
  for (const p of pictures) expect(p.bytes, p.url).toBeLessThan(60_000);
});

test('@live no screenshot is much larger than a phone draws it', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'phone projects only: the byte budget is a phone\'s');
  await page.goto('/');
  await scrollThrough(page);
  await expectAllPicturesLoaded(page);
  const oversized = await page.locator('img').evaluateAll((imgs) =>
    (imgs as HTMLImageElement[])
      .map((i) => ({ url: i.currentSrc, file: i.naturalWidth, need: i.getBoundingClientRect().width * devicePixelRatio }))
      // A file up to twice the drawn width (a sharper picture on the next
      // zoom step) is fine; a 1200 px shot drawn at 100 px is not.
      .filter((i) => i.need > 0 && i.file > Math.max(i.need * 2.5, 600))
      .map((i) => `${i.url}: ${i.file}px for ${Math.round(i.need)}px`),
  );
  expect(oversized).toEqual([]);
});

test('@live no console errors or CSP violations through a full visit', async ({ page }) => {
  const problems = watchProblems(page);
  await reportCspViolations(page);
  for (const path of PUBLIC_PAGES) {
    await page.goto(path);
    await scrollThrough(page);
  }
  expect(problems).toEqual([]);
});

// Set from the measurement above (see the comment there).
const TEXT_BUDGET = 215_000;
const PICTURE_BUDGET = 420_000;
