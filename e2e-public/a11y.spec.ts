/**
 * Accessibility of the public pages: WCAG 2.2 A and AA by axe-core with zero
 * violations, in the light and the dark theme, plus the contrast of every
 * visible run of text measured on the real screen pixels (the start page has
 * a gradient hero, gradient buttons, translucent cards over gradients and
 * screenshots, which axe leaves undecided and Lighthouse scores 100).
 */
import { expect } from '@playwright/test';
import { test, audit, expectAllPicturesLoaded, expectReadableText, PUBLIC_PAGES, scrollThrough, useTheme } from './helpers';

for (const theme of ['dark', 'light'] as const) {
  test.describe(`${theme} theme`, () => {
    for (const path of PUBLIC_PAGES) {
      test(`@live ${path} meets WCAG 2.2 AA, contrast measured on the pixels`, async ({ page }) => {
        test.setTimeout(240_000);
        await useTheme(page, theme);
        await page.goto(path);
        await scrollThrough(page);
        await expectAllPicturesLoaded(page);
        await audit(page);
        await expectReadableText(page, `${path} (${theme})`);
      });
    }

    test(`@live the 404 page meets WCAG 2.2 AA (${theme})`, async ({ page }) => {
      await useTheme(page, theme);
      const response = await page.goto('/does-not-exist');
      expect(response?.status()).toBe(404);
      await audit(page);
      await expectReadableText(page, `404 (${theme})`);
    });

    test(`@live the start page's sign-in menu, open on a phone, meets WCAG 2.2 AA (${theme})`, async ({ page, isMobile }) => {
      test.skip(!isMobile, 'the menu is a button below 900 px');
      await useTheme(page, theme);
      await page.goto('/');
      await page.getByTestId('signin-toggle').tap();
      await expect(page.locator('#signin-panel')).toBeVisible();
      await audit(page);
      await expectReadableText(page, `sign-in menu (${theme})`, page.locator('#signin-panel'));
    });
  });
}

test('@live every picture has a text alternative and every link and button a name', async ({ page }) => {
  for (const path of PUBLIC_PAGES) {
    await page.goto(path);
    const missing = await page.evaluate(() => [
      ...Array.from(document.images)
        .filter((i) => i.getAttribute('alt') === null)
        .map((i) => `img ${i.currentSrc || i.src}`),
      ...Array.from(document.querySelectorAll('a, button'))
        .filter((el) => !el.closest('[aria-hidden="true"]'))
        .filter((el) => !(el.getAttribute('aria-label') || (el as HTMLElement).innerText || el.getAttribute('title') || '').trim())
        .map((el) => `${el.tagName.toLowerCase()} ${el.outerHTML.slice(0, 80)}`),
    ]);
    expect(missing, path).toEqual([]);
  }
});
