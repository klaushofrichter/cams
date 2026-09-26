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
    // e2e/live-teardown.spec.ts reads the mock camera's shared /__state, so it
    // can only run once no other spec file is mid-stream against the mock.
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
  // Requires `npm run build` first. The mock camera stands in for the Reolink
  // (e2e/cameras.json points "Den" at it); "Garage" is deliberately unreachable.
  // A second mock on 8097 backs "Porch" and always rejects SetWhiteLed, so
  // settings.spec.ts can exercise a partial save without making cam1/Den's
  // mock (which live.spec.ts and live-teardown.spec.ts depend on) unreliable.
  // Playwright merges each `env` with process.env (see
  // playwright/lib/runner/index.js's WebServerPlugin), so PATH is preserved
  // even though these entries only list the variables they add.
  webServer: [
    { command: 'npx tsx test/mock-camera/cli.ts', port: 8098, reuseExistingServer: !process.env.CI },
    { command: 'npx tsx test/mock-camera/cli.ts', port: 8097, reuseExistingServer: !process.env.CI, env: { MOCK_CAMERA_PORT: '8097', MOCK_SETTINGS_FAILURES: 'SetWhiteLed' } },
    { command: 'npm start', port: E2E_PORT, reuseExistingServer: !process.env.CI, env: E2E_ENV },
  ],
  globalSetup: require.resolve('./e2e/global-setup'),
});
