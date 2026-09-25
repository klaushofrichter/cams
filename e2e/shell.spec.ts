import { expect, test } from '@playwright/test';
import { signIn } from './session';

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL!);
});

test('top bar shows the version linking to GitHub and the camera picker', async ({ page }) => {
  await page.goto('/app/live');
  const version = page.getByTestId('version-link');
  await expect(version).toHaveText('e2e-test-version');
  await expect(version).toHaveAttribute('href', 'https://github.com/klaushofrichter/cams');
  await expect(page.getByTestId('camera-picker')).toHaveValue('cam1');
  await expect(page.getByTestId('camera-picker').locator('option')).toHaveText(['Den']);
});

test('theme toggle switches colours and scrollbars, and persists', async ({ page }, testInfo) => {
  await page.goto('/app/live');
  const read = () =>
    page.evaluate(() => ({
      theme: document.documentElement.dataset.theme ?? null,
      bg: getComputedStyle(document.body).backgroundColor,
      scrollbar: getComputedStyle(document.documentElement).scrollbarColor,
    }));
  const before = await read();
  // before.theme is null until the app's own onMount runs (no data-theme
  // attribute set yet), so derive the actually-rendered starting theme from
  // the same signal the app itself uses (prefers-color-scheme), rather than
  // hard-coding an assumption about it. playwright.config.ts pins
  // colorScheme to 'light', so this normally resolves to 'light', but
  // deriving it keeps the assertion honest about what it depends on.
  const startTheme =
    before.theme ?? (await page.evaluate(() => (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')));
  const expectedTheme = startTheme === 'dark' ? 'light' : 'dark';
  if (testInfo.project.name === 'phone') {
    await page.getByTestId('hamburger').click();
    await page.getByTestId('drawer').getByTestId('theme-toggle').click();
  } else {
    await page.getByTestId('theme-toggle').click();
  }
  // The toggle flips away from the starting theme, whatever it was.
  await expect.poll(async () => (await read()).theme).toBe(expectedTheme);
  // body background-color has a 0.25s CSS transition (theme.css), so read it
  // via expect.poll too instead of racing the transition right after the
  // dataset attribute flips.
  await expect.poll(async () => (await read()).bg).not.toBe(before.bg);
  const after = await read();
  expect(after.scrollbar).not.toBe(before.scrollbar);
  await page.reload();
  expect((await read()).theme).toBe(expectedTheme);
});

test('navigation reaches every page and keeps the URL in sync', async ({ page }, testInfo) => {
  await page.goto('/app/live');
  const open = async (id: string) => {
    if (testInfo.project.name === 'phone') {
      await page.getByTestId('hamburger').click();
      await page.getByTestId('drawer').getByTestId(`nav-${id}`).click();
      await expect(page.getByTestId('drawer')).toBeHidden();
    } else {
      await page.getByTestId('sidebar').getByTestId(`nav-${id}`).click();
    }
  };
  const cases: [string, string, string][] = [
    ['history', '/app/recordings?panel=history', 'Recordings'],
    ['events', '/app/recordings?panel=events', 'Recordings'],
    ['downloads', '/app/recordings?panel=downloads', 'Recordings'],
    ['settings', '/app/settings', 'Settings'],
    ['about', '/app/about', 'About'],
    ['live', '/app/live', 'Live'],
  ];
  for (const [id, url, title] of cases) {
    await open(id);
    await expect(page).toHaveURL(url);
    await expect(page.getByTestId('page-title')).toHaveText(title);
  }
  await page.goBack();
  await expect(page).toHaveURL('/app/about');
  await expect(page.getByTestId('page-title')).toHaveText('About');
});

test('recordings panel tabs switch the panel', async ({ page }) => {
  await page.goto('/app/recordings?panel=events');
  await expect(page.getByTestId('panel-tab-events')).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('panel-tab-downloads').click();
  await expect(page).toHaveURL('/app/recordings?panel=downloads');
});

test('unknown app paths show the Live page', async ({ page }) => {
  await page.goto('/app/does-not-exist');
  await expect(page.getByTestId('page-title')).toHaveText('Live');
});

test('about page shows the version', async ({ page }) => {
  await page.goto('/app/about');
  await expect(page.getByTestId('about-version')).toHaveText('e2e-test-version');
});

test.describe('desktop sidebar', () => {
  // test.skip's callback receives fixtures only, not testInfo; the current
  // project is read via test.info() instead.
  test.skip(() => test.info().project.name !== 'desktop', 'desktop only');

  test('collapses to an icon column, remembers it, and expands again', async ({ page }) => {
    await page.goto('/app/live');
    const sidebar = page.getByTestId('sidebar');
    await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(220);
    await page.getByTestId('sidebar-toggle').click();
    await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(64);
    await page.reload();
    await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(64);
    await page.getByTestId('sidebar-toggle').click();
    await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(220);
  });

  test('hamburger is hidden', async ({ page }) => {
    await page.goto('/app/live');
    await expect(page.getByTestId('hamburger')).toBeHidden();
  });
});

test.describe('phone layout', () => {
  test.skip(() => test.info().project.name !== 'phone', 'phone only');

  test('uses a hamburger drawer instead of the sidebar', async ({ page }) => {
    await page.goto('/app/live');
    await expect(page.getByTestId('sidebar')).toBeHidden();
    await page.getByTestId('hamburger').click();
    await expect(page.getByTestId('drawer')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('drawer')).toBeHidden();
  });

  test('has no horizontal page scroll', async ({ page }) => {
    await page.goto('/app/live');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
