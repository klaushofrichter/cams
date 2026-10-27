import { expect, test } from '@playwright/test';
import { signIn } from './session';

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

  test('shows the highlights, the feature sections and the maker, in that order', async ({ page }) => {
    await page.goto('/');
    const highlights = page.getByTestId('highlights').getByRole('listitem');
    expect(await highlights.count()).toBeGreaterThanOrEqual(3);
    expect(await highlights.count()).toBeLessThanOrEqual(6);
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
