// Shared by the web server Playwright starts and by the specs that sign their
// own session cookie. None of these are real credentials.
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
  APP_VERSION: 'e2e-test-version',
  LOG_LEVEL: 'silent',
  RATE_LIMIT_MAX: '1000',
  RATE_LIMIT_API_MAX: '10000',
  RATE_LIMIT_MEDIA_MAX: '10000',
  RATE_LIMIT_IMAGE_MAX: '50000',
};

// The cam-proxy release the e2e runs for Silo (e2e/realProxy.ts): the first
// with the recordings API, or later. Bump it with cam-proxy releases.
export const CAM_PROXY_TAG = 'v2026.10.02.3';

// The real cam-proxy for Silo (e2e/realProxy.ts). Test-only tokens. It runs
// in CI, or with CAMS_E2E_REAL_PROXY=1 on a Linux machine (host networking:
// it listens on every interface, so never on a laptop on the home LAN).
export const REAL_PROXY = {
  port: 8091,
  go2rtcRtsp: 8092,
  go2rtcApi: 8089,
  token: 'e2e-real-proxy-token-not-a-secret-000000',
  adminToken: 'e2e-real-proxy-admin-not-a-secret-000000',
};
export const REAL_PROXY_ON = !!process.env.CI || process.env.CAMS_E2E_REAL_PROXY === '1';
