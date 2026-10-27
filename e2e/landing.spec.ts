import { expect, test } from '@playwright/test';
import { signIn } from './session';
import { openSignIn } from './landingSignIn';

test.describe('landing page', () => {
  test('shows branding, the camera illustration and the Google login', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Your cameras');
    await expect(page.getByText('Skylar Technology LLC').first()).toBeVisible();
    // Every mention of the company (header byline, the closing section and
    // the footer) links to its site.
    const company = page.getByRole('link', { name: 'Skylar Technology LLC' });
    await expect(company).toHaveCount(3);
    for (const link of await company.all()) {
      await expect(link).toHaveAttribute('href', 'https://skylar.technology');
    }
    // And no "Skylar Technology LLC" text sits outside such a link.
    const unlinked = await page.evaluate(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n = 0;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.includes('Skylar Technology LLC')) continue;
        const a = node.parentElement?.closest('a');
        if (a?.getAttribute('href') !== 'https://skylar.technology') n += 1;
      }
      return n;
    });
    expect(unlinked).toBe(0);
    await expect(page.getByRole('img', { name: /RLC-1224A/ })).toBeVisible();
    const login = page.getByTestId('login');
    await expect(login).toHaveAttribute('href', '/auth/google/login');
  });

  test('the sign-in and the admin console link sit in the header, upper right', async ({ page }, info) => {
    await page.goto('/');
    const header = page.getByRole('banner');
    const phone = info.project.name === 'phone';
    if (phone) {
      // A compact button opens the sign-in options.
      await expect(header.getByTestId('login')).toBeHidden();
      await expect(header.getByTestId('signin-toggle')).toBeVisible();
      await header.getByTestId('signin-toggle').click();
      await expect(header.getByTestId('signin-toggle')).toHaveAttribute('aria-expanded', 'true');
    } else {
      await expect(page.getByTestId('signin-toggle')).toBeHidden();
    }
    const login = header.getByTestId('login');
    await expect(login).toBeVisible();
    const admin = header.getByTestId('admin-console');
    await expect(admin).toBeVisible();
    await expect(admin).toHaveAttribute('href', 'https://cams-admin.skylar.technology');
    await expect(admin).toHaveText(/Admin console/);
    // Upper right: the sign-in's right edge near the window's, at the top.
    const box = (await login.boundingBox())!;
    const width = page.viewportSize()!.width;
    expect(box.x + box.width).toBeGreaterThan(width * 0.6);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.y).toBeLessThan(phone ? 400 : 80);
    if (phone) {
      // Escape closes the menu again.
      await page.keyboard.press('Escape');
      await expect(login).toBeHidden();
    }
    // The hero no longer holds a sign-in of its own.
    await expect(page.locator('.hero [data-testid="login-options"]')).toHaveCount(0);
  });

  test('the hero’s sign-in button leads to the header sign-in', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('hero-signin').click();
    await expect(page.getByRole('banner').getByTestId('login')).toBeVisible();
    await expect(page.getByRole('banner').getByTestId('login')).toBeFocused();
  });

  test('each highlight links to the section that explains it, and scrolls there', async ({ page }) => {
    await page.goto('/');
    const cards = page.getByTestId('highlight');
    const n = await cards.count();
    expect(n).toBeGreaterThanOrEqual(6);
    for (let i = 0; i < n; i++) {
      const href = (await cards.nth(i).getAttribute('href'))!;
      expect(href).toMatch(/^#[a-z]+$/);
      await expect(page.locator(href)).toHaveAttribute('data-testid', 'feature-section');
    }
    const last = cards.nth(n - 1);
    const target = page.locator((await last.getAttribute('href'))!);
    await last.click();
    await expect(target.getByRole('heading', { level: 2 })).toBeInViewport();
  });

  test('the ticker names link to their repositories, once for the keyboard, and pause on hover', async ({ page }) => {
    await page.goto('/');
    const names = ['cams', 'cam-proxy', 'cam-sim', 'cams-admin', 'cam-proxy-pi-display'];
    const links = page.getByTestId('ticker-link');
    await expect(links).toHaveCount(5);
    expect(await links.evaluateAll((as) => as.map((a) => a.getAttribute('href')))).toEqual(names.map((n) => `https://github.com/klaushofrichter/${n}`));
    expect(await links.allTextContents()).toEqual(names);
    // The loop's second copy: hidden from screen readers and the Tab key.
    const copies = page.getByTestId('ticker-copy');
    await expect(copies).toHaveCount(5);
    for (const c of await copies.all()) await expect(c).toHaveAttribute('tabindex', '-1');
    expect(await copies.first().evaluate((e) => e.closest('[aria-hidden="true"]') !== null)).toBe(true);
    expect(await links.first().evaluate((e) => e.closest('[aria-hidden="true"]') === null)).toBe(true);
    // Paused on hover and on focus.
    const track = page.getByTestId('ticker-track');
    await page.getByTestId('ticker').hover();
    await expect.poll(() => track.evaluate((e) => getComputedStyle(e).animationPlayState)).toBe('paused');
    await page.mouse.move(0, 0);
    await links.first().focus();
    await expect.poll(() => track.evaluate((e) => getComputedStyle(e).animationPlayState)).toBe('paused');
  });

  test('Find explains the secondary AI analytics and its budget', async ({ page }) => {
    await page.goto('/');
    const find = page.locator('#find');
    await expect(find.getByRole('heading', { level: 3, name: 'Secondary AI analytics' })).toHaveCount(1);
    await expect(find).toContainText('monthly limit');
    await expect(page.getByTestId('highlight').filter({ hasText: 'Works with Reolink' })).toHaveAttribute('href', '#cameras');
  });

  test('links the five open-source repositories', async ({ page }) => {
    await page.goto('/');
    const repos = page.getByTestId('repo-link');
    await expect(repos).toHaveCount(5);
    const hrefs = await repos.evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    expect(hrefs).toEqual(['cams', 'cam-proxy', 'cam-sim', 'cams-admin', 'cam-proxy-pi-display'].map((r) => `https://github.com/klaushofrichter/${r}`));
  });

  test('with reduced motion everything is shown at once and nothing moves', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    // A section far down is fully shown without scrolling to it.
    const maker = page.getByTestId('maker');
    await expect.poll(() => maker.evaluate((e) => getComputedStyle(e).opacity)).toBe('1');
    const anims = await page.evaluate(() =>
      [...document.querySelectorAll('.landing *')].filter((e) => {
        const cs = getComputedStyle(e);
        return cs.animationName !== 'none' && cs.animationIterationCount === 'infinite';
      }).length,
    );
    expect(anims).toBe(0);
  });

  test('without reduced motion, sections reveal as they scroll into view', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('/');
    const maker = page.getByTestId('maker');
    expect(Number(await maker.evaluate((e) => getComputedStyle(e).opacity))).toBeLessThan(1);
    await maker.scrollIntoViewIfNeeded();
    await expect.poll(() => maker.evaluate((e) => getComputedStyle(e).opacity)).toBe('1');
  });

  test('shows the highlights, the feature sections and the maker, in that order', async ({ page }) => {
    await page.goto('/');
    const highlights = page.getByTestId('highlight');
    expect(await highlights.count()).toBeGreaterThanOrEqual(3);
    expect(await highlights.count()).toBeLessThanOrEqual(8);
    await expect(page.getByTestId('highlights')).toContainText('Live');
    const sections = page.getByTestId('feature-section');
    expect(await sections.count()).toBeGreaterThanOrEqual(3);
    for (const s of await sections.all()) {
      await expect(s.getByRole('heading', { level: 2 })).toHaveCount(1);
    }
    const maker = page.getByTestId('maker');
    await expect(maker.getByRole('heading', { level: 2 })).toHaveText('Built by Skylar Technology');
    await expect(maker.getByRole('link', { name: /skylar\.technology/ })).toHaveAttribute('href', 'https://skylar.technology');
    // Hero first, then highlights, sections and the maker, then the footer.
    const tops = await page.evaluate(() =>
      ['main h1', '[data-testid="highlights"]', '[data-testid="feature-section"]', '[data-testid="maker"]', 'footer'].map(
        (s) => document.querySelector(s)!.getBoundingClientRect().top,
      ),
    );
    expect([...tops].sort((a, b) => a - b)).toEqual(tops);
  });

  test('fits the window without a sideways scroll and loads nothing from elsewhere', async ({ page, baseURL }) => {
    const foreign: string[] = [];
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (!['data:', 'blob:'].includes(u.protocol) && u.origin !== new URL(baseURL!).origin) foreign.push(r.url());
    });
    await page.goto('/');
    await page.getByTestId('maker').scrollIntoViewIfNeeded();
    await page.waitForLoadState('networkidle');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    expect(foreign).toEqual([]);
  });

  test('the theme toggle switches the landing page between light and dark', async ({ page }) => {
    await page.goto('/');
    const before = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await page.getByTestId('theme-toggle').click();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe(before);
    await page.reload();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
  });

  // The screenshots (web/public/landing/) stay out of git until Klaus has
  // reviewed them: without the files the page shows no frames at all.
  const WEBP_1PX = Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64');
  async function scrollThrough(page: import('@playwright/test').Page) {
    for (const s of await page.locator('[data-testid="showcase"], [data-testid="feature-section"]').all()) {
      await s.scrollIntoViewIfNeeded();
      await page.waitForTimeout(100);
    }
  }

  test('screenshots show framed, lazy, with alt text when their files exist', async ({ page }) => {
    await page.route('**/landing/*.webp', (r) => r.fulfill({ status: 200, contentType: 'image/webp', body: WEBP_1PX }));
    await page.goto('/');
    await scrollThrough(page);
    const shots = page.getByTestId('shot');
    await expect(shots.first()).toBeVisible();
    expect(await shots.count()).toBeGreaterThanOrEqual(6);
    for (const img of await shots.locator('img').all()) {
      await expect(img).toHaveAttribute('loading', 'lazy');
      expect((await img.getAttribute('alt'))!.length).toBeGreaterThan(20);
    }
  });

  test('a missing screenshot leaves no empty frame or broken image', async ({ page }) => {
    await page.route('**/landing/*.webp', (r) => r.fulfill({ status: 404, body: '' }));
    await page.goto('/');
    await scrollThrough(page);
    await expect(page.getByTestId('shot')).toHaveCount(0);
    await expect(page.getByTestId('showcase')).toBeHidden();
    // The rest of the page is unchanged.
    await expect(page.getByTestId('highlights')).toBeVisible();
    await expect(page.getByTestId('maker')).toBeVisible();
  });

  test('login starts the Google flow', async ({ request }) => {
    const res = await request.get('/auth/google/login', { maxRedirects: 0 });
    expect(res.status()).toBe(302);
    expect(res.headers().location).toContain('https://accounts.google.com/o/oauth2/v2/auth');
    // Always the account chooser, so a logged-out user is never signed back in silently.
    expect(new URL(res.headers().location).searchParams.get('prompt')).toBe('select_account');
  });

  test('has a favicon', async ({ request }) => {
    expect((await request.get('/favicon.svg')).status()).toBe(200);
  });
});

test.describe('auth boundaries', () => {
  test('signed-out app pages go back to the landing page', async ({ page }) => {
    await page.goto('/app/settings');
    await expect(page).toHaveURL('/');
  });

  test('signed-out API calls get 401 JSON', async ({ request }) => {
    const res = await request.get('/api/me');
    expect(res.status()).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  test('signed-in visitors skip the landing page', async ({ page, context, baseURL }) => {
    await signIn(context, baseURL!);
    await page.goto('/');
    await expect(page).toHaveURL('/app/video');
    await expect(page.getByTestId('page-title')).toHaveText('Video');
  });

  test('logout returns to the landing page and locks the app', async ({ page, context, baseURL }, testInfo) => {
    await signIn(context, baseURL!);
    await page.goto('/app/live');
    if (testInfo.project.name === 'phone') {
      await page.getByTestId('hamburger').click();
      await page.getByTestId('drawer').getByTestId('drawer-logout').click();
    } else {
      await page.getByTestId('logout').click();
    }
    await expect(page).toHaveURL('/');
    // Requirement: the authentication cookie is really gone.
    expect((await context.cookies()).map((c) => c.name)).not.toContain('session');
    await page.goto('/app/live');
    await expect(page).toHaveURL('/');
  });
});
