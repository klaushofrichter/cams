import { checkLoginEnv, LoginSummary } from './loginConfig';
import { logger } from './logger';
import { configMode } from './configSource';

// Startup check: throws (naming variables, never values) when the server
// can't run as configured. Google's three variables and ALLOWED_EMAILS are
// needed only with Google sign-in; a login token alone is enough on the Pi
// (spec 2026-10-04-pi-deployment-design).
export function assertRequiredEnv(): LoginSummary {
  if (!process.env.COOKIE_SECRET) {
    throw new Error('Missing required environment variable(s): COOKIE_SECRET');
  }
  const mode = configMode(); // throws naming CONFIG_SOURCE when it is wrong
  const summary = checkLoginEnv();
  // cams-admin mode: the users come from cams-admin, not ALLOWED_EMAILS.
  if (summary.google && mode !== 'cams-admin' && !process.env.ALLOWED_EMAILS) {
    throw new Error('Missing required environment variable(s): ALLOWED_EMAILS (needed with Google sign-in)');
  }
  if (!summary.cookieSecure) {
    logger.warn({ kind: 'config' }, 'cookie_secure_off');
  }
  return summary;
}
