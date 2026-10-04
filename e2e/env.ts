// Shared by the web server Playwright starts and by the specs that sign their
// own session cookie. None of these are real credentials.
import { tmpdir } from 'os';
import { join } from 'path';

export const E2E_PORT = 8099;
// Specs that change preferences sign in as this user: the server keys
// preferences by email, so spec files running in parallel as the first
// allowlisted user never see those changes.
export const PREFS_EMAIL = 'e2e-prefs@klaushofrichter.net';
export const E2E_ENV: Record<string, string> = {
  PORT: String(E2E_PORT),
  COOKIE_SECRET: 'e2e-cookie-secret-not-used-for-anything-real',
  GOOGLE_CLIENT_ID: 'e2e',
  GOOGLE_CLIENT_SECRET: 'e2e',
  GOOGLE_REDIRECT_URI: `http://localhost:${E2E_PORT}/auth/google/callback`,
  ALLOWED_EMAILS: `klaus@klaushofrichter.net,${PREFS_EMAIL}`,
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
};

// The cam-proxy release the e2e runs for Silo (e2e/realProxy.ts): the first
// with the recordings API, or later. Bump both with cam-proxy releases: the
// digest is the image index's (`docker buildx imagetools inspect <image>:<tag>`),
// so a moved or replaced tag can't change what the e2e runs.
export const CAM_PROXY_TAG = 'v2026.10.02.4';
export const CAM_PROXY_DIGEST = 'sha256:33f595fe1991d430855d172e9e75e4d79be53e3f1a7cef1f1fa5b04ce8aeb5ec';
export const CAM_PROXY_IMAGE = `ghcr.io/klaushofrichter/cam-proxy:${CAM_PROXY_TAG}@${CAM_PROXY_DIGEST}`;

// The real cam-proxy for Silo (e2e/realProxy.ts). Test-only tokens. It runs
// on GitHub Actions (an ephemeral runner), or with CAMS_E2E_REAL_PROXY=1, and
// only on Linux (host networking: it listens on every interface, so never on
// a laptop on the home LAN). A plain CI=true doesn't turn it on.
export const REAL_PROXY = {
  port: 8091,
  go2rtcRtsp: 8092,
  go2rtcApi: 8089,
  token: 'e2e-real-proxy-token-not-a-secret-000000',
  adminToken: 'e2e-real-proxy-admin-not-a-secret-000000',
};
export function realProxyOn(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): boolean {
  return (env.GITHUB_ACTIONS === 'true' || env.CAMS_E2E_REAL_PROXY === '1') && platform === 'linux';
}
export const REAL_PROXY_ON = realProxyOn();
