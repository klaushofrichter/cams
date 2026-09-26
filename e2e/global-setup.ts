import { rmSync } from 'fs';
import { E2E_ENV } from './env';

// Runs once before any project/worker starts, regardless of how many
// projects (desktop, phone, live-teardown) or workers run the suite. Removes
// any preferences file left over from a previous run so settings.spec.ts's
// preferences tests start from the server's built-in defaults instead of
// whatever a prior run last saved.
export default function globalSetup(): void {
  rmSync(E2E_ENV.PREFS_FILE, { force: true });
}
