import { afterAll, beforeEach } from 'vitest';

// Dummy values so every test runs against a fully configured app. None are
// real credentials; production gets its own from the cams-oauth Secret.
process.env.COOKIE_SECRET ??= 'test-cookie-secret-not-used-for-anything-real';
process.env.GOOGLE_CLIENT_ID ??= 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET ??= 'test-client-secret';
process.env.GOOGLE_REDIRECT_URI ??= 'http://localhost:8080/auth/google/callback';
process.env.ALLOWED_EMAILS ??= 'klaus@klaushofrichter.net';

// Each test file gets its own recordings cache and preferences, in a fresh
// folder (mkdtemp) that is removed after the file: a shared, hard-coded path
// raced across test files running at once (fix round 1, item 11), and a
// folder named after the worker outlived the run, so a later run started on
// the last run's cached clips and preferences — the occasional unrelated
// 400/404 (issue #69). Set, not defaulted: a worker that runs several files
// would otherwise keep the first file's (removed) folder (issue #76).
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
const scratch = mkdtempSync(join(tmpdir(), 'cams-test-'));
process.env.CACHE_DIR = join(scratch, 'cache');
process.env.PREFS_FILE = join(scratch, 'prefs.json');
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// Every test server listens on 127.0.0.1, not on all addresses (issue #109:
// the intermittent, unrelated 400/401/403/404/502 in a different test each
// run). On macOS another process may bind 127.0.0.1 to the port of a server
// that listens on all addresses, and from then on gets every connection to
// 127.0.0.1 on that port: a test's request (supertest connects to 127.0.0.1)
// or cams' request to the sim camera reached, for example, a cam-sim's
// mediamtx. A port bound to 127.0.0.1 itself can't be shared that way.
// listen(port[, backlog][, cb]) without a host binds at once, as before
// (supertest reads the address right away), through the step Node's own
// listen() ends in (_listen2); calls that name a host or path are unchanged.
import net from 'net';
type Listen2 = (address: string, port: number, addressType: number, backlog: number) => void;
const listen = net.Server.prototype.listen;
const listen2 = (net.Server.prototype as unknown as { _listen2?: Listen2 })._listen2;
if (typeof listen2 !== 'function') throw new Error('test/setup.ts: net.Server#_listen2 is gone; bind test servers to 127.0.0.1 another way');
net.Server.prototype.listen = function (this: net.Server, ...args: unknown[]) {
  const [port, ...rest] = args;
  if (typeof port !== 'number' || !rest.every((a) => typeof a === 'function' || typeof a === 'number')) return listen.apply(this, args as Parameters<typeof listen>);
  if (this.listening) throw new Error('already listening');
  const cb = rest.find((a) => typeof a === 'function') as (() => void) | undefined;
  if (cb) this.once('listening', cb);
  listen2.call(this, '127.0.0.1', port, 4, (rest.find((a) => typeof a === 'number') as number | undefined) ?? 511);
  return this;
} as typeof listen;

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
