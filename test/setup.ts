// Dummy values so every test runs against a fully configured app. None are
// real credentials; production gets its own from the cams-oauth Secret.
process.env.COOKIE_SECRET ??= 'test-cookie-secret-not-used-for-anything-real';
process.env.GOOGLE_CLIENT_ID ??= 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET ??= 'test-client-secret';
process.env.GOOGLE_REDIRECT_URI ??= 'http://localhost:8080/auth/google/callback';
process.env.ALLOWED_EMAILS ??= 'klaus@klaushofrichter.net';

// Each vitest worker gets its own recordings cache directory (fix round 1,
// item 11): a shared, hard-coded path raced across test files that run
// concurrently in different workers (see test/recordingsRoutes.test.ts),
// since each worker re-runs this setupFile's top level once. VITEST_POOL_ID
// is stable per worker; process.pid is the fallback outside vitest's pool.
// A fresh folder per test file (mkdtemp), not one named after the worker:
// that name outlived the run, so a later run started on the last run's
// cached clips and preferences — the occasional unrelated 400/404 (issue #69).
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
const scratch = mkdtempSync(join(tmpdir(), 'cams-test-'));
process.env.CACHE_DIR = join(scratch, 'cache');
process.env.PREFS_FILE ??= join(scratch, 'prefs.json');

import { beforeEach } from 'vitest';
import { resetRateLimits } from '../server/middleware/rateLimit';
import { resetClients } from '../server/reolink/clients';

// Limiters are module-level, so counters would otherwise leak between tests.
beforeEach(() => resetRateLimits());
beforeEach(() => resetClients());
// Imported lazily (not at this file's top level): this setupFile loads
// before each test file's own module graph, so a static top-level import
// here would evaluate server/recordings/service.ts - and, transitively,
// thumbnail.ts - before that test file's own vi.mock('.../thumbnail', ...)
// (see test/recordingsRoutes.test.ts, fix round 1 item 8) has a chance to
// intercept it, permanently binding service.ts's internal calls to the
// real, unmocked module.
beforeEach(async () => {
  const { resetRecordings } = await import('../server/recordings/service');
  resetRecordings();
});
