// Dummy values so every test runs against a fully configured app. None are
// real credentials; production gets its own from the cams-oauth Secret.
process.env.COOKIE_SECRET ??= 'test-cookie-secret-not-used-for-anything-real';
process.env.GOOGLE_CLIENT_ID ??= 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET ??= 'test-client-secret';
process.env.GOOGLE_REDIRECT_URI ??= 'http://localhost:8080/auth/google/callback';
process.env.ALLOWED_EMAILS ??= 'klaus@klaushofrichter.net';

import { beforeEach } from 'vitest';
import { resetRateLimits } from '../server/middleware/rateLimit';
import { resetClients } from '../server/reolink/clients';
import { resetRecordings } from '../server/recordings/service';

// Limiters are module-level, so counters would otherwise leak between tests.
beforeEach(() => resetRateLimits());
beforeEach(() => resetClients());
beforeEach(() => resetRecordings());

// Deviation from the brief: it has this file clear CACHE_DIR in a top-level
// beforeAll. This setupFile is re-run once per test file (each file gets a
// fresh module/hook registry), so a beforeAll here fires once per file, not
// once for the whole run; with files scheduled across worker threads, one
// file's beforeAll can fire while another file (already deep into its own
// tests) still has clips cached under the same /tmp path, deleting them
// mid-download or mid-thumbnail (observed as sporadic ffmpeg "No such file"
// failures and 503s only under the full `npx vitest run`, never when
// test/recordingsRoutes.test.ts runs alone). Only that file touches the
// recordings cache, so it now clears its own CACHE_DIR itself, scoped to its
// own beforeEach, instead of it being handled here for every file.
