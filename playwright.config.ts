import { SIMS, simEnv } from './e2e/sims';
import { defineConfig, devices } from '@playwright/test';
import { E2E_ENV, E2E_PORT, E2E_TOKEN_ENV, E2E_TOKEN_PORT, REAL_PROXY, REAL_PROXY_ON } from './e2e/env';

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
      testIgnore: /live-teardown\.spec\.ts|camera-name\.spec\.ts|token-login\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], channel: 'chrome', viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'phone',
      testIgnore: /live-teardown\.spec\.ts|camera-name\.spec\.ts|token-login\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], channel: 'chrome', viewport: { width: 390, height: 844 }, hasTouch: true },
    },
    // e2e/token-login.spec.ts: the second server (E2E_TOKEN_ENV, the Pi's
    // token-only sign-in), at both sizes.
    {
      name: 'token-desktop',
      testMatch: /token-login\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], channel: 'chrome', viewport: { width: 1440, height: 900 }, baseURL: `http://localhost:${E2E_TOKEN_PORT}` },
    },
    {
      name: 'token-phone',
      testMatch: /token-login\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], channel: 'chrome', viewport: { width: 390, height: 844 }, hasTouch: true, baseURL: `http://localhost:${E2E_TOKEN_PORT}` },
    },
    // e2e/camera-name.spec.ts renames Den, whose name the other specs check:
    // after them, one size at a time.
    {
      name: 'camera-name-desktop',
      testMatch: /camera-name\.spec\.ts/,
      dependencies: ['desktop', 'phone'],
      use: { ...devices['Desktop Chrome'], channel: 'chrome', viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'camera-name-phone',
      testMatch: /camera-name\.spec\.ts/,
      dependencies: ['camera-name-desktop'],
      use: { ...devices['Desktop Chrome'], channel: 'chrome', viewport: { width: 390, height: 844 }, hasTouch: true },
    },
    // e2e/live-teardown.spec.ts reads the simulators' shared counters, so it
    // can only run once no other spec file is mid-stream against a simulator.
    // `dependencies` makes Playwright finish every test in `desktop`, `phone`
    // and the camera-name projects (across all spec files) before this project starts any of its
    // own; `fullyParallel: false` keeps this file from racing itself. See the
    // isolation comment at the top of that file for the full reasoning.
    {
      name: 'live-teardown',
      testMatch: /live-teardown\.spec\.ts/,
      fullyParallel: false,
      dependencies: ['desktop', 'phone', 'camera-name-phone', 'token-desktop', 'token-phone'],
      use: { ...devices['Desktop Chrome'], channel: 'chrome', viewport: { width: 1440, height: 900 } },
    },
  ],
  // Requires `npm run build` first. Six cam-sim cameras (e2e/sims.ts) stand
  // in for Reolinks: Den, Porch (rejects SetWhiteLed), Shed (refuses
  // downloads), Barn (refuses downloads, live always resets), and Silo and
  // Loft (refuse HTTP downloads; one real cam-proxy serves both and fetches
  // over Baichuan);
  // e2e/cameras.json points at them, and "Garage" is deliberately
  // unreachable. Den and Barn have the fake cam-proxy; Silo and Loft the real one, in
  // GitHub Actions only (e2e/realProxy.ts). Playwright merges each
  // `env` with process.env (see
  // playwright/lib/runner/index.js's WebServerPlugin), so PATH is preserved.
  webServer: [
    ...Object.values(SIMS).map((s) => ({ command: 'npx cam-sim', port: s.http, reuseExistingServer: !process.env.CI, env: simEnv(s) })),
    // A fake cam-proxy (Plan 6) for Den (stills, sprites) and Barn (a clip).
    { command: 'npx tsx test/proxy/fakeProxy.ts', port: 8095, reuseExistingServer: !process.env.CI },
    // The real cam-proxy for Silo and Loft (released image; GitHub Actions or an opt-in, Linux only: e2e/env.ts).
    // The first run pulls the image. Its log (warn and up) shows in the
    // output; SIGTERM lets e2e/realProxy.ts stop the container.
    ...(REAL_PROXY_ON ? [{ command: 'npx tsx e2e/realProxy.ts', url: `http://127.0.0.1:${REAL_PROXY.port}/health`, timeout: 300_000, reuseExistingServer: false, stdout: 'pipe' as const, gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 10_000 } }] : []),
    // Each start begins with an empty cache (E2E_ENV.CACHE_DIR): cached thumbnails
    // and clips never carry over from an earlier run. Not in globalSetup, which
    // runs after the web servers have started.
    { command: `node -e "require('fs').rmSync(process.env.CACHE_DIR, { recursive: true, force: true })" && npm start`, port: E2E_PORT, reuseExistingServer: !process.env.CI, env: E2E_ENV },
    // The token-login server (the Pi demo kit's configuration).
    { command: `node -e "require('fs').rmSync(process.env.CACHE_DIR, { recursive: true, force: true })" && npm start`, port: E2E_TOKEN_PORT, reuseExistingServer: !process.env.CI, env: E2E_TOKEN_ENV },
  ],
  globalSetup: require.resolve('./e2e/global-setup'),
});
