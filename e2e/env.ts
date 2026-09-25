// Shared by the web server Playwright starts and by the specs that sign their
// own session cookie. None of these are real credentials.
export const E2E_PORT = 8099;
export const E2E_ENV: Record<string, string> = {
  PORT: String(E2E_PORT),
  COOKIE_SECRET: 'e2e-cookie-secret-not-used-for-anything-real',
  GOOGLE_CLIENT_ID: 'e2e',
  GOOGLE_CLIENT_SECRET: 'e2e',
  GOOGLE_REDIRECT_URI: `http://localhost:${E2E_PORT}/auth/google/callback`,
  ALLOWED_EMAILS: 'klaus@klaushofrichter.net',
  CAMERAS_FILE: 'e2e/cameras.json',
  APP_VERSION: 'e2e-test-version',
  LOG_LEVEL: 'silent',
  RATE_LIMIT_MAX: '1000',
  RATE_LIMIT_API_MAX: '10000',
};
