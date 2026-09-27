import { SIMS, simEnv } from './e2e/sims';
import { defineConfig, devices } from '@playwright/test';
import { E2E_ENV, E2E_PORT } from './e2e/env';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL: `http://localhost:${E2E_PORT}`,
    timezoneId: 'America/Chicago',
    trace: 'retain-on-failure',
    // Pinned so the theme specs have a deterministic starting theme instead
    // of relying on Playwright's implicit default.
    colorScheme: 'light',
  },
  projects: [
    {
      name: 'desktop',
      testIgnore: /live-teardown\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], channel: 'chrome', viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'phone',
      testIgnore: /live-teardown\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], channel: 'chrome', viewport: { width: 390, height: 844 }, hasTouch: true },
    },
    // e2e/live-teardown.spec.ts reads the simulators' shared counters, so it
    // can only run once no other spec file is mid-stream against a simulator.
    // `dependencies` makes Playwright finish every test in `desktop` and
    // `phone` (across all spec files) before this project starts any of its
    // own; `fullyParallel: false` keeps this file from racing itself. See the
    // isolation comment at the top of that file for the full reasoning.
    {
      name: 'live-teardown',
      testMatch: /live-teardown\.spec\.ts/,
      fullyParallel: false,
      dependencies: ['desktop', 'phone'],
      use: { ...devices['Desktop Chrome'], channel: 'chrome', viewport: { width: 1440, height: 900 } },
    },
  ],
  // Requires `npm run build` first. Four cam-sim cameras (e2e/sims.ts) stand
  // in for Reolinks: Den, Porch (rejects SetWhiteLed), Shed (refuses
  // downloads) and Barn (refuses downloads, live always resets);
  // e2e/cameras.json points at them, and "Garage" is deliberately
  // unreachable. Den and Barn have a fake cam-proxy. Playwright merges each
  // `env` with process.env (see
  // playwright/lib/runner/index.js's WebServerPlugin), so PATH is preserved.
  webServer: [
    ...Object.values(SIMS).map((s) => ({ command: 'npx cam-sim', port: s.http, reuseExistingServer: !process.env.CI, env: simEnv(s) })),
    // A fake cam-proxy (Plan 6) for Den (stills, sprites) and Barn (a clip).
    { command: 'npx tsx test/proxy/fakeProxy.ts', port: 8095, reuseExistingServer: !process.env.CI },
    { command: 'npm start', port: E2E_PORT, reuseExistingServer: !process.env.CI, env: E2E_ENV },
  ],
  globalSetup: require.resolve('./e2e/global-setup'),
});
