// Shared by the web server Playwright starts and by the specs that sign their
// own session cookie. None of these are real credentials.
import { tmpdir } from 'os';
import { join } from 'path';

export const E2E_PORT = 8099;
// Specs that change preferences sign in as this user: the server keys
// preferences by email, so spec files running in parallel as the first
// allowlisted user never see those changes.
export const PREFS_EMAIL = 'e2e-prefs@klaushofrichter.net';
// The shared event filter's spec (e2e/event-filter.spec.ts) saves it for real:
// a user per project, so desktop and phone don't race on one preference.
export const FILTER_EMAILS = { desktop: 'e2e-filter-desktop@klaushofrichter.net', phone: 'e2e-filter-phone@klaushofrichter.net' } as const;
export const E2E_ENV: Record<string, string> = {
  PORT: String(E2E_PORT),
  COOKIE_SECRET: 'e2e-cookie-secret-not-used-for-anything-real',
  GOOGLE_CLIENT_ID: 'e2e',
  GOOGLE_CLIENT_SECRET: 'e2e',
  GOOGLE_REDIRECT_URI: `http://localhost:${E2E_PORT}/auth/google/callback`,
  ALLOWED_EMAILS: `klaus@klaushofrichter.net,${PREFS_EMAIL},${FILTER_EMAILS.desktop},${FILTER_EMAILS.phone}`,
  CAMERAS_FILE: 'e2e/cameras.json',
  PREFS_FILE: '/tmp/cams-e2e-prefs.json',
  PROXY_STATE_FILE: '/tmp/cams-e2e-proxy-state.json',
  // The run's own clip and thumbnail cache, emptied whenever Playwright starts
  // the server (playwright.config.ts). The default ($TMPDIR/cams-cache) is
  // shared with every earlier run and local server: a thumbnail cached there
  // by older code (a clip frame for today's 12:05:05 motion card, with no
  // still 2 s in) was served to later runs of the same day (issue #157 e2e).
  CACHE_DIR: join(tmpdir(), 'cams-e2e-cache'),
  APP_VERSION: 'e2e-test-version',
  LOG_LEVEL: 'silent',
  RATE_LIMIT_MAX: '1000',
  RATE_LIMIT_API_MAX: '10000',
  RATE_LIMIT_MEDIA_MAX: '10000',
  RATE_LIMIT_IMAGE_MAX: '50000',
  RATE_LIMIT_CHECKS_PER_MIN: '1000',
  RATE_LIMIT_CHECKS_PER_DAY: '10000',
  RATE_LIMIT_ARCHIVE_PER_MIN: '1000',
  RATE_LIMIT_ARCHIVE_ZIP_PER_MIN: '1000',
};

// A second cams server for the token login (spec 2026-10-04-pi-deployment-
// design): the Pi demo kit's configuration, a login token and no Google,
// cookies without Secure. Its own preferences, proxy state and cache, so it
// never disturbs the main server's specs. e2e/token-login.spec.ts.
export const E2E_TOKEN_PORT = 8087;
export const E2E_LOGIN_TOKEN = 'e2e-login-token-not-a-secret-0000000';
export const E2E_TOKEN_ENV: Record<string, string> = {
  ...Object.fromEntries(Object.entries(E2E_ENV).filter(([k]) => !k.startsWith('GOOGLE_') && k !== 'ALLOWED_EMAILS')),
  PORT: String(E2E_TOKEN_PORT),
  CAMS_LOGIN_TOKEN: E2E_LOGIN_TOKEN,
  COOKIE_SECURE: 'false',
  PREFS_FILE: '/tmp/cams-e2e-token-prefs.json',
  PROXY_STATE_FILE: '/tmp/cams-e2e-token-proxy-state.json',
  CACHE_DIR: join(tmpdir(), 'cams-e2e-token-cache'),
};

// The cam-proxy release the e2e runs for Silo and Loft (e2e/realProxy.ts):
// the first with several cameras on one host (multi-camera P1+P2, the
// `sse-cam-list` stream filter), or later. Bump both with cam-proxy releases: the
// digest is the image index's (`docker buildx imagetools inspect <image>:<tag>`),
// so a moved or replaced tag can't change what the e2e runs.
export const CAM_PROXY_TAG = 'v2026.10.05.7';
export const CAM_PROXY_DIGEST = 'sha256:54b2fddc82e899716b328bdb536906235261a544a50eff905a7cc655baa67c7e';
export const CAM_PROXY_IMAGE = `ghcr.io/klaushofrichter/cam-proxy:${CAM_PROXY_TAG}@${CAM_PROXY_DIGEST}`;

// The real cam-proxy for Silo and Loft (e2e/realProxy.ts). Test-only tokens. It runs
// on GitHub Actions (an ephemeral runner), or with CAMS_E2E_REAL_PROXY=1, and
// only on Linux (host networking: it listens on every interface, so never on
// a laptop on the home LAN). A plain CI=true doesn't turn it on, and
// CAMS_E2E_REAL_PROXY=0 turns it off (scripts/e2e-time-of-day.ts: the
// container's clock can't be shifted).
export const REAL_PROXY = {
  port: 8091,
  go2rtcRtsp: 8092,
  go2rtcApi: 8089,
  token: 'e2e-real-proxy-token-not-a-secret-000000',
  adminToken: 'e2e-real-proxy-admin-not-a-secret-000000',
};
export function realProxyOn(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): boolean {
  if (env.CAMS_E2E_REAL_PROXY === '0') return false;
  return (env.GITHUB_ACTIONS === 'true' || env.CAMS_E2E_REAL_PROXY === '1') && platform === 'linux';
}
export const REAL_PROXY_ON = realProxyOn();

// Migration P4: a third cams server in cams-admin mode (CONFIG_SOURCE=
// cams-admin), configured by the fake cams-admin (e2e/fakeAdmin.ts, from
// test/admin/fakeAdmin.ts) with two accounts that both have a camera "cam1":
// "home" (Den, through the fake cam-proxy) and "beta" (Porch, direct).
// e2e/accounts.spec.ts, viewer.spec.ts, held.spec.ts, offline-start.spec.ts.
export const E2E_ADMIN_PORT = 8085;
export const FAKE_ADMIN_PORT = 8084;
export const FAKE_ADMIN_HOOKS = 8082;
export const E2E_ADMIN_DATA = join(tmpdir(), 'cams-e2e-admin');
export const E2E_ADMIN_ENV: Record<string, string> = {
  ...Object.fromEntries(Object.entries(E2E_ENV).filter(([k]) => k !== 'ALLOWED_EMAILS')),
  PORT: String(E2E_ADMIN_PORT),
  GOOGLE_REDIRECT_URI: `http://localhost:${E2E_ADMIN_PORT}/auth/google/callback`,
  CONFIG_SOURCE: 'cams-admin',
  CAMS_DATA_DIR: E2E_ADMIN_DATA,
  CAMS_ADMIN_PULL_MS: '1000',
  CAMERAS_FILE: 'e2e/admin-cameras.json',
  CAMERA_CREDENTIALS_FILE: join(E2E_ADMIN_DATA, 'credentials.json'),
  PREFS_FILE: join(E2E_ADMIN_DATA, 'prefs.json'),
  PROXY_STATE_FILE: join(E2E_ADMIN_DATA, 'proxy-state.json'),
  CACHE_DIR: join(tmpdir(), 'cams-e2e-admin-cache'),
};
export const ADMIN_USERS = { both: 'both@e2e.example', alpha: 'alpha@e2e.example' } as const;
