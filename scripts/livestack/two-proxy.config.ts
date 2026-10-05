// Playwright for the two-proxy live stack only (scripts/livestack/
// check-two-proxy.sh; docs/livestack.md, "Two proxies"). No web servers: the
// stack is started by start-two-proxy-stack.sh, and cams' URL comes from its
// run.env. Never part of `npm run test:e2e` (testDir is e2e/ there).
import { defineConfig, devices } from '@playwright/test';
import { runEnv } from './two-proxy-env';

// One id per run (the spec names its archived clips with it), the same in
// every worker.
process.env.TWOPROXY_RUN_ID ??= Date.now().toString(36);

export default defineConfig({
  testDir: '.',
  testMatch: /two-proxy\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 240_000,
  reporter: 'list',
  outputDir: `${process.env.TMPDIR ?? '/tmp'}/cams-livestack-two-proxy-results`,
  use: {
    ...devices['Desktop Chrome'],
    channel: 'chrome',
    viewport: { width: 1440, height: 900 },
    baseURL: runEnv().CAMS_URL,
    timezoneId: 'America/Chicago',
    colorScheme: 'light',
    acceptDownloads: true,
    trace: 'retain-on-failure',
  },
});
