import { defineConfig, devices } from '@playwright/test';

/**
 * The PUBLIC pages, signed out: the start page (/), the sign-in pages
 * (/signin, /token) and the 404 page, in the four browsers a visitor arrives
 * on. kube-setup's "public web pages" baseline
 * (docs/cluster-deployment-requirements.md §4), adapted from
 * klaushofrichter/www-skylar-technology and www-klaushofrichter. The signed-in
 * app is the other suite's (playwright.config.ts) and is out of scope here.
 *
 * Where it points:
 *  - nothing set: Playwright starts the BUILT server (`npm run build` first)
 *    on PUBLIC_PORT with the env below and stops it afterwards;
 *  - BASE_URL=http://localhost:8080: a server somebody else started, in
 *    production-checks.yml the Docker image this commit builds;
 *  - BASE_URL=https://cams.skylar.technology with --grep @live: production,
 *    after a release and daily (live-check.yml). Tests tagged @live only GET
 *    and never sign in.
 */
const BASE_URL = process.env.BASE_URL;
const LIVE = BASE_URL?.startsWith('https://');
export const PUBLIC_PORT = 8071;

// A Chromium outside Playwright's cache, for machines that have one. Unset in
// CI, which installs its own browsers.
const chromiumLaunch = process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {};

export default defineConfig({
  testDir: './e2e-public',
  fullyParallel: true,
  // One retry absorbs a runner hiccup, but a test that needed it fails the
  // run anyway (failOnFlakyTests): in christina.art a "passed on retry" in
  // Firefox and WebKit was a real layout bug, not noise.
  retries: process.env.CI ? 1 : 0,
  failOnFlakyTests: !!process.env.CI,
  forbidOnly: !!process.env.CI,
  timeout: LIVE ? 120_000 : 90_000,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-public' }]] : 'list',
  outputDir: 'test-results-public',
  use: {
    baseURL: BASE_URL || `http://localhost:${PUBLIC_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // Desktop Chrome, an Android phone, an iPhone (WebKit, Safari's engine) and
  // desktop Firefox. Nothing here changes server data, so every test runs in
  // all four.
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'], launchOptions: chromiumLaunch } },
    { name: 'phone-chromium', use: { ...devices['Pixel 7'], launchOptions: chromiumLaunch } },
    { name: 'phone-webkit', use: { ...devices['iPhone 13'] } },
    { name: 'desktop-firefox', use: { ...devices['Desktop Firefox'] } },
  ],
  webServer: BASE_URL
    ? undefined
    : {
        command: 'npm start',
        url: `http://localhost:${PUBLIC_PORT}/health`,
        reuseExistingServer: !process.env.CI,
        // The cloud's sign-in (Google), no cameras: what a signed-out visitor
        // sees does not depend on them. None of these are real credentials.
        env: {
          PORT: String(PUBLIC_PORT),
          COOKIE_SECRET: 'e2e-public-cookie-secret-not-used-for-anything',
          GOOGLE_CLIENT_ID: 'e2e',
          GOOGLE_CLIENT_SECRET: 'e2e',
          GOOGLE_REDIRECT_URI: `http://localhost:${PUBLIC_PORT}/auth/google/callback`,
          ALLOWED_EMAILS: 'nobody@e2e.example',
          PREFS_FILE: '/tmp/cams-e2e-public-prefs.json',
          PROXY_STATE_FILE: '/tmp/cams-e2e-public-proxy-state.json',
          PROXY_FEATURES_FILE: '/tmp/cams-e2e-public-proxy-features.json',
          CACHE_DIR: '/tmp/cams-e2e-public-cache',
          APP_VERSION: process.env.EXPECT_VERSION ?? 'e2e-public',
          LOG_LEVEL: 'silent',
        },
      },
});
