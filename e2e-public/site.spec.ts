/**
 * The public pages, walked as a signed-out visitor walks them, in four
 * browsers. Tests tagged @live are read-only (GET, never a sign-in, never a
 * POST) and run twice: before a release against the image the release will
 * ship (production-checks.yml) and after it against
 * https://cams.skylar.technology (live-check.yml). Nothing here touches a
 * camera, a stream, cam-proxy, cams-admin or /mcp.
 */
import { expect, Page, Locator } from '@playwright/test';
import { test, expectAllPicturesLoaded, PUBLIC_PAGES, reportCspViolations, scrollThrough, watchProblems } from './helpers';

/** Set by the workflows to the version the server must report. */
const EXPECT_VERSION = process.env.EXPECT_VERSION;

// The heading breaks its line with a <br>, which innerText reads as nothing.
const HOME_H1 = /^Your cameras,\s*live and on record\.$/;
/** Where the walk stops: the sign-ins themselves (Google's hand-over, the token form's POST). */
const LOGIN = /^\/auth\//;

async function press(page: Page, isMobile: boolean, locator: Locator) {
  if (isMobile) await locator.tap();
  else await locator.click();
}

test('@live /health is ok and names the release', async ({ request }) => {
  const res = await request.get('/health');
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.status).toBe('ok');
  expect(typeof body.version).toBe('string');
  if (EXPECT_VERSION) expect(body.version).toBe(EXPECT_VERSION);
});

test('@live the start page loads completely, every picture included', async ({ page }) => {
  const problems = watchProblems(page);
  await reportCspViolations(page);
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle('cams · Skylar Technology');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(HOME_H1);
  for (const h2 of ['Everything a camera system should do', 'Built by Skylar Technology']) {
    await expect(page.getByRole('heading', { level: 2, name: h2 })).toBeVisible();
  }
  await scrollThrough(page);
  await expectAllPicturesLoaded(page);
  expect(await page.getByTestId('shot').count()).toBeGreaterThan(5);
  expect(problems).toEqual([]);
});

test('@live every link on every public page goes somewhere that works', async ({ context, request, baseURL }) => {
  // From the start page, every same-site link on every page reached, so a
  // page added later is covered without touching this test. It stops at the
  // sign-ins (/auth/...). Other sites are not ours to test, only their shape.
  test.setTimeout(180_000);
  const origin = new URL(baseURL!).origin;
  const pages = ['/'];
  const visited = new Set<string>();
  const checked = new Set<string>();

  while (pages.length) {
    const path = pages.shift()!;
    if (visited.has(path)) continue;
    visited.add(path);

    const page = await context.newPage();
    const problems = watchProblems(page);
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(200);
    await expect(page.getByRole('heading', { level: 1 }), path).toBeVisible();
    await scrollThrough(page);
    await expectAllPicturesLoaded(page);
    expect(problems, path).toEqual([]);

    const anchors = await page.locator('a[href]').evaluateAll((as) =>
      as.map((a) => ({ href: a.getAttribute('href')!, target: a.getAttribute('target'), rel: a.getAttribute('rel') ?? '' })),
    );
    expect(anchors.length, path).toBeGreaterThan(0);
    for (const { href, target, rel } of anchors) {
      if (href.startsWith('#')) {
        await expect(page.locator(href), `anchor ${href} on ${path}`).toHaveCount(1);
        continue;
      }
      const url = new URL(href, origin + path);
      if (url.origin !== origin) {
        if (checked.has(url.href)) continue;
        checked.add(url.href);
        expect(url.protocol, href).toBe('https:');
        // Another site opens in a new tab, without a window.opener.
        expect(target, href).toBe('_blank');
        expect(rel, href).toContain('noopener');
        continue;
      }
      if (LOGIN.test(url.pathname)) continue;
      if (/\.(png|webp|jpe?g|svg|ico|txt|webmanifest)$/.test(url.pathname)) {
        if (checked.has(url.pathname)) continue;
        checked.add(url.pathname);
        const file = await request.get(url.href);
        expect(file.status(), url.pathname).toBe(200);
        continue;
      }
      if (!visited.has(url.pathname)) pages.push(url.pathname);
    }
    await page.close();
  }
  // Only the public pages (the production start page links the sign-in page,
  // which links the token page; the local Google-only server links neither).
  expect([...visited].every((p) => (PUBLIC_PAGES as readonly string[]).includes(p)), [...visited].join(' ')).toBe(true);
  expect(checked.has('/llms.txt')).toBe(true);
});

test('@live the sign-in pages load and stop short of signing in', async ({ page }) => {
  const problems = watchProblems(page);
  await reportCspViolations(page);
  for (const [path, h1] of [
    ['/signin', 'Sign in to cams'],
    ['/token', 'Sign in with a token'],
  ]) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBe(200);
    await expect(page.getByRole('heading', { level: 1 }), path).toHaveText(h1);
    await expect(page.getByTestId('signin-home'), path).toHaveAttribute('href', '/');
  }
  // The token form waits for a token; nothing is sent.
  await expect(page.getByTestId('vt-input')).toBeVisible();
  await expect(page.getByTestId('vt-submit')).toBeDisabled();
  expect(problems).toEqual([]);
});

test('@live llms.txt is plain text', async ({ request }) => {
  const res = await request.get('/llms.txt');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toMatch(/^text\/plain/);
  expect(await res.text()).toContain('cams');
});

test("@live an unknown page is a 404 in the site's style, with a way home", async ({ page, isMobile }) => {
  const problems = watchProblems(page);
  const response = await page.goto('/does-not-exist');
  expect(response?.status()).toBe(404);
  expect(response?.headers()['content-type']).toMatch(/^text\/html/);
  await expect(page).toHaveTitle('Page not found · cams');
  expect(await page.locator('html').getAttribute('lang')).toBe('en');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Page not found');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
  // The site's own look: its colours and its logo, not a browser's plain text.
  await expect(page.locator('img[src="/favicon.svg"]')).toBeVisible();
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).not.toBe('rgba(0, 0, 0, 0)');
  await press(page, isMobile, page.getByRole('link', { name: /Back to cams/ }));
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(HOME_H1);
  // Chromium logs the 404 itself to the console; anything else is a problem.
  expect(problems.filter((p) => !/status of 404/.test(p))).toEqual([]);
});

test('@live a missing file under /api or /assets is still a short answer, not the 404 page', async ({ request }) => {
  const api = await request.get('/api/does-not-exist');
  expect([401, 404]).toContain(api.status());
  expect(api.headers()['content-type']).toMatch(/json/);
  const asset = await request.get('/assets/does-not-exist.js');
  expect(asset.status()).toBe(404);
  expect(asset.headers()['content-type']).not.toMatch(/html/);
});

test('@live a highlight card leads to its section', async ({ page, isMobile }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const card = page.getByTestId('highlight').first();
  const href = (await card.getAttribute('href'))!;
  await press(page, isMobile, card);
  await expect(page).toHaveURL(new RegExp(`${href}$`));
  await expect(page.locator(href)).toBeInViewport();
});

test('@live the theme button switches between light and dark', async ({ page, isMobile }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  const toggle = page.getByTestId('theme-toggle');
  await expect(toggle).toHaveAttribute('aria-label', 'Switch to light theme');
  const before = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await press(page, isMobile, toggle);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(toggle).toHaveAttribute('aria-label', 'Switch to dark theme');
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe(before);
});

test.describe('on a phone', () => {
  test('@live the sign-in menu opens with a tap and closes with a tap outside', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'phone projects only');
    // The hero rises into place; a tap needs it to hold still.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    const toggle = page.getByTestId('signin-toggle');
    const panel = page.locator('#signin-panel');
    await expect(panel).toBeHidden();
    await toggle.tap();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId('admin-console')).toBeVisible();
    // A tap outside, not Escape: a synthetic Escape doesn't reach the page in
    // the emulated iPhone (instagetter).
    // Low on the screen, clear of the open panel under the header.
    const view = page.viewportSize()!;
    await page.touchscreen.tap(view.width / 2, view.height - 40);
    await expect(panel).toBeHidden();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  test('@live fits without sideways scrolling, on every public page', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'phone projects only');
    for (const path of [...PUBLIC_PAGES, '/does-not-exist']) {
      await page.goto(path);
      await scrollThrough(page);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, path).toBeLessThanOrEqual(0);
    }
  });

  test('@live the public pages can be zoomed, and a field never zooms the page on focus', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'phone projects only');
    // WCAG 1.4.4: no maximum-scale or user-scalable=no on the public pages.
    // Instead, form fields are at least 16 px, so iOS doesn't zoom in when one
    // takes the focus.
    for (const path of PUBLIC_PAGES) {
      await page.goto(path);
      const viewport = (await page.locator('meta[name="viewport"]').getAttribute('content')) ?? '';
      expect(viewport, path).not.toMatch(/user-scalable\s*=\s*(no|0)|maximum-scale/);
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).touchAction), path).not.toMatch(/pan-x pan-y/);
      for (const size of await page.locator('input').evaluateAll((els) => els.map((e) => parseFloat(getComputedStyle(e).fontSize)))) {
        expect(size, `${path} input font size`).toBeGreaterThanOrEqual(16);
      }
    }
  });
});

test.describe('keyboard', () => {
  test('@live Tab reaches the header links and the first call to action, each with a visible focus ring', async ({ page, isMobile }) => {
    test.skip(isMobile, 'no keyboard on a phone');
    await page.goto('/');
    const seen: string[] = [];
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      // Firefox's first Tab can land on the document itself.
      if (await page.evaluate(() => document.activeElement === document.body)) continue;
      const focused = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement;
        const s = getComputedStyle(el);
        return { name: el.getAttribute('data-testid') ?? el.getAttribute('href') ?? el.tagName, ring: s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0 };
      });
      expect(focused.ring, `focus ring on ${focused.name}`).toBe(true);
      seen.push(focused.name);
    }
    for (const name of ['theme-toggle', 'admin-console', '#highlights']) expect(seen, seen.join(' ')).toContain(name);
  });
});
