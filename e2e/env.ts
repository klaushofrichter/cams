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
// with the recordings API, or later. Bump both with cam-proxy releases: the
// digest is the image index's (`docker buildx imagetools inspect <image>:<tag>`),
// so a moved or replaced tag can't change what the e2e runs.
export const CAM_PROXY_TAG = 'v2026.10.02.3';
export const CAM_PROXY_DIGEST = 'sha256:3cbf98d20d4763804cd2d16bad7be6811dd75a49c9c3032f04e1e7ecb537bd69';
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
