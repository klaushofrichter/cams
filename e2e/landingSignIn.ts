import type { Page } from '@playwright/test';

// The start page's sign-in sits in the header; on a phone it is behind the
// header's "Sign in" button. Opens it there, and does nothing on a desktop.
export async function openSignIn(page: Page): Promise<void> {
  // The header first: right after a navigation it may not be drawn yet, and
  // isVisible doesn't wait (the phone then stayed behind its button).
  const toggle = page.getByTestId('signin-toggle');
  await toggle.waitFor({ state: 'attached' });
  if ((await toggle.isVisible()) && (await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
}
