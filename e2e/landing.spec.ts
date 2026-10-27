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

  test('two equal sign-in buttons sit in the header, upper right: Admin console and Cams app', async ({ page }, info) => {
    await page.goto('/');
    const header = page.getByRole('banner');
    const phone = info.project.name === 'phone';
    if (phone) {
      // One "Sign in" button opens both.
      await expect(header.getByTestId('login')).toBeHidden();
      await expect(header.getByTestId('signin-toggle')).toBeVisible();
      await header.getByTestId('signin-toggle').click();
      await expect(header.getByTestId('signin-toggle')).toHaveAttribute('aria-expanded', 'true');
    } else {
      await expect(page.getByTestId('signin-toggle')).toBeHidden();
    }
    // Google is configured here: the Cams app button is the Google sign-in.
    const cams = header.getByTestId('login');
    await expect(cams).toBeVisible();
    await expect(cams).toHaveText(/Cams app/);
    await expect(cams).toHaveAttribute('href', '/auth/google/login');
    const admin = header.getByTestId('admin-console');
    await expect(admin).toBeVisible();
    await expect(admin).toHaveText(/Admin console/);
    await expect(admin).toHaveAttribute('href', 'https://cams-admin.skylar.technology');
    // Equal weight: the same size and look.
    const [a, c] = [(await admin.boundingBox())!, (await cams.boundingBox())!];
    expect(Math.abs(a.height - c.height)).toBeLessThanOrEqual(1);
    const look = (el: typeof cams) => el.evaluate((e) => { const cs = getComputedStyle(e); return [cs.backgroundColor, cs.color, cs.fontSize, cs.fontWeight, cs.borderRadius].join(' '); });
    expect(await look(admin)).toBe(await look(cams));
    // Upper right.
    const width = page.viewportSize()!.width;
    expect(c.x + c.width).toBeGreaterThan(width * 0.6);
    expect(c.x + c.width).toBeLessThanOrEqual(width);
    expect(c.y).toBeLessThan(phone ? 400 : 80);
    if (phone) {
      await page.keyboard.press('Escape');
      await expect(cams).toBeHidden();
    }
    // No sign-in form on the start page: no token field, no token sign-in.
    await expect(page.getByTestId('login-options')).toHaveCount(0);
    await expect(page.getByTestId('token-input')).toHaveCount(0);
    await expect(page.getByText('Sign in with token')).toHaveCount(0);
  });

  test('the sign-in page offers Google here, and comes back to the start page', async ({ page }) => {
    await page.goto('/signin');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Sign in');
    await expect(page.getByTestId('login')).toHaveAttribute('href', '/auth/google/login');
    await expect(page.getByTestId('token-form')).toHaveCount(0);
    await page.getByTestId('signin-home').click();
    await expect(page).toHaveURL('/');
  });

  test('the hero has one call to action and no sign-in of its own', async ({ page }) => {
    await page.goto('/');
    const hero = page.locator('section.hero');
    await expect(page.getByTestId('hero-signin')).toHaveCount(0);
    await expect(hero.getByRole('button')).toHaveCount(0);
    await expect(hero.getByRole('link', { name: /See what it does/ })).toHaveAttribute('href', '#highlights');
    await expect(hero.getByText('Sign in', { exact: true })).toHaveCount(0);
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

  test('a demo sash sits in the top right corner: a label, not a link, never in the way', async ({ page }) => {
    await page.goto('/');
    const sash = page.getByRole('note', { name: /demo/i });
    await expect(sash).toBeVisible();
    await expect(sash).toHaveAttribute('data-testid', 'demo-sash');
    await expect(sash).toContainText('DEMO');
    await expect(sash.locator('a')).toHaveCount(0);
    const style = await sash.evaluate((e) => { const cs = getComputedStyle(e); return { position: cs.position, top: cs.top, right: cs.right, pointerEvents: cs.pointerEvents }; });
    expect(style).toEqual({ position: 'fixed', top: '0px', right: '0px', pointerEvents: 'none' });
    // It stays in the corner while the page scrolls.
    await page.getByTestId('maker').scrollIntoViewIfNeeded();
    await expect(sash).toBeInViewport();
    // Only on the start page: not on the sign-in page.
    await page.goto('/signin');
    await expect(page.getByTestId('demo-sash')).toHaveCount(0);
  });

  test('the Open section points your AI at /llms.txt', async ({ page }) => {
    await page.goto('/');
    const link = page.locator('#open').getByTestId('llms-link');
    await expect(link).toHaveAttribute('href', '/llms.txt');
    await expect(link).toContainText('llms.txt');
    await expect(page.locator('#open')).toContainText('every API and its documentation in one list');
  });

  test('the Open section shows the MCP card with its command, a copy button and the README link', async ({ page, context }, info) => {
    await page.goto('/');
    const open = page.locator('#open');
    await expect(open.getByRole('heading', { level: 3, name: 'Connect your AI assistant' })).toHaveCount(1);
    const cmd = open.getByTestId('mcp-command');
    await expect(cmd).toHaveText('claude mcp add --transport http cams https://cams.skylar.technology/mcp --header "Authorization: Bearer cmcp_<your token>"');
    await expect(open.getByTestId('mcp-docs')).toHaveAttribute('href', 'https://github.com/klaushofrichter/cams#mcp-server');
    if (info.project.name === 'desktop') {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await open.getByTestId('mcp-copy').click();
      await expect(open.getByTestId('mcp-copy')).toHaveText('Copied');
      expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('claude mcp add');
    }
  });

  for (const path of ['/', '/signin']) {
    test(`links on ${path} that leave the site open in a new tab, same-site links do not`, async ({ page, baseURL }) => {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      const links = await page.locator('a[href]').evaluateAll((as) =>
        as.map((a) => ({ href: (a as HTMLAnchorElement).href, target: a.getAttribute('target'), rel: a.getAttribute('rel') ?? '', hint: a.getAttribute('aria-describedby') })),
      );
      const origin = new URL(baseURL!).origin;
      const external = links.filter((l) => /^https?:/.test(l.href) && new URL(l.href).origin !== origin);
      const internal = links.filter((l) => !external.includes(l));
      expect(external.length).toBeGreaterThan(path === '/' ? 10 : 0);
      for (const l of external) {
        expect(l.target, l.href).toBe('_blank');
        expect(l.rel, l.href).toContain('noopener');
        expect(l.rel, l.href).toContain('noreferrer');
        // The accessible hint: "opens in a new tab".
        expect(l.hint, l.href).toBeTruthy();
        expect(await page.locator(`#${l.hint}`).textContent()).toMatch(/opens in a new tab/i);
      }
      for (const l of internal) expect(l.target, l.href).not.toBe('_blank');
      if (path === '/') expect(internal.map((l) => new URL(l.href).pathname)).toEqual(expect.arrayContaining(['/llms.txt', '/auth/google/login']));
    });
  }

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

  test('the e-paper display softly crossfades its four pages, on a white paper, never a dark flash', async ({ page }) => {
    await page.route('**/landing/*.webp', (r) => r.fulfill({ status: 200, contentType: 'image/webp', body: WEBP_1PX }));
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('/');
    const cycle = page.locator('#hardware').getByTestId('epaper-cycle');
    await cycle.scrollIntoViewIfNeeded();
    const pages = cycle.getByTestId('epaper-page');
    await expect(pages).toHaveCount(4);
    expect(await pages.evaluateAll((ims) => ims.map((i) => i.getAttribute('alt')!.split(':')[0]))).toEqual([
      'The e-paper display’s Overview page',
      'The e-paper display’s Camera page',
      'The e-paper display’s Proxy page',
      'The e-paper display’s Pi page',
    ]);
    const anim = await pages.evaluateAll((ims) => ims.map((i) => { const cs = getComputedStyle(i); return [cs.animationDuration, cs.animationDelay, cs.animationIterationCount, cs.animationTimingFunction]; }));
    // A soft fade: 0.7 s ease-in-out, each page held 2 s (2.7 s a page, 10.8 s a cycle).
    expect(anim).toEqual(['0s', '2.7s', '5.4s', '8.1s'].map((d) => ['10.8s', d, 'infinite', 'ease-in-out']));
    // No flash: no flash layer, no flash keyframes, and white paper behind the stack.
    await expect(cycle.getByTestId('epaper-flash')).toHaveCount(0);
    const keyframes = await page.evaluate(() =>
      [...document.styleSheets].flatMap((sh) => [...sh.cssRules]).filter((r) => r instanceof CSSKeyframesRule).map((r) => (r as CSSKeyframesRule).name),
    );
    expect(keyframes.some((n) => /flash/i.test(n))).toBe(false);
    expect(await cycle.getByTestId('epaper-screen').evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(255, 255, 255)');
  });

  test('under reduced motion the four e-paper pages stand side by side, still', async ({ page }) => {
    await page.route('**/landing/*.webp', (r) => r.fulfill({ status: 200, contentType: 'image/webp', body: WEBP_1PX }));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    const pages = page.getByTestId('epaper-page');
    await expect(pages).toHaveCount(4);
    for (const p of await pages.all()) {
      await expect(p).toBeVisible();
      expect(await p.evaluate((e) => [getComputedStyle(e).animationName, getComputedStyle(e).opacity])).toEqual(['none', '1']);
    }
  });

  test('a missing screenshot leaves no empty frame or broken image', async ({ page }) => {
    await page.route('**/landing/*.webp', (r) => r.fulfill({ status: 404, body: '' }));
    await page.goto('/');
    await scrollThrough(page);
    await expect(page.getByTestId('shot')).toHaveCount(0);
    await expect(page.getByTestId('showcase')).toBeHidden();
    await expect(page.getByTestId('epaper-cycle')).toHaveCount(0);
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
