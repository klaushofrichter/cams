import { test as base } from '@playwright/test';

// The Playwright `test` for specs whose outcome depends on the time of day
// (issue #213). Normally it is Playwright's own. Under
// scripts/e2e-time-of-day.ts (E2E_CLOCK_SHIFT_MS set) every page's `Date` is
// shifted like the Node processes' (e2e/clockShift.cjs), so the browser,
// the servers, the cameras and the spec agree on a "now" at another hour.
const { shiftDate } = require('./clockShift.cjs') as { shiftDate: (offsetMs: number) => void };

export const CLOCK_SHIFT_MS = Number(process.env.E2E_CLOCK_SHIFT_MS ?? 0);

export const test = base.extend({
  context: async ({ context }, use) => {
    if (CLOCK_SHIFT_MS) await context.addInitScript(shiftDate, CLOCK_SHIFT_MS);
    await use(context);
  },
});
export { expect } from '@playwright/test';
