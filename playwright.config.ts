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
    { name: 'desktop', use: { ...devices['Desktop Chrome'], channel: 'chrome', viewport: { width: 1440, height: 900 } } },
    { name: 'phone', use: { ...devices['Desktop Chrome'], channel: 'chrome', viewport: { width: 390, height: 844 }, hasTouch: true } },
  ],
  // Requires `npm run build` first. The mock camera stands in for the Reolink
  // (e2e/cameras.json points "Den" at it); "Garage" is deliberately unreachable.
  webServer: [
    { command: 'npx tsx test/mock-camera/cli.ts', port: 8098, reuseExistingServer: !process.env.CI },
    { command: 'npm start', port: E2E_PORT, reuseExistingServer: !process.env.CI, env: E2E_ENV },
  ],
});
