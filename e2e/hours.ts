import { expect, type Page } from '@playwright/test';

// Since stage 2 of the Video page (spec 2026-10-04), landing on a spot
// collapses the hours more than 6 h away, which depends on the time of day
// the test runs. Specs that need every card open all hours first, as a user
// would: "Collapse hours", then "Expand hours".
export async function expandAllHours(page: Page): Promise<void> {
  const btn = page.getByTestId('hours-toggle');
  await expect(page.getByTestId('hour-group').first()).toBeVisible();
  if ((await btn.textContent())?.includes('Collapse')) {
    await btn.click();
    await expect(btn).toHaveText('Expand hours');
  }
  await btn.click();
  await expect(btn).toHaveText('Collapse hours');
}

// The day's listed events, collapsed hours included (their titles count them).
export async function eventCount(page: Page): Promise<number> {
  const counts = await page.getByTestId('hour-count').allTextContents();
  return counts.reduce((n, t) => n + Number(/\d+/.exec(t)?.[0] ?? 0), 0);
}
