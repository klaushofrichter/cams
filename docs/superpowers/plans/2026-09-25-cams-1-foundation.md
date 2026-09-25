# cams Plan 1: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deployed `cams.skylar.technology` with the public landing page, Google sign-in limited to one account, and the complete app shell (top bar, collapsible sidebar, hamburger drawer, theme toggle, camera picker, version link, placeholder pages), shipped through the cluster's standard three-workflow CI/CD with e2e tests at desktop and phone sizes.

**Architecture:** One Express 5 + TypeScript server (`server/`) serves a Svelte 5 + Vite multi-page frontend (`web/`, built to `dist/web`): `index.html` is the public landing page, `app.html` is the signed-in SPA. Auth, logging, rate limits and CI follow the sibling services (steps-service, www-klaushofrichter, kauf-server) closely, down to copied code where noted. No camera access yet: `/api/cameras` only lists configured cameras by id and name.

**Tech Stack:** Node 26, Express 5, TypeScript 7, pino/pino-http, express-rate-limit, google-auth-library, jsonwebtoken, Svelte 5, Vite, vitest (+ supertest, jsdom), Playwright, Docker (node:26-alpine), GitHub Actions, Knative on k3s.

**Spec:** `docs/superpowers/specs/2026-09-25-cams-design.md`

## Roadmap (this plan is 1 of 4)

The spec is split into four plans that each end in a working, deployed app. Plans 2–4 are written when their predecessor has shipped, against the real code.

1. **Foundation** (this plan): scaffold, auth, landing, app shell, tests, workflows, Docker, first deploy.
2. **Camera client and Live:**
   - Reolink client (token cache, re-login, timeouts, concurrency 2) and the `cams-cameras` Secret with the dedicated `cams` camera user.
   - Mock Reolink camera and camera status.
   - FLV live proxy, and the mpegts.js player with the 9-minute swap, sub/HD, snapshot and offline banner.
   - The open checks for HTTP port 80 and the second admin user.
3. **Recordings workspace:**
   - Search, days and events.
   - Trigger decoding verified on real clips.
   - Clip-ID mapping, the emptyDir clip cache with LRU, playback with Range, ffmpeg thumbnails, downloads.
   - Timeline, event and download panels, the shared time cursor in the URL, and the responsive layouts.
4. **Settings and About:** app preferences on the `cams-data` PVC, the camera settings cards, reboot, device info including certificate status, and the full About page.

## Global Constraints

- Node **26** everywhere: both Dockerfile stages `node:26-alpine`, `actions/setup-node` `node-version: 26`, `@types/node@^26`.
- Action pins: `actions/checkout@v7`, `actions/setup-node@v7`, `docker/login-action@v4`, `docker/build-push-action@v7`, `github/codeql-action/*@v4`.
- Version format `YYYY.MM.DD.N`, generated at deploy time with `TZ=America/Chicago`, never stored in sources. Image tags: `:main` only from `build-push.yml`; `:<sha>`, `:v<version>`, `:latest` only from `deploy-production.yml`.
- `GET /health` → `200 {"status":"ok","version":"<APP_VERSION or dev>"}`, never auth-gated, never dependent on a camera.
- Session cookie `session`: JWT `{email}` signed with `COOKIE_SECRET`, `httpOnly`, `secure`, `sameSite: 'lax'`, 7 days.
- `ALLOWED_EMAILS=klaus@klaushofrichter.net`, re-checked on every request.
- `trust proxy` = `['loopback', '10.42.0.0/16', '10.43.0.0/16']`.
- Container: `USER 1000:1000`; the ksvc runs non-root, drops ALL capabilities, no privilege escalation, seccomp RuntimeDefault.
- Logs: JSON on stdout. Never log passwords, tokens, cookies or client IPs.
- Repo URL shown in the UI: `https://github.com/klaushofrichter/cams`. Company name: "Skylar Technology LLC".
- Visual tokens (Midnight Steel, dark): bg `#0B1220`, chrome `#0F1829`, border `#1C2940`, text `#E6EDF7`, muted `#9FB0CC`, accent `#22D3EE` → `#6366F1`, live/danger `#EF4444`.
- Breakpoint: `< 768px` is the phone layout (hamburger + drawer). Sidebar 220 px expanded, 64 px collapsed.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01FWQXK7pQ7ZaUZbCn6oqPEe
  ```
  (Shown once here; every `git commit` below uses this trailer.)

## Review Focus

1. **A valid session cookie for an email that has since been removed from `ALLOWED_EMAILS`** must be locked out on the very next request, both page and API. Pinned in Task 3.
2. **A signed-out deep link** (e.g. `/app/settings`) should land back on that page after Google sign-in, not on the default page, and the return path must never allow an open redirect (`//evil.com`, `/\evil.com`, absolute URLs). Pinned in Task 4.
3. **`localStorage` unavailable** (private mode, blocked storage throws) must not break theme, sidebar or first render. The app falls back to the system theme and an expanded sidebar. Pinned in Tasks 6 and 8.
4. **A camera registry file that is missing, empty or malformed:**
   - A missing file (Secret not created yet) means "no cameras" plus a warning, and the app still starts.
   - Malformed JSON or duplicate ids fail startup with a message naming the problem.
   - Pinned in Task 5.
5. **Unknown paths:**
   - `/app/<unknown>` renders the Live page, not a blank shell.
   - `/api/<unknown>` returns JSON 404, not the SPA HTML.
   - Other unknown paths return 404, not the landing page.
   - Pinned in Tasks 5 and 7.

---

## Preconditions (already done, do not redo)

- The repo `klaushofrichter/cams` exists (public). The local clone is `~/Development/cams` on branch `main`, containing only `.gitignore` and `docs/`.
- The Google OAuth client "cams" exists in project `1004218987196` with the redirect URI `https://cams.skylar.technology/auth/google/callback`. Its ID and secret are in `~/Development/reolink/.env` as `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`. The runner PAT is there as `CAMS_GITHUB_PAT`, and the allow-list as `ALLOWED_EMAILS=klaus@klaushofrichter.net`.
- Kubeconfig for the cluster: `~/.kube/k3s-config`.

All paths below are relative to `~/Development/cams` unless absolute.

---

### Task 1: Project scaffold, version and `/health`

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.env.example`, `test/setup.ts`
- Create: `server/version.ts`, `server/routes/health.ts`, `server/app.ts`, `server/server.ts`
- Test: `test/health.test.ts`

**Interfaces:**
- Produces: `appVersion(): string` (`server/version.ts`), `createApp(): Express` (`server/app.ts`), `healthRouter` (`server/routes/health.ts`).

- [ ] **Step 1: Create `package.json` and install dependencies**

```json
{
  "name": "cams",
  "version": "0.0.0",
  "private": true,
  "description": "Viewer for Reolink cameras: live view, recordings, events and downloads behind Google sign-in.",
  "license": "MIT",
  "type": "commonjs",
  "scripts": {
    "build": "npm run build:server && npm run build:web",
    "build:server": "tsc -p tsconfig.json",
    "build:web": "vite build --config web/vite.config.ts",
    "check": "svelte-check --tsconfig web/tsconfig.json --fail-on-warnings",
    "start": "node dist/server/server.js",
    "dev": "tsx --env-file=.env server/server.ts",
    "dev:web": "vite --config web/vite.config.ts",
    "test": "vitest run",
    "test:e2e": "playwright test",
    "icons": "node scripts/gen-icons.mjs"
  }
}
```

Run:
```bash
npm install express@^5 cookie-parser express-rate-limit google-auth-library jsonwebtoken pino pino-http
npm install -D typescript @types/node@^26 @types/express @types/cookie-parser @types/jsonwebtoken @types/supertest supertest tsx vitest jsdom @playwright/test svelte @sveltejs/vite-plugin-svelte vite svelte-check @resvg/resvg-js
```
Expected: `package-lock.json` is created; `grep '"@types/node"' package.json` shows `^26`.

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "lib": ["ES2022"],
    "outDir": "dist/server",
    "rootDir": "server",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  },
  "include": ["server"]
}
```

- [ ] **Step 3: Create `vitest.config.ts` and `test/setup.ts`**

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'web/src/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    env: { LOG_LEVEL: 'silent' },
  },
});
```

`test/setup.ts`:
```ts
// Dummy values so every test runs against a fully configured app. None are
// real credentials; production gets its own from the cams-oauth Secret.
process.env.COOKIE_SECRET ??= 'test-cookie-secret-not-used-for-anything-real';
process.env.GOOGLE_CLIENT_ID ??= 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET ??= 'test-client-secret';
process.env.GOOGLE_REDIRECT_URI ??= 'http://localhost:8080/auth/google/callback';
process.env.ALLOWED_EMAILS ??= 'klaus@klaushofrichter.net';
```

- [ ] **Step 4: Write the failing test `test/health.test.ts`**

```ts
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../server/app';

describe('GET /health', () => {
  afterEach(() => {
    delete process.env.APP_VERSION;
  });

  it('reports ok and "dev" when no version is stamped', async () => {
    const res = await request(createApp()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', version: 'dev' });
  });

  it('reports the stamped APP_VERSION', async () => {
    process.env.APP_VERSION = '2026.09.26.1';
    const res = await request(createApp()).get('/health');
    expect(res.body.version).toBe('2026.09.26.1');
  });
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `npx vitest run test/health.test.ts`
Expected: FAIL, `Cannot find module '../server/app'`.

- [ ] **Step 6: Implement**

`server/version.ts`:
```ts
// Baked in by the Docker build (ARG APP_VERSION); "dev" when running locally.
// Read per call rather than at module load, so tests can observe changes.
export function appVersion(): string {
  return process.env.APP_VERSION || 'dev';
}
```

`server/routes/health.ts`:
```ts
import { Router, Request, Response } from 'express';
import { appVersion } from '../version';

export const healthRouter = Router();

// Readiness probe, deploy smoke test and version-exporter all read this. It
// must never depend on a camera: an offline camera must not restart the pod.
healthRouter.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', version: appVersion() });
});
```

`server/app.ts`:
```ts
import express, { Express } from 'express';
import cookieParser from 'cookie-parser';
import { healthRouter } from './routes/health';

export function createApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(healthRouter);
  return app;
}
```

`server/server.ts`:
```ts
import { createApp } from './app';

const port = Number(process.env.PORT) || 8080;
createApp().listen(port, () => {
  console.log(`cams listening on port ${port}`);
});
```

`.env.example`:
```
# Copy to .env for `npm run dev`. Values here are placeholders.
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:8080/auth/google/callback
ALLOWED_EMAILS=klaus@klaushofrichter.net
COOKIE_SECRET=
# JSON list of cameras: [{"id","name","host","user","password"}]
CAMERAS_FILE=
LOG_LEVEL=debug
```

- [ ] **Step 7: Run tests and build**

Run: `npx vitest run test/health.test.ts && npm run build:server`
Expected: 2 passed; `dist/server/server.js` exists.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .env.example test server
git commit -m "feat: project scaffold with /health"
```

---

### Task 2: Structured logging and trusted proxies

**Files:**
- Create: `server/logger.ts`, `server/trustProxy.ts`
- Modify: `server/app.ts`
- Test: `test/logger.test.ts`

**Interfaces:**
- Produces: `logger: pino.Logger`, `httpLogger`, `createHttpLogger(dest?)`, `levelFor(status, url)` (`server/logger.ts`); `TRUST_PROXY: string[]` (`server/trustProxy.ts`).

- [ ] **Step 1: Write the failing test `test/logger.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Writable } from 'stream';
import { createHttpLogger, levelFor } from '../server/logger';

describe('levelFor', () => {
  it('keeps probe traffic at debug', () => {
    expect(levelFor(200, '/health')).toBe('debug');
    expect(levelFor(200, '/health?x=1')).toBe('debug');
  });
  it('maps statuses to levels', () => {
    expect(levelFor(200, '/api/me')).toBe('info');
    expect(levelFor(401, '/api/me')).toBe('warn');
    expect(levelFor(403, '/auth/google/callback')).toBe('warn');
    expect(levelFor(429, '/api/me')).toBe('warn');
    expect(levelFor(503, '/api/me')).toBe('error');
  });
});

describe('httpLogger', () => {
  it('emits one flat line without cookies, query strings or client IPs', async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const app = express();
    app.use(createHttpLogger(sink));
    app.get('/api/thing', (_req, res) => {
      res.cookie('session', 'secret-session-value');
      res.json({ ok: true });
    });
    await request(app).get('/api/thing?token=abc').set('Cookie', 'session=secret-cookie-value');
    const joined = lines.join('\n');
    expect(joined).not.toContain('secret-cookie-value');
    expect(joined).not.toContain('secret-session-value');
    expect(joined).not.toContain('token=abc');
    const entry = JSON.parse(lines[0]);
    expect(entry).toMatchObject({ kind: 'api_request', method: 'GET', path: '/api/thing', status: 200 });
    expect(entry).not.toHaveProperty('ip');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/logger.test.ts`
Expected: FAIL, `Cannot find module '../server/logger'`.

- [ ] **Step 3: Implement `server/logger.ts`** (adapted from steps-service `src/logger.ts`)

```ts
import { randomUUID } from 'crypto';
import { IncomingMessage, ServerResponse } from 'http';
import pino from 'pino';
import pinoHttp from 'pino-http';

// JSON to stdout only; the kubelet owns rotation. LOG_LEVEL lets tests silence
// output. IMPORTANT: the cluster's collector drops debug lines, so debug stays
// in the cluster while info and above ship to Grafana Cloud. Anything
// detailed (payloads, headers) may only ever be logged at debug.
function makeLogger(destination: pino.DestinationStream = pino.destination(1)): pino.Logger {
  return pino(
    { level: process.env.LOG_LEVEL || 'info', base: undefined, timestamp: pino.stdTimeFunctions.epochTime },
    destination
  );
}

export const logger = makeLogger();

// Exact list, not a prefix, so a later route under /health does not inherit
// silence it was never meant to have.
const PROBE_PATHS = new Set(['/health']);

export function levelFor(status: number, url: string): 'debug' | 'info' | 'warn' | 'error' {
  if (PROBE_PATHS.has(url.split('?')[0])) return 'debug';
  if (status >= 500) return 'error';
  if (status === 401 || status === 403 || status === 429) return 'warn';
  return 'info';
}

function flatten(
  req: IncomingMessage & { id?: unknown },
  res: ServerResponse,
  val: Record<string, unknown>
): Record<string, unknown> {
  // No client address: PII going to a third party, and on a single-user
  // service it is always the same person.
  return {
    ...val,
    kind: 'api_request',
    reqId: req.id as string,
    method: req.method,
    path: (req.url || '').split('?')[0],
    status: res.statusCode,
  };
}

export function createHttpLogger(destination?: pino.DestinationStream) {
  return pinoHttp({
    logger: destination ? makeLogger(destination) : logger,
    genReqId: (req: IncomingMessage) => (req.headers['x-request-id'] as string) || randomUUID(),
    // Backstop: the serializers below already drop req/res entirely.
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
      remove: true,
    },
    customLogLevel: (req: IncomingMessage, res: ServerResponse, err?: Error) =>
      err ? 'error' : levelFor(res.statusCode, req.url || ''),
    customSuccessMessage: () => 'api_request',
    customErrorMessage: () => 'api_request',
    customAttributeKeys: { responseTime: 'durationMs' },
    // customProps is deliberately not used: pino-http evaluates it twice and
    // emits duplicate keys with a stale status (see steps-service).
    customSuccessObject: (req, res, val) => flatten(req, res, val),
    customErrorObject: (req, res, _err, val) => flatten(req, res, val),
    serializers: { req: () => undefined, res: () => undefined },
  });
}

export const httpLogger = createHttpLogger();
```

`server/trustProxy.ts`:
```ts
// Which upstream addresses are proxies rather than clients. A CIDR list, not a
// hop count: Express skips every matching address in X-Forwarded-For and
// returns the first that doesn't, which stays right when the ingress chain
// (Traefik -> Kourier -> queue-proxy today) gains or loses a hop. A hop count
// fails quietly by resolving to a pod address. 10.42/16 = pods, 10.43/16 =
// services (k3s defaults). Also required for req.protocol, which the
// same-origin check builds its expected origin from.
export const TRUST_PROXY = ['loopback', '10.42.0.0/16', '10.43.0.0/16'];
```

Replace `server/app.ts` with:
```ts
import express, { Express } from 'express';
import cookieParser from 'cookie-parser';
import { httpLogger } from './logger';
import { TRUST_PROXY } from './trustProxy';
import { healthRouter } from './routes/health';

export function createApp(): Express {
  const app = express();
  app.set('trust proxy', TRUST_PROXY);
  // First, so rejected requests (401/403/429) are logged too.
  app.use(httpLogger);
  app.use(express.json());
  app.use(cookieParser());
  app.use(healthRouter);
  return app;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run`
Expected: all pass (health + logger).

- [ ] **Step 5: Commit**

```bash
git add server test
git commit -m "feat: structured request logging and trusted proxy list"
```

---

### Task 3: Sessions, allow-list and auth guards

**Files:**
- Create: `server/allowedEmails.ts`, `server/session.ts`, `server/middleware/requireAuth.ts`
- Test: `test/requireAuth.test.ts`

**Interfaces:**
- Produces:
  - `getAllowedEmails(): string[]`
  - `SESSION_COOKIE = 'session'`, `SESSION_MAX_AGE_MS`, `signSession(email: string): string`, `verifySession(token: string): SessionPayload | null`, where `SessionPayload = { email: string }`
  - `currentUser(req): SessionPayload | null`
  - The middleware `requireAuthPage`, `requireAuthApi`, `noStore`
  - `RETURN_COOKIE = 'return_to'` (written by `requireAuthPage` in Task 4)

- [ ] **Step 1: Write the failing test `test/requireAuth.test.ts`**

```ts
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { signSession, verifySession, SESSION_COOKIE } from '../server/session';
import { currentUser, noStore, requireAuthApi, requireAuthPage } from '../server/middleware/requireAuth';

function appWithGuards() {
  const app = express();
  app.use(cookieParser());
  app.get('/whoami', (req, res) => res.json(currentUser(req)));
  app.get('/app/page', noStore, requireAuthPage, (_req, res) => res.send('page'));
  app.get('/api/thing', noStore, requireAuthApi, (_req, res) => res.json({ ok: true }));
  return app;
}
const cookieFor = (email: string) => `${SESSION_COOKIE}=${signSession(email)}`;

describe('session tokens', () => {
  it('round-trips an email', () => {
    expect(verifySession(signSession('klaus@klaushofrichter.net'))).toEqual({ email: 'klaus@klaushofrichter.net' });
  });
  it('rejects a token signed with another secret', () => {
    expect(verifySession(jwt.sign({ email: 'klaus@klaushofrichter.net' }, 'other-secret'))).toBeNull();
  });
  it('rejects an expired token', () => {
    const expired = jwt.sign({ email: 'klaus@klaushofrichter.net' }, process.env.COOKIE_SECRET!, { expiresIn: -10 });
    expect(verifySession(expired)).toBeNull();
  });
  it('rejects a token without an email', () => {
    expect(verifySession(jwt.sign({ sub: 'x' }, process.env.COOKIE_SECRET!))).toBeNull();
  });
});

describe('auth guards', () => {
  afterEach(() => {
    process.env.ALLOWED_EMAILS = 'klaus@klaushofrichter.net';
  });

  it('lets an allowed session through, with no-store', async () => {
    const res = await request(appWithGuards()).get('/api/thing').set('Cookie', cookieFor('klaus@klaushofrichter.net'));
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('answers signed-out API calls with 401 JSON and pages with a redirect to /', async () => {
    const app = appWithGuards();
    const api = await request(app).get('/api/thing');
    expect(api.status).toBe(401);
    expect(api.body).toEqual({ error: 'unauthorized' });
    const page = await request(app).get('/app/page');
    expect(page.status).toBe(302);
    expect(page.headers.location).toBe('/');
  });

  // Review focus 1: removing an address must lock out existing sessions at once.
  it('locks out a valid session whose email was removed from ALLOWED_EMAILS', async () => {
    const cookie = cookieFor('klaus@klaushofrichter.net');
    process.env.ALLOWED_EMAILS = 'someone-else@example.com';
    const app = appWithGuards();
    expect((await request(app).get('/api/thing').set('Cookie', cookie)).status).toBe(401);
    expect((await request(app).get('/app/page').set('Cookie', cookie)).status).toBe(302);
    expect((await request(app).get('/whoami').set('Cookie', cookie)).body).toBeNull();
  });

  it('trims whitespace and ignores empty entries in ALLOWED_EMAILS', async () => {
    process.env.ALLOWED_EMAILS = ' , klaus@klaushofrichter.net ,';
    const res = await request(appWithGuards()).get('/api/thing').set('Cookie', cookieFor('klaus@klaushofrichter.net'));
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/requireAuth.test.ts`
Expected: FAIL, `Cannot find module '../server/session'`.

- [ ] **Step 3: Implement**

`server/allowedEmails.ts`:
```ts
// Read per call so a changed Secret takes effect after a restart without a
// code path that could cache a stale list.
export function getAllowedEmails(): string[] {
  return (process.env.ALLOWED_EMAILS ?? '')
    .split(',')
    .map((email) => email.trim())
    .filter((email) => email.length > 0);
}
```

`server/session.ts`:
```ts
import jwt from 'jsonwebtoken';

export const SESSION_COOKIE = 'session';
export const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionPayload {
  email: string;
}

function getCookieSecret(): string {
  const secret = process.env.COOKIE_SECRET;
  if (!secret) throw new Error('COOKIE_SECRET is not set');
  return secret;
}

export function signSession(email: string): string {
  return jwt.sign({ email }, getCookieSecret(), { expiresIn: '7d' });
}

export function verifySession(token: string): SessionPayload | null {
  try {
    const decoded = jwt.verify(token, getCookieSecret());
    if (typeof decoded === 'object' && decoded !== null && typeof (decoded as { email?: unknown }).email === 'string') {
      return { email: (decoded as { email: string }).email };
    }
    return null;
  } catch {
    return null;
  }
}
```

`server/middleware/requireAuth.ts`:
```ts
import { NextFunction, Request, Response } from 'express';
import { getAllowedEmails } from '../allowedEmails';
import { SESSION_COOKIE, SessionPayload, verifySession } from '../session';

export const RETURN_COOKIE = 'return_to';
const RETURN_MAX_AGE_MS = 10 * 60 * 1000;

// The single definition of "signed in". The allow-list is re-checked on every
// request, so removing an address locks that account out immediately rather
// than when its 7-day cookie expires.
export function currentUser(req: Request): SessionPayload | null {
  const token = req.cookies?.[SESSION_COOKIE];
  if (typeof token !== 'string') return null;
  const session = verifySession(token);
  if (!session) return null;
  return getAllowedEmails().includes(session.email) ? session : null;
}

export function requireAuthPage(req: Request, res: Response, next: NextFunction): void {
  if (!currentUser(req)) {
    // Remember where the visitor was going, so sign-in can bring them back.
    // Only /app paths are stored; the callback validates again before use.
    if (req.originalUrl.startsWith('/app')) {
      res.cookie(RETURN_COOKIE, req.originalUrl, {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        maxAge: RETURN_MAX_AGE_MS,
      });
    }
    res.redirect(302, '/');
    return;
  }
  next();
}

// JSON, not a redirect: a fetch() following a redirect would get HTML back
// and fail far from the cause.
export function requireAuthApi(req: Request, res: Response, next: NextFunction): void {
  if (!currentUser(req)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

// Camera pages and images must not sit in the browser cache after logout.
export function noStore(_req: Request, res: Response, next: NextFunction): void {
  res.set('Cache-Control', 'no-store');
  next();
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add server test
git commit -m "feat: JWT sessions, per-request allow-list, auth guards"
```

---

### Task 4: Google OAuth sign-in, logout, return path and rate limits

**Files:**
- Create: `server/googleLogin.ts`, `server/routes/auth.ts`, `server/middleware/rateLimit.ts`, `server/config.ts`
- Modify: `server/app.ts`, `server/server.ts`, `test/setup.ts`
- Test: `test/auth.test.ts`, `test/config.test.ts`

**Interfaces:**
- Consumes: `SESSION_COOKIE`, `SESSION_MAX_AGE_MS`, `signSession`, `getAllowedEmails`, `RETURN_COOKIE` (Task 3).
- Produces:
  - `authRouter` with `GET /auth/google/login`, `GET /auth/google/callback` and `GET /auth/logout`.
  - `safeReturnPath(value: unknown): string | null`.
  - `createAuthRateLimit()`, `createApiRateLimit()`, `resetRateLimits()`.
  - `assertRequiredEnv(): void`.

- [ ] **Step 1: Write the failing tests**

`test/auth.test.ts`:
```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const google = vi.hoisted(() => ({ payload: {} as Record<string, unknown>, fail: false }));

vi.mock('google-auth-library', () => ({
  OAuth2Client: vi.fn(function () {
    return {
      getToken: vi.fn(async () => {
        if (google.fail) throw new Error('bad code');
        return { tokens: { id_token: 'id-token' } };
      }),
      verifyIdToken: vi.fn(async () => ({ getPayload: () => google.payload })),
    };
  }),
}));

import { createApp } from '../server/app';
import { safeReturnPath } from '../server/routes/auth';

const NONCE = '0123456789abcdef0123456789abcdef';
const stateCookie = `oauth_state=${NONCE}`;

beforeEach(() => {
  google.payload = { email: 'klaus@klaushofrichter.net', email_verified: true };
  google.fail = false;
});

describe('GET /auth/google/login', () => {
  it('redirects to Google with openid email scope and sets a state cookie', async () => {
    const res = await request(createApp()).get('/auth/google/login');
    expect(res.status).toBe(302);
    const url = new URL(res.headers.location);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')).toBe('openid email');
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    expect(url.searchParams.get('state')).toMatch(/^[0-9a-f]{32}\.first$/);
    expect(res.headers['set-cookie'].join(';')).toMatch(/oauth_state=[0-9a-f]{32}/);
  });
});

describe('GET /auth/google/callback', () => {
  it('signs in an allowed, verified account and redirects to /', async () => {
    const res = await request(createApp())
      .get(`/auth/google/callback?code=c&state=${NONCE}.first`)
      .set('Cookie', stateCookie);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
    const cookies = res.headers['set-cookie'].join(';');
    expect(cookies).toMatch(/session=[^;]+; Max-Age=604800/);
    expect(cookies).toMatch(/HttpOnly/);
    expect(cookies).toMatch(/Secure/);
    expect(cookies).toMatch(/SameSite=Lax/);
  });

  it('rejects a state that does not match the cookie', async () => {
    const res = await request(createApp())
      .get(`/auth/google/callback?code=c&state=ffffffffffffffffffffffffffffffff.first`)
      .set('Cookie', stateCookie);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'invalid state' });
  });

  it('rejects a missing code', async () => {
    const res = await request(createApp()).get(`/auth/google/callback?state=${NONCE}.first`).set('Cookie', stateCookie);
    expect(res.status).toBe(401);
  });

  it('rejects an unverified email', async () => {
    google.payload = { email: 'klaus@klaushofrichter.net', email_verified: false };
    const res = await request(createApp())
      .get(`/auth/google/callback?code=c&state=${NONCE}.first`)
      .set('Cookie', stateCookie);
    expect(res.status).toBe(401);
  });

  it('answers a failed code exchange with 401', async () => {
    google.fail = true;
    const res = await request(createApp())
      .get(`/auth/google/callback?code=c&state=${NONCE}.first`)
      .set('Cookie', stateCookie);
    expect(res.status).toBe(401);
  });

  it('retries once with the account chooser for a disallowed account, then 403', async () => {
    google.payload = { email: 'intruder@example.com', email_verified: true };
    const app = createApp();
    const first = await request(app).get(`/auth/google/callback?code=c&state=${NONCE}.first`).set('Cookie', stateCookie);
    expect(first.status).toBe(302);
    expect(new URL(first.headers.location).searchParams.get('prompt')).toBe('select_account');
    const second = await request(app).get(`/auth/google/callback?code=c&state=${NONCE}.reselect`).set('Cookie', stateCookie);
    expect(second.status).toBe(403);
  });

  // Review focus 2: a signed-out deep link comes back after sign-in.
  it('redirects to a remembered /app path after sign-in and clears it', async () => {
    const res = await request(createApp())
      .get(`/auth/google/callback?code=c&state=${NONCE}.first`)
      .set('Cookie', `${stateCookie}; return_to=${encodeURIComponent('/app/settings?cam=cam1')}`);
    expect(res.headers.location).toBe('/app/settings?cam=cam1');
    expect(res.headers['set-cookie'].join(';')).toMatch(/return_to=;/);
  });

  it('ignores an unsafe remembered path', async () => {
    const res = await request(createApp())
      .get(`/auth/google/callback?code=c&state=${NONCE}.first`)
      .set('Cookie', `${stateCookie}; return_to=${encodeURIComponent('//evil.example/app')}`);
    expect(res.headers.location).toBe('/');
  });
});

describe('safeReturnPath', () => {
  it.each([
    ['/app/live', '/app/live'],
    ['/app/recordings?cam=cam1&panel=events', '/app/recordings?cam=cam1&panel=events'],
    ['/app', '/app'],
  ])('accepts %s', (input, expected) => expect(safeReturnPath(input)).toBe(expected));

  it.each(['//evil.example', '/\\evil.example', 'https://evil.example/app', '/application', '/apps', '/app//evil', '', undefined, 42])(
    'rejects %s',
    (input) => expect(safeReturnPath(input)).toBeNull()
  );
});

describe('GET /auth/logout', () => {
  it('clears the session cookie and returns to the landing page', async () => {
    const res = await request(createApp()).get('/auth/logout');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
    expect(res.headers['set-cookie'].join(';')).toMatch(/session=;/);
  });
});
```

`test/config.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import { assertRequiredEnv } from '../server/config';

describe('assertRequiredEnv', () => {
  const saved = process.env.COOKIE_SECRET;
  afterEach(() => {
    process.env.COOKIE_SECRET = saved;
  });
  it('passes when everything is set', () => {
    expect(() => assertRequiredEnv()).not.toThrow();
  });
  it('names the missing variable', () => {
    delete process.env.COOKIE_SECRET;
    expect(() => assertRequiredEnv()).toThrow(/COOKIE_SECRET/);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/auth.test.ts test/config.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`server/middleware/rateLimit.ts`:
```ts
import rateLimit, { MemoryStore, RateLimitRequestHandler } from 'express-rate-limit';

function fromEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// Overridable so the e2e suite can lift the caps; production sets neither.
const WINDOW_MS = fromEnv('RATE_LIMIT_WINDOW_MS', 5 * 60 * 1000);
const AUTH_MAX = fromEnv('RATE_LIMIT_MAX', 40);
const API_MAX = fromEnv('RATE_LIMIT_API_MAX', 600);

// In-memory stores are correct only because the ksvc is pinned to one
// replica. Held here so tests can reset them between cases.
const stores: MemoryStore[] = [];

function build(limit: number): RateLimitRequestHandler {
  const store = new MemoryStore();
  stores.push(store);
  return rateLimit({ windowMs: WINDOW_MS, limit, standardHeaders: true, legacyHeaders: false, store });
}

export function createAuthRateLimit(): RateLimitRequestHandler {
  return build(AUTH_MAX);
}

export function createApiRateLimit(): RateLimitRequestHandler {
  return build(API_MAX);
}

export function resetRateLimits(): void {
  stores.forEach((store) => store.resetAll());
}
```

`server/googleLogin.ts`: copy verbatim from `~/Development/steps-service/src/googleLogin.ts` (the full file is reproduced below so this task is self-contained).
```ts
import { Request, Response } from 'express';
import { randomBytes, timingSafeEqual } from 'crypto';

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const OAUTH_STATE_COOKIE = 'oauth_state';
const STATE_MAX_AGE_MS = 10 * 60 * 1000;
const NONCE_PATTERN = /^[0-9a-f]{32}$/;

// 'first' lets Google use the browser's default account silently; 'reselect'
// is the single retry with the account chooser after that account was not
// allowed. A disallowed account on the retry gets a 403, so it cannot loop.
export type LoginAttempt = 'first' | 'reselect';

export function buildGoogleAuthUrl(state: string, attempt: LoginAttempt): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID ?? '',
    redirect_uri: process.env.GOOGLE_REDIRECT_URI ?? '',
    response_type: 'code',
    scope: 'openid email',
    state,
  });
  if (attempt === 'reselect') params.set('prompt', 'select_account');
  return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
}

// Login-CSRF defence: the nonce lives in an httpOnly cookie and travels to
// Google in `state`; the callback accepts a code only when they match. An
// existing nonce is reused so a second tab does not clobber a login in flight.
function issueNonce(req: Request, res: Response): string {
  const existing = req.cookies?.[OAUTH_STATE_COOKIE];
  const nonce = typeof existing === 'string' && NONCE_PATTERN.test(existing) ? existing : randomBytes(16).toString('hex');
  res.cookie(OAUTH_STATE_COOKIE, nonce, {
    httpOnly: true,
    secure: true,
    // Lax: the callback arrives as a top-level redirect from Google.
    sameSite: 'lax',
    maxAge: STATE_MAX_AGE_MS,
  });
  return nonce;
}

export function redirectToGoogle(req: Request, res: Response, attempt: LoginAttempt): void {
  const nonce = issueNonce(req, res);
  res.redirect(302, buildGoogleAuthUrl(`${nonce}.${attempt}`, attempt));
}

export function checkState(req: Request): LoginAttempt | null {
  const cookie = req.cookies?.[OAUTH_STATE_COOKIE];
  const state = req.query.state;
  if (typeof cookie !== 'string' || typeof state !== 'string') return null;
  const dot = state.lastIndexOf('.');
  if (dot === -1) return null;
  const nonce = state.slice(0, dot);
  const attempt = state.slice(dot + 1);
  if (attempt !== 'first' && attempt !== 'reselect') return null;
  const presented = Buffer.from(nonce);
  const expected = Buffer.from(cookie);
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;
  return attempt;
}

export function clearState(res: Response): void {
  res.clearCookie(OAUTH_STATE_COOKIE, { httpOnly: true, secure: true, sameSite: 'lax' });
}
```

`server/routes/auth.ts`:
```ts
import { Router, Request, Response } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { SESSION_COOKIE, SESSION_MAX_AGE_MS, signSession } from '../session';
import { getAllowedEmails } from '../allowedEmails';
import { createAuthRateLimit } from '../middleware/rateLimit';
import { RETURN_COOKIE } from '../middleware/requireAuth';
import { checkState, clearState, redirectToGoogle } from '../googleLogin';

export const authRouter = Router();
const authRateLimit = createAuthRateLimit();
const COOKIE_OPTS = { httpOnly: true, secure: true, sameSite: 'lax' as const };

// Only same-site /app paths: "/app", "/app/...", "/app?...". Anything that a
// browser could read as another origin ("//x", "/\x", absolute URLs) or that
// merely starts with the letters ("/apps") is refused.
export function safeReturnPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (!/^\/app(?:[/?]|$)/.test(value)) return null;
  if (value.includes('//') || value.includes('\\')) return null;
  return value;
}

authRouter.get('/auth/google/login', authRateLimit, (req: Request, res: Response) => {
  redirectToGoogle(req, res, 'first');
});

authRouter.get('/auth/google/callback', authRateLimit, async (req: Request, res: Response) => {
  const code = req.query.code;
  if (typeof code !== 'string' || code.length === 0) {
    res.status(401).json({ error: 'missing authorization code' });
    return;
  }
  // Before the code is redeemed: a callback this browser did not start must
  // not be able to sign it in, whoever's code it carries.
  const attempt = checkState(req);
  if (!attempt) {
    res.status(401).json({ error: 'invalid state' });
    return;
  }

  const client = new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  let email: string | undefined;
  try {
    const { tokens } = await client.getToken(code);
    const ticket = await client.verifyIdToken({ idToken: tokens.id_token ?? '', audience: process.env.GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    email = payload?.email_verified ? payload.email : undefined;
  } catch {
    res.status(401).json({ error: 'authentication failed' });
    return;
  }
  if (!email) {
    res.status(401).json({ error: 'authentication failed' });
    return;
  }

  if (!getAllowedEmails().includes(email)) {
    if (attempt === 'first') {
      redirectToGoogle(req, res, 'reselect');
      return;
    }
    clearState(res);
    res.status(403).json({ error: 'forbidden' });
    return;
  }

  clearState(res);
  res.cookie(SESSION_COOKIE, signSession(email), { ...COOKIE_OPTS, maxAge: SESSION_MAX_AGE_MS });
  const returnTo = safeReturnPath(req.cookies?.[RETURN_COOKIE]);
  res.clearCookie(RETURN_COOKIE, COOKIE_OPTS);
  res.redirect(302, returnTo ?? '/');
});

authRouter.get('/auth/logout', (_req: Request, res: Response) => {
  res.clearCookie(SESSION_COOKIE, COOKIE_OPTS);
  res.redirect(302, '/');
});
```

`server/config.ts`:
```ts
const REQUIRED_ENV_VARS = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REDIRECT_URI',
  'COOKIE_SECRET',
  'ALLOWED_EMAILS',
] as const;

export function assertRequiredEnv(): void {
  const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s): ${missing.join(', ')}`);
  }
}
```

In `server/app.ts` add the import `import { authRouter } from './routes/auth';` and register it after `healthRouter`:
```ts
  app.use(healthRouter);
  app.use(authRouter);
```

Replace `server/server.ts` with:
```ts
import { createApp } from './app';
import { assertRequiredEnv } from './config';

assertRequiredEnv();
const port = Number(process.env.PORT) || 8080;
createApp().listen(port, () => {
  console.log(`cams listening on port ${port}`);
});
```

Append to `test/setup.ts`:
```ts
import { beforeEach } from 'vitest';
import { resetRateLimits } from '../server/middleware/rateLimit';

// Limiters are module-level, so counters would otherwise leak between tests.
beforeEach(() => resetRateLimits());
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add server test
git commit -m "feat: Google sign-in with state nonce, safe return path, rate limits"
```

---

### Task 5: Same-origin check, camera registry and the `/api` surface

**Files:**
- Create: `server/middleware/requireSameOrigin.ts`, `server/cameraRegistry.ts`, `server/routes/api.ts`
- Modify: `server/app.ts`, `server/server.ts`
- Test: `test/cameraRegistry.test.ts`, `test/api.test.ts`

**Interfaces:**
- Consumes: `requireAuthApi`, `noStore`, `currentUser` (Task 3); `createApiRateLimit` (Task 4); `appVersion` (Task 1).
- Produces:
  - `CameraConfig = { id: string; name: string; host: string; user: string; password: string }` and `CameraSummary = { id: string; name: string }`.
  - `loadCameras(file?: string): CameraConfig[]`, `setCameras(list: CameraConfig[]): void`, `listCameras(): CameraSummary[]`, `getCamera(id: string): CameraConfig | undefined`.
  - `GET /api/me` → `{ email: string; version: string }`.
  - `GET /api/cameras` → `CameraSummary[]`.
  - Unknown `/api/*` → `404 {"error":"not found"}`.
  - `requireSameOrigin` middleware.

- [ ] **Step 1: Write the failing tests**

`test/cameraRegistry.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getCamera, listCameras, loadCameras, setCameras } from '../server/cameraRegistry';

const dir = mkdtempSync(join(tmpdir(), 'cams-reg-'));
function file(name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}
const cam1 = { id: 'cam1', name: 'Den', host: '10.0.0.5', user: 'cams', password: 'pw' };

afterEach(() => setCameras([]));

describe('loadCameras', () => {
  it('returns [] when no file is configured', () => {
    expect(loadCameras(undefined)).toEqual([]);
  });

  // Review focus 4: the Secret may not exist yet; the app must still start.
  it('returns [] for a configured but missing file', () => {
    expect(loadCameras(join(dir, 'does-not-exist.json'))).toEqual([]);
  });

  it('loads a valid list', () => {
    expect(loadCameras(file('ok.json', JSON.stringify([cam1])))).toEqual([cam1]);
  });

  it('fails on malformed JSON, naming the file', () => {
    const p = file('bad.json', '[{');
    expect(() => loadCameras(p)).toThrow(/bad\.json.*not valid JSON/);
  });

  it('fails on a non-array', () => {
    expect(() => loadCameras(file('obj.json', '{}'))).toThrow(/must be a JSON array/);
  });

  it('fails on a missing field, naming entry and field', () => {
    const { password: _omit, ...noPassword } = cam1;
    expect(() => loadCameras(file('nopw.json', JSON.stringify([noPassword])))).toThrow(/entry 0.*password/);
  });

  it('fails on an unsafe id', () => {
    expect(() => loadCameras(file('id.json', JSON.stringify([{ ...cam1, id: 'Cam 1' }])))).toThrow(/entry 0.*id/);
  });

  it('fails on duplicate ids', () => {
    expect(() => loadCameras(file('dup.json', JSON.stringify([cam1, { ...cam1, name: 'Other' }])))).toThrow(/duplicate id "cam1"/);
  });
});

describe('listCameras / getCamera', () => {
  it('exposes only id and name', () => {
    setCameras([cam1]);
    expect(listCameras()).toEqual([{ id: 'cam1', name: 'Den' }]);
    expect(getCamera('cam1')).toEqual(cam1);
    expect(getCamera('nope')).toBeUndefined();
  });
});
```

`test/api.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createApp } from '../server/app';
import { SESSION_COOKIE, signSession } from '../server/session';
import { setCameras } from '../server/cameraRegistry';
import { requireSameOrigin } from '../server/middleware/requireSameOrigin';

const auth = `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`;

afterEach(() => {
  setCameras([]);
  delete process.env.APP_VERSION;
});

describe('/api', () => {
  it('GET /api/me returns the email and version, uncached', async () => {
    process.env.APP_VERSION = '2026.09.26.1';
    const res = await request(createApp()).get('/api/me').set('Cookie', auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ email: 'klaus@klaushofrichter.net', version: '2026.09.26.1' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('GET /api/cameras lists configured cameras without credentials', async () => {
    setCameras([{ id: 'cam1', name: 'Den', host: '10.0.0.5', user: 'cams', password: 'pw' }]);
    const res = await request(createApp()).get('/api/cameras').set('Cookie', auth);
    expect(res.body).toEqual([{ id: 'cam1', name: 'Den' }]);
    expect(JSON.stringify(res.body)).not.toContain('pw');
  });

  it('requires a session', async () => {
    expect((await request(createApp()).get('/api/me')).status).toBe(401);
    expect((await request(createApp()).get('/api/cameras')).status).toBe(401);
  });

  // Review focus 5: unknown API paths answer JSON, never the SPA.
  it('answers unknown /api paths with JSON 404 even when signed in', async () => {
    const res = await request(createApp()).get('/api/nope').set('Cookie', auth);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not found' });
  });
});

describe('requireSameOrigin', () => {
  const app = express();
  app.use(requireSameOrigin);
  app.post('/x', (_req, res) => res.json({ ok: true }));
  app.get('/x', (_req, res) => res.json({ ok: true }));

  it('lets safe methods through regardless of origin', async () => {
    expect((await request(app).get('/x').set('Origin', 'https://evil.example')).status).toBe(200);
  });
  it('rejects a cross-origin POST', async () => {
    const res = await request(app).post('/x').set('Host', 'cams.skylar.technology').set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
  });
  it('accepts a same-origin POST', async () => {
    const res = await request(app).post('/x').set('Host', '127.0.0.1').set('Origin', 'http://127.0.0.1');
    expect(res.status).toBe(200);
  });
  it('accepts a POST without Origin or Referer (non-browser client)', async () => {
    expect((await request(app).post('/x')).status).toBe(200);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/cameraRegistry.test.ts test/api.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`server/middleware/requireSameOrigin.ts`: copy `~/Development/kauf-server/src/middleware/requireSameOrigin.ts` with the comment about `trust proxy` corrected (full file):
```ts
import { Request, Response, NextFunction } from 'express';

// CSRF defence for cookie-authenticated state-changing requests. SameSite=Lax
// already blocks the classic cross-site form POST; this is the server-side
// half, and it holds even if the cookie policy is ever loosened.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

export function requireSameOrigin(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }
  // req.protocol honours X-Forwarded-Proto because `trust proxy` lists the
  // cluster CIDRs (server/trustProxy.ts); without that every POST would look
  // cross-origin (https page vs. http hop).
  const expected = `${req.protocol}://${req.get('host')}`;
  const actual = originOf(req.get('origin')) ?? originOf(req.get('referer'));
  // Browsers attach Origin to every cross-origin POST; a bare request is a
  // non-browser client with no ambient cookie to borrow.
  if (actual !== undefined && actual !== expected) {
    res.status(403).json({ error: 'cross-origin request rejected' });
    return;
  }
  next();
}
```

`server/cameraRegistry.ts`:
```ts
import { existsSync, readFileSync } from 'fs';
import { basename } from 'path';
import { logger } from './logger';

export interface CameraConfig {
  id: string;
  name: string;
  host: string;
  user: string;
  password: string;
}

export interface CameraSummary {
  id: string;
  name: string;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const FIELDS = ['id', 'name', 'host', 'user', 'password'] as const;

let cameras: CameraConfig[] = [];

// The registry comes from the cams-cameras Secret, mounted as a file. A
// configured path that doesn't exist yet (Secret not created) means "no
// cameras" so the app still starts; anything present but wrong fails startup
// with a message naming the problem, never a half-loaded list.
export function loadCameras(file: string | undefined = process.env.CAMERAS_FILE): CameraConfig[] {
  if (!file) return [];
  if (!existsSync(file)) {
    logger.warn({ file: basename(file) }, 'camera registry file not found; no cameras configured');
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`camera registry ${basename(file)} is not valid JSON`);
  }
  if (!Array.isArray(parsed)) throw new Error(`camera registry ${basename(file)} must be a JSON array`);

  const seen = new Set<string>();
  return parsed.map((entry: unknown, i: number) => {
    if (typeof entry !== 'object' || entry === null) throw new Error(`camera registry entry ${i} is not an object`);
    const e = entry as Record<string, unknown>;
    for (const field of FIELDS) {
      if (typeof e[field] !== 'string' || (e[field] as string).length === 0) {
        throw new Error(`camera registry entry ${i}: field "${field}" must be a non-empty string`);
      }
    }
    if (!ID_PATTERN.test(e.id as string)) {
      throw new Error(`camera registry entry ${i}: id must match ${ID_PATTERN}`);
    }
    if (seen.has(e.id as string)) throw new Error(`camera registry: duplicate id "${e.id}"`);
    seen.add(e.id as string);
    return { id: e.id, name: e.name, host: e.host, user: e.user, password: e.password } as CameraConfig;
  });
}

export function setCameras(list: CameraConfig[]): void {
  cameras = list;
}

export function listCameras(): CameraSummary[] {
  return cameras.map(({ id, name }) => ({ id, name }));
}

export function getCamera(id: string): CameraConfig | undefined {
  return cameras.find((c) => c.id === id);
}
```

`server/routes/api.ts`:
```ts
import { Router, Request, Response } from 'express';
import { currentUser, noStore, requireAuthApi } from '../middleware/requireAuth';
import { requireSameOrigin } from '../middleware/requireSameOrigin';
import { createApiRateLimit } from '../middleware/rateLimit';
import { listCameras } from '../cameraRegistry';
import { appVersion } from '../version';

export const apiRouter = Router();

apiRouter.use('/api', createApiRateLimit(), noStore, requireSameOrigin, requireAuthApi);

apiRouter.get('/api/me', (req: Request, res: Response) => {
  res.json({ email: currentUser(req)!.email, version: appVersion() });
});

apiRouter.get('/api/cameras', (_req: Request, res: Response) => {
  res.json(listCameras());
});

// Last on /api: an unknown API path is JSON, never the SPA's HTML.
apiRouter.use('/api', (_req: Request, res: Response) => {
  res.status(404).json({ error: 'not found' });
});
```

In `server/app.ts` add `import { apiRouter } from './routes/api';` and register it after `authRouter`:
```ts
  app.use(authRouter);
  app.use(apiRouter);
```

Replace `server/server.ts` with:
```ts
import { createApp } from './app';
import { assertRequiredEnv } from './config';
import { loadCameras, setCameras } from './cameraRegistry';
import { logger } from './logger';

assertRequiredEnv();
setCameras(loadCameras());
const port = Number(process.env.PORT) || 8080;
createApp().listen(port, () => {
  logger.info({ port }, 'cams listening');
});
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add server test
git commit -m "feat: camera registry, /api/me, /api/cameras, same-origin check"
```

---

### Task 6: Web scaffold: Vite + Svelte, theme tokens, brand mark and icons

**Files:**
- Create: `web/vite.config.ts`, `web/tsconfig.json`, `web/index.html`, `web/app.html`
- Create: `web/src/styles/theme.css`, `web/src/lib/theme.ts`, `web/src/lib/motion.ts`
- Create: `web/public/favicon.svg`, `web/public/site.webmanifest`, `scripts/gen-icons.mjs`
- Generate: `web/public/favicon-32.png`, `web/public/apple-touch-icon.png`, `web/public/icon-512.png`
- Create (stubs, replaced in Tasks 7 and 8): `web/src/landing.ts`, `web/src/main.ts`
- Test: `web/src/lib/theme.test.ts`

**Interfaces:**
- Produces:
  - `Theme = 'light' | 'dark'`, `THEME_KEY = 'cams-theme'`, `currentTheme(): Theme`, `setTheme(t: Theme): void`, `toggleTheme(): Theme` (`web/src/lib/theme.ts`).
  - `prefersReducedMotion(): boolean` and `duration(ms: number): number` (`web/src/lib/motion.ts`).
  - The CSS custom properties `--bg`, `--chrome`, `--surface`, `--surface-2`, `--border`, `--text`, `--muted`, `--accent`, `--accent-2`, `--accent-ink`, `--danger`, `--scroll-thumb`, `--scroll-thumb-hover`, `--scroll-track`, `--shadow`, `--grad`.
  - Build output `dist/web/index.html`, `dist/web/app.html` and `dist/web/assets/*`.

- [ ] **Step 1: Write the failing test `web/src/lib/theme.test.ts`**

```ts
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { THEME_KEY, currentTheme, setTheme, toggleTheme } from './theme';

function stubPrefersLight(light: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('light') ? light : false }));
}

beforeEach(() => {
  delete document.documentElement.dataset.theme;
  localStorage.clear();
  stubPrefersLight(false);
});
afterEach(() => vi.unstubAllGlobals());

describe('theme', () => {
  it('defaults to the system preference', () => {
    expect(currentTheme()).toBe('dark');
    stubPrefersLight(true);
    expect(currentTheme()).toBe('light');
  });

  it('prefers the stored choice over the system', () => {
    stubPrefersLight(true);
    localStorage.setItem(THEME_KEY, 'dark');
    expect(currentTheme()).toBe('dark');
  });

  it('toggles, applies to <html> and persists', () => {
    expect(toggleTheme()).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem(THEME_KEY)).toBe('light');
    expect(toggleTheme()).toBe('dark');
  });

  // Review focus 3: blocked storage must not break theming.
  it('works when localStorage throws', () => {
    const throwing = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    };
    vi.stubGlobal('localStorage', throwing);
    expect(currentTheme()).toBe('dark');
    expect(() => setTheme('light')).not.toThrow();
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run web/src/lib/theme.test.ts`
Expected: FAIL, `Cannot find module './theme'`.

- [ ] **Step 3: Implement the theme module and motion helper**

`web/src/lib/theme.ts`:
```ts
export type Theme = 'light' | 'dark';
export const THEME_KEY = 'cams-theme';

function readStored(): string | null {
  try {
    return localStorage.getItem(THEME_KEY);
  } catch {
    return null;
  }
}

function prefersLight(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches;
}

// Order: explicit attribute (set by the inline bootstrap in the HTML head or
// a previous toggle), then the stored choice, then the system preference.
export function currentTheme(): Theme {
  const attr = document.documentElement.dataset.theme;
  if (attr === 'light' || attr === 'dark') return attr;
  const stored = readStored();
  if (stored === 'light' || stored === 'dark') return stored;
  return prefersLight() ? 'light' : 'dark';
}

export function setTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage blocked (private mode): the choice holds for this page only.
  }
}

export function toggleTheme(): Theme {
  const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
  setTheme(next);
  return next;
}
```

`web/src/lib/motion.ts`:
```ts
export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Svelte transitions don't honour the media query by themselves.
export function duration(ms: number): number {
  return prefersReducedMotion() ? 0 : ms;
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run web/src/lib/theme.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Create the Vite, TS and HTML entry files**

`web/vite.config.ts`:
```ts
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'path';

// Two entries: index.html is the public landing page, app.html the signed-in
// SPA. Express decides which one a request gets (server/routes/pages.ts).
export default defineConfig({
  root: resolve(__dirname),
  plugins: [svelte()],
  build: {
    outDir: resolve(__dirname, '../dist/web'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        app: resolve(__dirname, 'app.html'),
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8080',
      '/auth': 'http://localhost:8080',
    },
  },
});
```

`web/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "types": ["svelte"]
  },
  "include": ["src/**/*.ts", "src/**/*.svelte"]
}
```

`web/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>cams · Skylar Technology</title>
    <meta name="description" content="Private camera viewer by Skylar Technology LLC." />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <link rel="manifest" href="/site.webmanifest" />
    <meta name="theme-color" content="#0B1220" />
    <script>
      try { var t = localStorage.getItem('cams-theme'); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; } catch (e) {}
    </script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/landing.ts"></script>
  </body>
</html>
```

`web/app.html`: identical to `index.html` except the `<title>` is `cams` and the module script is `/src/main.ts`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>cams</title>
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <link rel="manifest" href="/site.webmanifest" />
    <meta name="theme-color" content="#0B1220" />
    <script>
      try { var t = localStorage.getItem('cams-theme'); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; } catch (e) {}
    </script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

Temporary entry stubs so the build runs (replaced in Tasks 7 and 8):

`web/src/landing.ts`:
```ts
import './styles/theme.css';
```

`web/src/main.ts`:
```ts
import './styles/theme.css';
```

- [ ] **Step 6: Create the theme stylesheet `web/src/styles/theme.css`**

```css
/* Midnight Steel. Dark is the default; light applies when chosen, or when the
   system prefers light and nothing was chosen. Every colour in the app comes
   from these tokens, scrollbars included. */
:root {
  color-scheme: dark;
  --bg: #0B1220;
  --chrome: #0F1829;
  --surface: #121C31;
  --surface-2: #16213A;
  --border: #1C2940;
  --text: #E6EDF7;
  --muted: #9FB0CC;
  --accent: #22D3EE;
  --accent-2: #6366F1;
  --accent-ink: #06202A;
  --danger: #EF4444;
  --scroll-track: #0F1829;
  --scroll-thumb: #2A3A5C;
  --scroll-thumb-hover: #3B5082;
  --shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
  --grad: linear-gradient(135deg, var(--accent), var(--accent-2));
  --radius: 10px;
  --font: Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}

:root[data-theme='light'] {
  color-scheme: light;
  --bg: #F5F8FC;
  --chrome: #FFFFFF;
  --surface: #FFFFFF;
  --surface-2: #EEF3FA;
  --border: #D8E1EE;
  --text: #0F1B2D;
  --muted: #55657F;
  --accent: #0891B2;
  --accent-2: #4F46E5;
  --accent-ink: #FFFFFF;
  --danger: #DC2626;
  --scroll-track: #EEF3FA;
  --scroll-thumb: #B9C6D9;
  --scroll-thumb-hover: #93A4BE;
  --shadow: 0 10px 30px rgba(15, 27, 45, 0.12);
}

@media (prefers-color-scheme: light) {
  :root:not([data-theme]) {
    color-scheme: light;
    --bg: #F5F8FC;
    --chrome: #FFFFFF;
    --surface: #FFFFFF;
    --surface-2: #EEF3FA;
    --border: #D8E1EE;
    --text: #0F1B2D;
    --muted: #55657F;
    --accent: #0891B2;
    --accent-2: #4F46E5;
    --accent-ink: #FFFFFF;
    --danger: #DC2626;
    --scroll-track: #EEF3FA;
    --scroll-thumb: #B9C6D9;
    --scroll-thumb-hover: #93A4BE;
    --shadow: 0 10px 30px rgba(15, 27, 45, 0.12);
  }
}

html {
  scrollbar-width: thin;
  scrollbar-color: var(--scroll-thumb) var(--scroll-track);
}
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: var(--scroll-track); }
::-webkit-scrollbar-thumb { background: var(--scroll-thumb); border-radius: 6px; border: 2px solid var(--scroll-track); }
::-webkit-scrollbar-thumb:hover { background: var(--scroll-thumb-hover); }

*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  background: var(--bg);
  color: var(--text);
  font-family: var(--font);
  font-size: 15px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  transition: background-color 0.25s ease, color 0.25s ease;
}
a { color: var(--accent); }
button { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 6px; }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    transition-duration: 0s !important;
    animation-duration: 0s !important;
  }
}
```

- [ ] **Step 7: Create the brand mark, manifest and icon generator**

`web/public/favicon.svg` (the "Lens" mark):
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#22D3EE"/>
      <stop offset="1" stop-color="#6366F1"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="16" fill="url(#g)"/>
  <circle cx="32" cy="32" r="17" fill="#0B1220"/>
  <circle cx="32" cy="32" r="9" fill="none" stroke="#22D3EE" stroke-width="3"/>
  <circle cx="36" cy="28" r="2.6" fill="#E6EDF7"/>
</svg>
```

`web/public/site.webmanifest`:
```json
{
  "name": "cams · Skylar Technology",
  "short_name": "cams",
  "icons": [
    { "src": "/apple-touch-icon.png", "sizes": "180x180", "type": "image/png" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ],
  "theme_color": "#0B1220",
  "background_color": "#0B1220",
  "display": "standalone",
  "start_url": "/app/live"
}
```

`scripts/gen-icons.mjs`:
```js
// Renders the SVG mark to the PNG sizes browsers and iOS ask for. Run with
// `npm run icons` after changing web/public/favicon.svg; outputs are committed.
import { readFileSync, writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';

const svg = readFileSync('web/public/favicon.svg');
for (const [name, size] of [['favicon-32.png', 32], ['apple-touch-icon.png', 180], ['icon-512.png', 512]]) {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
  writeFileSync(`web/public/${name}`, png);
  console.log(`wrote web/public/${name} (${size}px)`);
}
```

Run: `npm run icons`
Expected: three "wrote …" lines; `file web/public/icon-512.png` reports `PNG image data, 512 x 512`.

- [ ] **Step 8: Verify the build**

Run: `npm run build:web && ls dist/web dist/web/assets | head`
Expected: `index.html`, `app.html`, `favicon.svg`, the PNGs, `site.webmanifest` and an `assets/` folder.

- [ ] **Step 9: Commit**

```bash
git add web scripts package.json
git commit -m "feat: Svelte/Vite scaffold, Midnight Steel theme tokens, Lens mark and icons"
```

---

### Task 7: Landing page and page routing on the server

**Files:**
- Create: `web/src/components/Logo.svelte`, `web/src/components/CameraIllustration.svelte`, `web/src/Landing.svelte`
- Modify: `web/src/landing.ts`
- Create: `server/routes/pages.ts`, `test/fixtures/web/index.html`, `test/fixtures/web/app.html`, `test/fixtures/web/favicon.svg`
- Modify: `server/app.ts`
- Test: `test/pages.test.ts`

**Interfaces:**
- Consumes: `currentUser`, `requireAuthPage`, `noStore` (Task 3); `createApiRateLimit` (Task 4).
- Produces:
  - `pagesRouter(webDir: string): Router`.
  - `webDir()` resolves `process.env.WEB_DIST` or `dist/web` next to the compiled server.
  - The `<Logo size={number} />` component. The landing's login link has `data-testid="login"` and `href="/auth/google/login"`.

- [ ] **Step 1: Create test fixtures**

`test/fixtures/web/index.html`:
```html
<!doctype html><html><body>LANDING</body></html>
```
`test/fixtures/web/app.html`:
```html
<!doctype html><html><body>APP</body></html>
```
`test/fixtures/web/favicon.svg`:
```svg
<svg xmlns="http://www.w3.org/2000/svg"/>
```

- [ ] **Step 2: Write the failing test `test/pages.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { resolve } from 'path';
import { createApp } from '../server/app';
import { SESSION_COOKIE, signSession } from '../server/session';

const auth = `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`;

beforeAll(() => {
  process.env.WEB_DIST = resolve(__dirname, 'fixtures/web');
});
afterAll(() => {
  delete process.env.WEB_DIST;
});

describe('pages', () => {
  it('serves the landing page to signed-out visitors', async () => {
    const res = await request(createApp()).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('LANDING');
  });

  it('sends signed-in visitors from / to /app/live', async () => {
    const res = await request(createApp()).get('/').set('Cookie', auth);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/app/live');
  });

  it('serves the app shell for any /app path when signed in, uncached', async () => {
    for (const path of ['/app', '/app/live', '/app/recordings?panel=events', '/app/unknown/deep']) {
      const res = await request(createApp()).get(path).set('Cookie', auth);
      expect(res.status, path).toBe(200);
      expect(res.text).toContain('APP');
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });

  it('redirects signed-out /app requests to / and remembers the path', async () => {
    const res = await request(createApp()).get('/app/settings');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
    expect(res.headers['set-cookie'].join(';')).toContain('return_to=%2Fapp%2Fsettings');
  });

  it('serves static files like the favicon publicly', async () => {
    const res = await request(createApp()).get('/favicon.svg');
    expect(res.status).toBe(200);
  });

  it('does not expose app.html directly', async () => {
    const res = await request(createApp()).get('/app.html');
    expect(res.status).toBe(404);
  });

  // Review focus 5: unknown paths are 404, not the landing page.
  it('answers unknown paths with 404', async () => {
    const res = await request(createApp()).get('/wp-login.php');
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run test/pages.test.ts`
Expected: FAIL (404 for `/`, since no pages router exists yet).

- [ ] **Step 4: Implement `server/routes/pages.ts` and register it**

```ts
import express, { Router, Request, Response } from 'express';
import { join, resolve } from 'path';
import { currentUser, noStore, requireAuthPage } from '../middleware/requireAuth';
import { createApiRateLimit } from '../middleware/rateLimit';

// dist/server/routes -> dist/web in the image; tests point WEB_DIST at fixtures.
export function webDir(): string {
  return process.env.WEB_DIST ?? resolve(__dirname, '../../web');
}

export function pagesRouter(dir: string): Router {
  const router = Router();
  // These handlers read files from disk; CodeQL (js/missing-rate-limiting)
  // requires a limiter in front of them, and it is sensible anyway.
  router.use(createApiRateLimit());

  router.get('/', (req: Request, res: Response) => {
    if (currentUser(req)) {
      res.redirect(302, '/app/live');
      return;
    }
    res.sendFile(join(dir, 'index.html'));
  });

  // Every /app path gets the SPA; its router picks the page (unknown -> Live).
  router.get(['/app', '/app/*splat'], noStore, requireAuthPage, (_req: Request, res: Response) => {
    res.sendFile(join(dir, 'app.html'));
  });

  // Hashed bundles are immutable; everything else (favicon, manifest) revalidates.
  router.use('/assets', express.static(join(dir, 'assets'), { immutable: true, maxAge: '1y', fallthrough: false }));
  router.use((req, res, next) => {
    // The HTML entries are only reachable through the routes above, so the
    // auth decision can't be bypassed by requesting the file.
    if (req.path === '/index.html' || req.path === '/app.html') {
      res.status(404).send('Not found');
      return;
    }
    next();
  });
  router.use(express.static(dir, { index: false }));

  router.use((_req: Request, res: Response) => {
    res.status(404).type('text/plain').send('Not found');
  });
  return router;
}
```

In `server/app.ts` add `import { pagesRouter, webDir } from './routes/pages';` and register it last:
```ts
  app.use(apiRouter);
  app.use(pagesRouter(webDir()));
```

- [ ] **Step 5: Run the server tests**

Run: `npx vitest run`
Expected: all pass.

- [ ] **Step 6: Build the landing page components**

`web/src/components/Logo.svelte`:
```svelte
<script lang="ts">
  let { size = 28 }: { size?: number } = $props();
  const id = `lens-${Math.random().toString(36).slice(2, 8)}`;
</script>

<svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
  <defs>
    <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#22D3EE" />
      <stop offset="1" stop-color="#6366F1" />
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="16" fill="url(#{id})" />
  <circle cx="32" cy="32" r="17" fill="#0B1220" />
  <circle cx="32" cy="32" r="9" fill="none" stroke="#22D3EE" stroke-width="3" />
  <circle cx="36" cy="28" r="2.6" fill="#E6EDF7" />
</svg>
```

`web/src/components/CameraIllustration.svelte`:
```svelte
<!-- Drawn illustration of a turret camera like the RLC-1224A. Our own artwork,
     not a manufacturer product photo. -->
<svg class="cam" viewBox="0 0 210 170" role="img" aria-label="Illustration of the Reolink RLC-1224A turret camera">
  <defs>
    <linearGradient id="cam-body" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#F4F6FA" />
      <stop offset="1" stop-color="#C9D1DE" />
    </linearGradient>
    <radialGradient id="cam-glass" cx=".4" cy=".35">
      <stop offset="0" stop-color="#3B4B6B" />
      <stop offset=".6" stop-color="#0B1220" />
    </radialGradient>
    <radialGradient id="cam-glow" cx=".5" cy=".5">
      <stop offset="0" stop-color="rgba(34,211,238,.45)" />
      <stop offset="1" stop-color="rgba(34,211,238,0)" />
    </radialGradient>
  </defs>
  <circle class="glow" cx="105" cy="95" r="80" fill="url(#cam-glow)" />
  <ellipse cx="105" cy="140" rx="70" ry="12" fill="#AEB8C8" />
  <rect x="45" y="118" width="120" height="22" rx="10" fill="url(#cam-body)" />
  <circle cx="105" cy="82" r="48" fill="url(#cam-body)" />
  <rect x="57" y="92" width="96" height="28" fill="url(#cam-body)" />
  <circle cx="105" cy="84" r="26" fill="url(#cam-glass)" />
  <circle cx="105" cy="84" r="12" fill="#0B1220" stroke="#22D3EE" stroke-width="2" />
  <circle cx="98" cy="77" r="4" fill="rgba(255,255,255,.7)" />
  <circle cx="80" cy="66" r="3" fill="#1F2937" />
  <circle cx="130" cy="66" r="3" fill="#1F2937" />
</svg>

<style>
  .cam { width: min(320px, 80vw); height: auto; filter: drop-shadow(var(--shadow)); }
  .glow { animation: pulse 4s ease-in-out infinite; transform-origin: 105px 95px; }
  @keyframes pulse { 0%, 100% { opacity: 0.7; transform: scale(1); } 50% { opacity: 1; transform: scale(1.06); } }
</style>
```

`web/src/Landing.svelte`:
```svelte
<script lang="ts">
  import Logo from './components/Logo.svelte';
  import CameraIllustration from './components/CameraIllustration.svelte';
  const year = new Date().getFullYear();
</script>

<div class="landing">
  <header class="nav">
    <Logo size={30} />
    <strong>cams</strong>
    <span class="by">by Skylar Technology LLC</span>
  </header>

  <main class="hero">
    <section class="copy">
      <h1>Your cameras,<br /><span class="grad">live and on record.</span></h1>
      <p>
        cams is Skylar Technology's private viewer for our Reolink security cameras: live video, a timeline of every
        recorded event with AI detection of people, vehicles and pets, clip downloads and camera settings, from any
        browser.
      </p>
      <a class="login" href="/auth/google/login" data-testid="login">
        <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
          <path fill="currentColor" d="M24 9.5c3.5 0 6.6 1.2 9 3.5l6.7-6.7C35.6 2.4 30.1 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.8 6C12.4 13.6 17.7 9.5 24 9.5z" />
          <path fill="currentColor" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.5 5.8c4.4-4 6.8-10 6.8-17.2z" />
          <path fill="currentColor" d="M10.5 28.7a14.4 14.4 0 0 1 0-9.4l-7.8-6A24 24 0 0 0 0 24c0 3.9.9 7.5 2.7 10.7l7.8-6z" />
          <path fill="currentColor" d="M24 48c6.1 0 11.3-2 15-5.5l-7.5-5.8c-2 1.4-4.6 2.3-7.5 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.8 6C6.6 42.6 14.6 48 24 48z" />
        </svg>
        Sign in with Google
      </a>
      <ul class="chips">
        <li>● Live view</li>
        <li>◷ Timeline playback</li>
        <li>⚑ AI events</li>
        <li>⤓ Downloads</li>
      </ul>
    </section>
    <CameraIllustration />
  </main>

  <footer>© {year} Skylar Technology LLC · Private system, authorised account only</footer>
</div>

<style>
  .landing {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    background:
      radial-gradient(1200px 400px at 80% -10%, color-mix(in srgb, var(--accent-2) 35%, transparent), transparent 60%),
      radial-gradient(900px 400px at 0% 110%, color-mix(in srgb, var(--accent) 20%, transparent), transparent 60%),
      var(--bg);
  }
  .nav { display: flex; align-items: center; gap: 10px; padding: 18px 28px; font-size: 18px; }
  .by { font-size: 13px; color: var(--muted); }
  .hero {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 56px;
    padding: 24px 28px 48px;
    flex-wrap: wrap;
  }
  .copy { max-width: 520px; animation: rise 0.6s ease-out both; }
  h1 { font-size: clamp(32px, 5vw, 48px); line-height: 1.1; margin: 0 0 14px; letter-spacing: -0.02em; }
  .grad { background: var(--grad); -webkit-background-clip: text; background-clip: text; color: transparent; }
  p { color: var(--muted); font-size: 16px; margin: 0 0 22px; }
  .login {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    padding: 12px 20px;
    border-radius: 12px;
    background: var(--accent);
    color: var(--accent-ink);
    font-weight: 700;
    text-decoration: none;
    box-shadow: 0 8px 24px color-mix(in srgb, var(--accent) 35%, transparent);
    transition: transform 0.15s ease, box-shadow 0.15s ease;
  }
  .login:hover { transform: translateY(-1px); box-shadow: 0 12px 28px color-mix(in srgb, var(--accent) 45%, transparent); }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; list-style: none; padding: 0; margin: 20px 0 0; }
  .chips li {
    font-size: 12px;
    padding: 4px 11px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--text) 6%, transparent);
    border: 1px solid var(--border);
    color: var(--muted);
  }
  footer { padding: 14px 28px; font-size: 12px; color: var(--muted); border-top: 1px solid var(--border); }
  @keyframes rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
</style>
```

Replace `web/src/landing.ts`:
```ts
import './styles/theme.css';
import { mount } from 'svelte';
import Landing from './Landing.svelte';

mount(Landing, { target: document.getElementById('root')! });
```

- [ ] **Step 7: Verify the build, type check and real server**

Run:
```bash
npm run build && npm run check
COOKIE_SECRET=x GOOGLE_CLIENT_ID=x GOOGLE_CLIENT_SECRET=x GOOGLE_REDIRECT_URI=http://localhost:8080/auth/google/callback ALLOWED_EMAILS=klaus@klaushofrichter.net PORT=8080 node dist/server/server.js &
sleep 1; curl -s localhost:8080/ | grep -c 'id="root"'; curl -s -o /dev/null -w '%{http_code}\n' localhost:8080/app/live; kill %1
```
Expected: `svelte-check` reports 0 errors and 0 warnings; `1`; `302`.

- [ ] **Step 8: Commit**

```bash
git add server web test
git commit -m "feat: landing page and server-side page routing"
```

---

### Task 8: App shell: router, stores, top bar, sidebar, drawer and placeholder pages

**Files:**
- Create: `web/src/lib/router.ts`, `web/src/lib/stores.ts`, `web/src/lib/api.ts`, `web/src/lib/icons.ts`
- Create: `web/src/components/Icon.svelte`, `web/src/components/TopBar.svelte`, `web/src/components/Sidebar.svelte`, `web/src/components/CameraPicker.svelte`, `web/src/components/ThemeToggle.svelte`
- Create: `web/src/pages/Live.svelte`, `web/src/pages/Recordings.svelte`, `web/src/pages/Settings.svelte`, `web/src/pages/About.svelte`, `web/src/App.svelte`
- Modify: `web/src/main.ts`
- Test: `web/src/lib/router.test.ts`, `web/src/lib/stores.test.ts`

**Interfaces:**
- Consumes: `/api/me` → `{email, version}`, `/api/cameras` → `CameraSummary[]` (Task 5); `toggleTheme`, `currentTheme` (Task 6); `duration` (Task 6); `Logo` (Task 7).
- Produces (Plans 2–4 build on these names):
  - `Page = 'live' | 'recordings' | 'settings' | 'about'`, `Panel = 'history' | 'events' | 'downloads'`, `Route = { page: Page; panel: Panel; params: URLSearchParams }`.
  - `parseRoute(pathname, search): Route`, `NAV_ITEMS: NavItem[]`, `isActive(item, route): boolean`.
  - `route: Readable<Route>`, `navigate(href: string): void`, `initRouter(): () => void`.
  - The stores `sidebarCollapsed`, `drawerOpen`, `me`, `cameras`, `selectedCameraId`, and `persistedBoolean(key, initial)`.
  - `getJson<T>(url): Promise<T>` and `UnauthorizedError`.
  - These `data-testid`s:
    - `topbar`, `hamburger`, `camera-picker`, `version-link`, `theme-toggle`, `logout`
    - `sidebar`, `sidebar-toggle`, `drawer`, `nav-<id>`
    - `page-title`, `panel-tab-<panel>`

- [ ] **Step 1: Write the failing tests**

`web/src/lib/router.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { NAV_ITEMS, isActive, parseRoute } from './router';

describe('parseRoute', () => {
  it.each([
    ['/app/live', '', 'live'],
    ['/app/recordings', '', 'recordings'],
    ['/app/settings', '', 'settings'],
    ['/app/about', '', 'about'],
    ['/app', '', 'live'],
    ['/app/', '', 'live'],
    // Review focus 5: unknown pages fall back to Live, never a blank shell.
    ['/app/nope', '', 'live'],
    ['/app/recordings/extra', '', 'recordings'],
  ])('%s -> %s', (path, search, page) => {
    expect(parseRoute(path, search).page).toBe(page);
  });

  it('reads the recordings panel, defaulting to history', () => {
    expect(parseRoute('/app/recordings', '?panel=events').panel).toBe('events');
    expect(parseRoute('/app/recordings', '?panel=downloads').panel).toBe('downloads');
    expect(parseRoute('/app/recordings', '?panel=bogus').panel).toBe('history');
    expect(parseRoute('/app/recordings', '').panel).toBe('history');
  });

  it('keeps other query params for later plans', () => {
    expect(parseRoute('/app/recordings', '?cam=cam1&t=x').params.get('cam')).toBe('cam1');
  });
});

describe('navigation items', () => {
  it('lists the six menu entries in order', () => {
    expect(NAV_ITEMS.map((i) => i.label)).toEqual(['Live', 'History', 'Events', 'Downloads', 'Settings', 'About']);
  });

  it('points History, Events and Downloads at the recordings workspace panels', () => {
    const hrefs = Object.fromEntries(NAV_ITEMS.map((i) => [i.id, i.href]));
    expect(hrefs.history).toBe('/app/recordings?panel=history');
    expect(hrefs.events).toBe('/app/recordings?panel=events');
    expect(hrefs.downloads).toBe('/app/recordings?panel=downloads');
  });

  it('marks exactly one item active', () => {
    const r = parseRoute('/app/recordings', '?panel=events');
    expect(NAV_ITEMS.filter((i) => isActive(i, r)).map((i) => i.id)).toEqual(['events']);
    const live = parseRoute('/app/live', '');
    expect(NAV_ITEMS.filter((i) => isActive(i, live)).map((i) => i.id)).toEqual(['live']);
  });
});
```

`web/src/lib/stores.test.ts`:
```ts
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { persistedBoolean } from './stores';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('persistedBoolean', () => {
  it('starts from the initial value and persists changes', () => {
    const s = persistedBoolean('k1', false);
    expect(get(s)).toBe(false);
    s.set(true);
    expect(localStorage.getItem('k1')).toBe('1');
    expect(get(persistedBoolean('k1', false))).toBe(true);
  });

  // Review focus 3: blocked storage falls back to the initial value.
  it('falls back to the initial value when storage throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    });
    const s = persistedBoolean('k2', false);
    expect(get(s)).toBe(false);
    expect(() => s.set(true)).not.toThrow();
    expect(get(s)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run web/src/lib`
Expected: FAIL, `Cannot find module './router'` and `'./stores'`.

- [ ] **Step 3: Implement the libs**

`web/src/lib/icons.ts`:
```ts
// 24x24 stroke icons (outline style). One path string per icon.
export const ICONS = {
  live: 'M5 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm12 5 4-3v10l-4-3',
  history: 'M12 7v5l3 2M3 12a9 9 0 1 0 3-6.7M3 4v4h4',
  events: 'M5 21V4m0 0h11l-2 4 2 4H5',
  downloads: 'M12 4v11m0 0-4-4m4 4 4-4M5 20h14',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7.4-3a7.4 7.4 0 0 0-.1-1.3l2-1.6-2-3.4-2.4 1a7.4 7.4 0 0 0-2.2-1.3L14.3 3h-4l-.4 2.4a7.4 7.4 0 0 0-2.2 1.3l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.6l-2 1.6 2 3.4 2.4-1a7.4 7.4 0 0 0 2.2 1.3l.4 2.4h4l.4-2.4a7.4 7.4 0 0 0 2.2-1.3l2.4 1 2-3.4-2-1.6c.1-.4.1-.9.1-1.3z',
  about: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm0-5v-5m0-3h.01',
  menu: 'M4 7h16M4 12h16M4 17h16',
  close: 'M6 6l12 12M18 6 6 18',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0-15v2m0 16v2M4.2 4.2l1.4 1.4m12.8 12.8 1.4 1.4M2 12h2m16 0h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  logout: 'M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5m5 5H3',
  chevron: 'M15 6l-6 6 6 6',
} as const;

export type IconName = keyof typeof ICONS;
```

`web/src/lib/router.ts`:
```ts
import { writable, type Readable } from 'svelte/store';
import type { IconName } from './icons';

export type Page = 'live' | 'recordings' | 'settings' | 'about';
export type Panel = 'history' | 'events' | 'downloads';

export interface Route {
  page: Page;
  panel: Panel;
  params: URLSearchParams;
}

export interface NavItem {
  id: string;
  label: string;
  icon: IconName;
  href: string;
  page: Page;
  panel?: Panel;
}

const PAGES: Page[] = ['live', 'recordings', 'settings', 'about'];
const PANELS: Panel[] = ['history', 'events', 'downloads'];

export function parseRoute(pathname: string, search: string): Route {
  const params = new URLSearchParams(search);
  const segment = pathname.replace(/^\/app\/?/, '').split('/')[0];
  const page = (PAGES as string[]).includes(segment) ? (segment as Page) : 'live';
  const rawPanel = params.get('panel') ?? '';
  const panel = (PANELS as string[]).includes(rawPanel) ? (rawPanel as Panel) : 'history';
  return { page, panel, params };
}

// History, Events and Downloads are three doors into one Recordings
// workspace; the panel decides which side panel is open.
export const NAV_ITEMS: NavItem[] = [
  { id: 'live', label: 'Live', icon: 'live', href: '/app/live', page: 'live' },
  { id: 'history', label: 'History', icon: 'history', href: '/app/recordings?panel=history', page: 'recordings', panel: 'history' },
  { id: 'events', label: 'Events', icon: 'events', href: '/app/recordings?panel=events', page: 'recordings', panel: 'events' },
  { id: 'downloads', label: 'Downloads', icon: 'downloads', href: '/app/recordings?panel=downloads', page: 'recordings', panel: 'downloads' },
  { id: 'settings', label: 'Settings', icon: 'settings', href: '/app/settings', page: 'settings' },
  { id: 'about', label: 'About', icon: 'about', href: '/app/about', page: 'about' },
];

export function isActive(item: NavItem, route: Route): boolean {
  if (item.page !== route.page) return false;
  return item.panel === undefined || item.panel === route.panel;
}

const store = writable<Route>(parseRoute('/app/live', ''));
export const route: Readable<Route> = { subscribe: store.subscribe };

function sync(): void {
  store.set(parseRoute(location.pathname, location.search));
}

export function navigate(href: string): void {
  if (href === location.pathname + location.search) return;
  history.pushState({}, '', href);
  sync();
}

export function initRouter(): () => void {
  sync();
  addEventListener('popstate', sync);
  return () => removeEventListener('popstate', sync);
}
```

`web/src/lib/stores.ts`:
```ts
import { writable, type Writable } from 'svelte/store';

export interface Me {
  email: string;
  version: string;
}

export interface CameraSummary {
  id: string;
  name: string;
}

// A boolean kept in localStorage. Storage failures (private mode) degrade to
// an in-memory value rather than breaking the page.
export function persistedBoolean(key: string, initial: boolean): Writable<boolean> {
  let start = initial;
  try {
    const stored = localStorage.getItem(key);
    if (stored === '1' || stored === '0') start = stored === '1';
  } catch {
    // keep initial
  }
  const store = writable(start);
  store.subscribe((value) => {
    try {
      localStorage.setItem(key, value ? '1' : '0');
    } catch {
      // not persisted this session
    }
  });
  return store;
}

export const sidebarCollapsed = persistedBoolean('cams-sidebar-collapsed', false);
export const drawerOpen = writable(false);
export const me = writable<Me | null>(null);
export const cameras = writable<CameraSummary[]>([]);
export const selectedCameraId = writable<string | null>(null);
```

`web/src/lib/api.ts`:
```ts
export class UnauthorizedError extends Error {}

// Session gone (expired, or the allow-list changed): back to the landing page.
export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
  if (res.status === 401) {
    location.assign('/');
    throw new UnauthorizedError(url);
  }
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
  return (await res.json()) as T;
}
```

- [ ] **Step 4: Run the lib tests**

Run: `npx vitest run web/src/lib`
Expected: all pass.

- [ ] **Step 5: Build the components**

`web/src/components/Icon.svelte`:
```svelte
<script lang="ts">
  import { ICONS, type IconName } from '../lib/icons';
  let { name, size = 20 }: { name: IconName; size?: number } = $props();
</script>

<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d={ICONS[name]} />
</svg>
```

`web/src/components/ThemeToggle.svelte`:
```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from './Icon.svelte';
  import { currentTheme, toggleTheme, type Theme } from '../lib/theme';

  let theme = $state<Theme>('dark');
  onMount(() => { theme = currentTheme(); });
</script>

<button
  class="icon-btn"
  data-testid="theme-toggle"
  onclick={() => (theme = toggleTheme())}
  aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
  title={theme === 'dark' ? 'Light theme' : 'Dark theme'}
>
  <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
</button>

<style>
  .icon-btn {
    width: 36px; height: 36px; display: grid; place-items: center;
    border-radius: 10px; border: 1px solid var(--border); background: var(--surface-2);
    cursor: pointer; transition: background-color 0.15s ease, transform 0.15s ease;
  }
  .icon-btn:hover { background: color-mix(in srgb, var(--accent) 14%, var(--surface-2)); }
  .icon-btn:active { transform: scale(0.95); }
</style>
```

`web/src/components/CameraPicker.svelte`:
```svelte
<script lang="ts">
  import { cameras, selectedCameraId } from '../lib/stores';
</script>

<label class="picker">
  <span class="sr-only">Camera</span>
  <select data-testid="camera-picker" bind:value={$selectedCameraId} disabled={$cameras.length === 0}>
    {#if $cameras.length === 0}
      <option value={null}>No cameras</option>
    {:else}
      {#each $cameras as cam (cam.id)}
        <option value={cam.id}>{cam.name}</option>
      {/each}
    {/if}
  </select>
</label>

<style>
  select {
    appearance: none; font: inherit; font-size: 14px; color: var(--text);
    background: var(--surface-2) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%239FB0CC' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E") no-repeat right 10px center;
    border: 1px solid var(--border); border-radius: 10px; padding: 7px 30px 7px 12px; cursor: pointer;
  }
  select:disabled { opacity: 0.6; cursor: default; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
</style>
```

`web/src/components/TopBar.svelte`:
```svelte
<script lang="ts">
  import Logo from './Logo.svelte';
  import Icon from './Icon.svelte';
  import CameraPicker from './CameraPicker.svelte';
  import ThemeToggle from './ThemeToggle.svelte';
  import { me, drawerOpen } from '../lib/stores';

  const REPO_URL = 'https://github.com/klaushofrichter/cams';
</script>

<header class="topbar" data-testid="topbar">
  <button class="hamburger" data-testid="hamburger" aria-label="Open menu" aria-expanded={$drawerOpen} onclick={() => drawerOpen.set(true)}>
    <Icon name="menu" />
  </button>
  <a class="brand" href="/app/live" aria-label="cams home"><Logo size={28} /><span>cams</span></a>
  <CameraPicker />
  <div class="spacer"></div>
  {#if $me}
    <a class="version" data-testid="version-link" href={REPO_URL} target="_blank" rel="noopener noreferrer" title="cams on GitHub">{$me.version}</a>
  {/if}
  <div class="desktop-only"><ThemeToggle /></div>
  <a class="logout desktop-only" data-testid="logout" href="/auth/logout"><Icon name="logout" size={18} /><span>Logout</span></a>
</header>

<style>
  .topbar {
    grid-area: top; display: flex; align-items: center; gap: 12px; padding: 10px 16px;
    background: var(--chrome); border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 20;
  }
  .brand { display: flex; align-items: center; gap: 9px; color: var(--text); text-decoration: none; font-weight: 700; font-size: 17px; letter-spacing: 0.01em; }
  .spacer { flex: 1; }
  .version {
    font-family: var(--mono); font-size: 12px; color: var(--muted); text-decoration: none; opacity: 0.6;
    transition: opacity 0.15s ease, color 0.15s ease;
  }
  .version:hover { opacity: 1; color: var(--accent); text-decoration: underline; }
  .logout {
    display: inline-flex; align-items: center; gap: 6px; padding: 7px 14px; border-radius: 10px;
    background: var(--grad); color: #fff; font-weight: 600; font-size: 14px; text-decoration: none;
    transition: filter 0.15s ease, transform 0.15s ease;
  }
  .logout:hover { filter: brightness(1.1); transform: translateY(-1px); }
  .hamburger { display: none; width: 36px; height: 36px; place-items: center; border: 0; background: transparent; cursor: pointer; border-radius: 10px; }
  @media (max-width: 767px) {
    .hamburger { display: grid; }
    .desktop-only { display: none; }
    .brand span { display: none; }
  }
</style>
```

`web/src/components/Sidebar.svelte`:
```svelte
<script lang="ts">
  import Icon from './Icon.svelte';
  import ThemeToggle from './ThemeToggle.svelte';
  import { NAV_ITEMS, isActive, navigate, route } from '../lib/router';
  import { sidebarCollapsed, drawerOpen } from '../lib/stores';

  // `drawer` renders the same menu inside the phone drawer, always expanded,
  // with theme and logout added (the top bar hides them on phones).
  let { drawer = false }: { drawer?: boolean } = $props();
  const collapsed = $derived($sidebarCollapsed && !drawer);

  function go(event: MouseEvent, href: string) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    navigate(href);
    drawerOpen.set(false);
  }
</script>

<nav class="sidebar" class:collapsed class:drawer data-testid={drawer ? 'drawer' : 'sidebar'} aria-label="Main">
  {#each NAV_ITEMS as item (item.id)}
    {@const active = isActive(item, $route)}
    <a
      href={item.href}
      class="item"
      class:active
      data-testid={`nav-${item.id}`}
      aria-current={active ? 'page' : undefined}
      title={collapsed ? item.label : undefined}
      onclick={(e) => go(e, item.href)}
    >
      <Icon name={item.icon} />
      <span class="label">{item.label}</span>
    </a>
  {/each}
  <div class="grow"></div>
  {#if drawer}
    <div class="drawer-actions">
      <ThemeToggle />
      <a class="item" data-testid="logout" href="/auth/logout"><Icon name="logout" /><span class="label">Logout</span></a>
    </div>
  {:else}
    <button
      class="item collapse"
      data-testid="sidebar-toggle"
      aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      aria-expanded={!collapsed}
      onclick={() => sidebarCollapsed.update((v) => !v)}
    >
      <span class="chev" class:flipped={collapsed}><Icon name="chevron" /></span>
      <span class="label">Collapse</span>
    </button>
  {/if}
</nav>

<style>
  .sidebar {
    width: 220px; height: 100%; display: flex; flex-direction: column; gap: 4px; padding: 12px 10px;
    background: var(--chrome); border-right: 1px solid var(--border); overflow: hidden;
    transition: width 0.22s cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  .sidebar.collapsed { width: 64px; }
  .sidebar.drawer { width: 260px; border-right: 0; }
  .item {
    display: flex; align-items: center; gap: 12px; padding: 9px 12px; border-radius: 10px;
    color: var(--muted); text-decoration: none; white-space: nowrap; border: 0; background: transparent;
    cursor: pointer; font-size: 14.5px; text-align: left; position: relative;
    transition: background-color 0.15s ease, color 0.15s ease;
  }
  .item:hover { background: var(--surface-2); color: var(--text); }
  .item.active {
    color: var(--text);
    background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 18%, transparent), color-mix(in srgb, var(--accent-2) 10%, transparent));
    box-shadow: inset 3px 0 0 var(--accent);
  }
  .label { transition: opacity 0.15s ease; }
  .collapsed .label { opacity: 0; pointer-events: none; }
  .grow { flex: 1; }
  .chev { display: inline-grid; transition: transform 0.22s ease; }
  .chev.flipped { transform: rotate(180deg); }
  .drawer-actions { display: flex; align-items: center; gap: 8px; padding-top: 8px; border-top: 1px solid var(--border); }
</style>
```

`web/src/pages/Live.svelte`:
```svelte
<section class="page">
  <h1 data-testid="page-title">Live</h1>
  <div class="placeholder">Live video arrives in the next release.</div>
</section>
```

`web/src/pages/Recordings.svelte`:
```svelte
<script lang="ts">
  import { navigate, route, type Panel } from '../lib/router';
  const TABS: { id: Panel; label: string }[] = [
    { id: 'history', label: 'History' },
    { id: 'events', label: 'Events' },
    { id: 'downloads', label: 'Downloads' },
  ];
</script>

<section class="page">
  <h1 data-testid="page-title">Recordings</h1>
  <div class="tabs" role="tablist">
    {#each TABS as tab (tab.id)}
      <button
        role="tab"
        data-testid={`panel-tab-${tab.id}`}
        aria-selected={$route.panel === tab.id}
        class:on={$route.panel === tab.id}
        onclick={() => navigate(`/app/recordings?panel=${tab.id}`)}>{tab.label}</button>
    {/each}
  </div>
  <div class="placeholder">The recordings workspace arrives in a later release.</div>
</section>

<style>
  .tabs { display: flex; gap: 6px; margin-bottom: 16px; }
  .tabs button { padding: 6px 14px; border-radius: 9px; border: 1px solid var(--border); background: transparent; color: var(--muted); cursor: pointer; }
  .tabs button.on { background: var(--surface-2); color: var(--text); border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
</style>
```

`web/src/pages/Settings.svelte`:
```svelte
<section class="page">
  <h1 data-testid="page-title">Settings</h1>
  <div class="placeholder">Settings arrive in a later release.</div>
</section>
```

`web/src/pages/About.svelte`:
```svelte
<script lang="ts">
  import { me } from '../lib/stores';
</script>

<section class="page">
  <h1 data-testid="page-title">About</h1>
  <div class="card">
    <p><strong>cams</strong> by Skylar Technology LLC: a private viewer for our Reolink security cameras.</p>
    <p>Version <code data-testid="about-version">{$me?.version ?? '…'}</code></p>
    <p><a href="https://github.com/klaushofrichter/cams" target="_blank" rel="noopener noreferrer">Source on GitHub</a></p>
  </div>
</section>
```

`web/src/App.svelte`:
```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import { fly, fade } from 'svelte/transition';
  import TopBar from './components/TopBar.svelte';
  import Sidebar from './components/Sidebar.svelte';
  import Icon from './components/Icon.svelte';
  import Live from './pages/Live.svelte';
  import Recordings from './pages/Recordings.svelte';
  import Settings from './pages/Settings.svelte';
  import About from './pages/About.svelte';
  import { initRouter, route } from './lib/router';
  import { cameras, drawerOpen, me, selectedCameraId, type CameraSummary, type Me } from './lib/stores';
  import { getJson, UnauthorizedError } from './lib/api';
  import { duration } from './lib/motion';

  let loadError = $state('');

  async function load() {
    try {
      const [profile, list] = await Promise.all([getJson<Me>('/api/me'), getJson<CameraSummary[]>('/api/cameras')]);
      me.set(profile);
      cameras.set(list);
      selectedCameraId.update((id) => (list.some((c) => c.id === id) ? id : (list[0]?.id ?? null)));
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) loadError = 'Could not load the app. Please reload the page.';
    }
  }

  onMount(() => {
    const stop = initRouter();
    void load();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') drawerOpen.set(false); };
    addEventListener('keydown', onKey);
    return () => { stop(); removeEventListener('keydown', onKey); };
  });
</script>

<div class="shell">
  <TopBar />
  <div class="side"><Sidebar /></div>
  <main class="main">
    {#if loadError}<div class="error" role="alert">{loadError}</div>{/if}
    {#key $route.page}
      <div class="page-wrap" in:fly={{ y: 8, duration: duration(180) }}>
        {#if $route.page === 'recordings'}<Recordings />
        {:else if $route.page === 'settings'}<Settings />
        {:else if $route.page === 'about'}<About />
        {:else}<Live />{/if}
      </div>
    {/key}
  </main>

  {#if $drawerOpen}
    <button class="backdrop" aria-label="Close menu" transition:fade={{ duration: duration(150) }} onclick={() => drawerOpen.set(false)}></button>
    <div class="drawer-panel" transition:fly={{ x: -280, duration: duration(220) }}>
      <button class="close" aria-label="Close menu" onclick={() => drawerOpen.set(false)}><Icon name="close" /></button>
      <Sidebar drawer />
    </div>
  {/if}
</div>

<style>
  .shell {
    height: 100vh; display: grid;
    grid-template-columns: auto 1fr; grid-template-rows: auto 1fr;
    grid-template-areas: 'top top' 'side main';
  }
  .side { grid-area: side; min-height: 0; }
  .main { grid-area: main; overflow: auto; padding: 24px 28px; min-width: 0; }
  :global(.page h1) { margin: 0 0 16px; font-size: 24px; letter-spacing: -0.01em; }
  :global(.placeholder), :global(.card) {
    padding: 28px; border-radius: 14px; background: var(--surface); border: 1px solid var(--border);
    color: var(--muted); box-shadow: var(--shadow);
  }
  .error { padding: 12px 16px; margin-bottom: 16px; border-radius: 10px; background: color-mix(in srgb, var(--danger) 15%, transparent); color: var(--text); }
  .backdrop { position: fixed; inset: 0; background: rgba(3, 8, 18, 0.55); border: 0; z-index: 30; }
  .drawer-panel { position: fixed; top: 0; bottom: 0; left: 0; z-index: 31; background: var(--chrome); box-shadow: var(--shadow); padding-top: 48px; }
  .close { position: absolute; top: 10px; right: 10px; width: 36px; height: 36px; display: grid; place-items: center; border: 0; background: transparent; cursor: pointer; }
  @media (max-width: 767px) {
    .shell { grid-template-columns: 1fr; grid-template-areas: 'top' 'main'; }
    .side { display: none; }
    .main { padding: 16px; }
  }
</style>
```

Replace `web/src/main.ts`:
```ts
import './styles/theme.css';
import { mount } from 'svelte';
import App from './App.svelte';

mount(App, { target: document.getElementById('root')! });
```

- [ ] **Step 6: Build and type-check**

Run: `npm run build && npm run check && npx vitest run`
Expected: build succeeds; svelte-check 0 errors, 0 warnings; all unit tests pass.

- [ ] **Step 7: Commit**

```bash
git add web
git commit -m "feat: app shell with router, collapsible sidebar, phone drawer and placeholder pages"
```

---

### Task 9: End-to-end suite at desktop and phone sizes

**Files:**
- Create: `playwright.config.ts`, `e2e/env.ts`, `e2e/session.ts`, `e2e/cameras.json`, `e2e/landing.spec.ts`, `e2e/shell.spec.ts`

**Interfaces:**
- Consumes: every `data-testid` from Task 8, the landing `login` link (Task 7), `/api/*` (Task 5).
- Produces: the `E2E_ENV` constants, `signIn(context, baseURL)`, and Playwright projects `desktop` (1440×900) and `phone` (390×844).

- [ ] **Step 1: Create config and helpers**

`e2e/env.ts`:
```ts
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
```

`e2e/cameras.json`:
```json
[{ "id": "cam1", "name": "Den", "host": "127.0.0.1", "user": "e2e", "password": "e2e-not-a-real-password" }]
```

`e2e/session.ts`:
```ts
import type { BrowserContext } from '@playwright/test';
import jwt from 'jsonwebtoken';
import { E2E_ENV } from './env';

// Signs a session exactly like server/session.ts, so signed-in specs need no
// Google round trip. The app has no test-only login route.
export async function signIn(context: BrowserContext, baseURL: string): Promise<void> {
  const email = E2E_ENV.ALLOWED_EMAILS.split(',')[0].trim();
  await context.addCookies([
    {
      name: 'session',
      value: jwt.sign({ email }, E2E_ENV.COOKIE_SECRET, { expiresIn: '10m' }),
      domain: new URL(baseURL).hostname,
      path: '/',
      httpOnly: true,
      secure: false, // http://localhost
      sameSite: 'Lax',
    },
  ]);
}
```

`playwright.config.ts`:
```ts
import { defineConfig, devices } from '@playwright/test';
import { E2E_ENV, E2E_PORT } from './e2e/env';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL: `http://localhost:${E2E_PORT}`,
    timezoneId: 'America/Chicago',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'phone', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, hasTouch: true } },
  ],
  // Requires `npm run build` first; runs the production server.
  webServer: {
    command: 'npm start',
    port: E2E_PORT,
    reuseExistingServer: !process.env.CI,
    env: E2E_ENV,
  },
});
```

- [ ] **Step 2: Write `e2e/landing.spec.ts`**

```ts
import { expect, test } from '@playwright/test';
import { signIn } from './session';

test.describe('landing page', () => {
  test('shows branding, the camera illustration and the Google login', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Your cameras');
    await expect(page.getByText('Skylar Technology LLC').first()).toBeVisible();
    await expect(page.getByRole('img', { name: /RLC-1224A/ })).toBeVisible();
    const login = page.getByTestId('login');
    await expect(login).toHaveAttribute('href', '/auth/google/login');
  });

  test('login starts the Google flow', async ({ request }) => {
    const res = await request.get('/auth/google/login', { maxRedirects: 0 });
    expect(res.status()).toBe(302);
    expect(res.headers().location).toContain('https://accounts.google.com/o/oauth2/v2/auth');
  });

  test('has a favicon', async ({ request }) => {
    expect((await request.get('/favicon.svg')).status()).toBe(200);
  });
});

test.describe('auth boundaries', () => {
  test('signed-out app pages go back to the landing page', async ({ page }) => {
    await page.goto('/app/settings');
    await expect(page).toHaveURL('/');
  });

  test('signed-out API calls get 401 JSON', async ({ request }) => {
    const res = await request.get('/api/me');
    expect(res.status()).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  test('signed-in visitors skip the landing page', async ({ page, context, baseURL }) => {
    await signIn(context, baseURL!);
    await page.goto('/');
    await expect(page).toHaveURL('/app/live');
    await expect(page.getByTestId('page-title')).toHaveText('Live');
  });

  test('logout returns to the landing page and locks the app', async ({ page, context, baseURL }, testInfo) => {
    await signIn(context, baseURL!);
    await page.goto('/app/live');
    if (testInfo.project.name === 'phone') {
      await page.getByTestId('hamburger').click();
      await page.getByTestId('drawer').getByTestId('logout').click();
    } else {
      await page.getByTestId('logout').click();
    }
    await expect(page).toHaveURL('/');
    await page.goto('/app/live');
    await expect(page).toHaveURL('/');
  });
});
```

- [ ] **Step 3: Write `e2e/shell.spec.ts`**

```ts
import { expect, test } from '@playwright/test';
import { signIn } from './session';

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL!);
});

test('top bar shows the version linking to GitHub and the camera picker', async ({ page }) => {
  await page.goto('/app/live');
  const version = page.getByTestId('version-link');
  await expect(version).toHaveText('e2e-test-version');
  await expect(version).toHaveAttribute('href', 'https://github.com/klaushofrichter/cams');
  await expect(page.getByTestId('camera-picker')).toHaveValue('cam1');
  await expect(page.getByTestId('camera-picker').locator('option')).toHaveText(['Den']);
});

test('theme toggle switches colours and scrollbars, and persists', async ({ page }, testInfo) => {
  await page.goto('/app/live');
  const read = () =>
    page.evaluate(() => ({
      theme: document.documentElement.dataset.theme ?? null,
      bg: getComputedStyle(document.body).backgroundColor,
      scrollbar: getComputedStyle(document.documentElement).scrollbarColor,
    }));
  const before = await read();
  if (testInfo.project.name === 'phone') {
    await page.getByTestId('hamburger').click();
    await page.getByTestId('drawer').getByTestId('theme-toggle').click();
  } else {
    await page.getByTestId('theme-toggle').click();
  }
  await expect.poll(async () => (await read()).theme).toBe('light');
  const after = await read();
  expect(after.bg).not.toBe(before.bg);
  expect(after.scrollbar).not.toBe(before.scrollbar);
  await page.reload();
  expect((await read()).theme).toBe('light');
});

test('navigation reaches every page and keeps the URL in sync', async ({ page }, testInfo) => {
  await page.goto('/app/live');
  const open = async (id: string) => {
    if (testInfo.project.name === 'phone') {
      await page.getByTestId('hamburger').click();
      await page.getByTestId('drawer').getByTestId(`nav-${id}`).click();
      await expect(page.getByTestId('drawer')).toBeHidden();
    } else {
      await page.getByTestId('sidebar').getByTestId(`nav-${id}`).click();
    }
  };
  const cases: [string, string, string][] = [
    ['history', '/app/recordings?panel=history', 'Recordings'],
    ['events', '/app/recordings?panel=events', 'Recordings'],
    ['downloads', '/app/recordings?panel=downloads', 'Recordings'],
    ['settings', '/app/settings', 'Settings'],
    ['about', '/app/about', 'About'],
    ['live', '/app/live', 'Live'],
  ];
  for (const [id, url, title] of cases) {
    await open(id);
    await expect(page).toHaveURL(url);
    await expect(page.getByTestId('page-title')).toHaveText(title);
  }
  await page.goBack();
  await expect(page).toHaveURL('/app/about');
  await expect(page.getByTestId('page-title')).toHaveText('About');
});

test('recordings panel tabs switch the panel', async ({ page }) => {
  await page.goto('/app/recordings?panel=events');
  await expect(page.getByTestId('panel-tab-events')).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('panel-tab-downloads').click();
  await expect(page).toHaveURL('/app/recordings?panel=downloads');
});

test('unknown app paths show the Live page', async ({ page }) => {
  await page.goto('/app/does-not-exist');
  await expect(page.getByTestId('page-title')).toHaveText('Live');
});

test('about page shows the version', async ({ page }) => {
  await page.goto('/app/about');
  await expect(page.getByTestId('about-version')).toHaveText('e2e-test-version');
});

test.describe('desktop sidebar', () => {
  test.skip(({}, testInfo) => testInfo.project.name !== 'desktop', 'desktop only');

  test('collapses to an icon column, remembers it, and expands again', async ({ page }) => {
    await page.goto('/app/live');
    const sidebar = page.getByTestId('sidebar');
    await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(220);
    await page.getByTestId('sidebar-toggle').click();
    await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(64);
    await page.reload();
    await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(64);
    await page.getByTestId('sidebar-toggle').click();
    await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(220);
  });

  test('hamburger is hidden', async ({ page }) => {
    await page.goto('/app/live');
    await expect(page.getByTestId('hamburger')).toBeHidden();
  });
});

test.describe('phone layout', () => {
  test.skip(({}, testInfo) => testInfo.project.name !== 'phone', 'phone only');

  test('uses a hamburger drawer instead of the sidebar', async ({ page }) => {
    await page.goto('/app/live');
    await expect(page.getByTestId('sidebar')).toBeHidden();
    await page.getByTestId('hamburger').click();
    await expect(page.getByTestId('drawer')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('drawer')).toBeHidden();
  });

  test('has no horizontal page scroll', async ({ page }) => {
    await page.goto('/app/live');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
```

- [ ] **Step 4: Run the suite**

Run:
```bash
npx playwright install chromium
npm run build && npm run test:e2e
```
Expected: all specs pass on both projects (desktop and phone). A failure here is a real bug in Tasks 5–8; fix it there, not in the spec.

- [ ] **Step 5: Commit**

```bash
git add playwright.config.ts e2e
git commit -m "test: Playwright e2e for landing, auth boundaries and app shell at desktop and phone sizes"
```

---

### Task 10: Container image

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `CHANGELOG.md`

**Interfaces:**
- Produces: an image that runs `node dist/server/server.js` as uid 1000 on port 8080, serving `dist/web`.

- [ ] **Step 1: Create the files**

`Dockerfile`:
```dockerfile
FROM node:26-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY server ./server
COPY web ./web
RUN npm run build

FROM node:26-alpine
WORKDIR /app
# Stamped by the deploy; "dev" for local builds, "main" for build-push.
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY CHANGELOG.md ./
# Numeric, not `USER node`: with a named user, the ksvc's runAsNonRoot can't
# verify non-root and the pod fails with CreateContainerConfigError.
USER 1000:1000
EXPOSE 8080
CMD ["node", "dist/server/server.js"]
```

`.dockerignore`:
```
node_modules
dist
test
e2e
test-results
playwright-report
.git
.github
.env
*.md
!CHANGELOG.md
docs
```

`CHANGELOG.md`:
```markdown
# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

- Landing page, Google sign-in and the app shell (sidebar, drawer, theme, camera picker).
```

- [ ] **Step 2: Build and verify as non-root**

Run:
```bash
docker build --build-arg APP_VERSION=local-test -t cams:local .
docker run --rm cams:local id
docker run --rm -d --name cams-test -p 18080:8080 --cap-drop ALL --security-opt no-new-privileges \
  -e COOKIE_SECRET=x -e GOOGLE_CLIENT_ID=x -e GOOGLE_CLIENT_SECRET=x \
  -e GOOGLE_REDIRECT_URI=http://localhost:18080/auth/google/callback -e ALLOWED_EMAILS=klaus@klaushofrichter.net cams:local
sleep 2; curl -s localhost:18080/health; echo; curl -s -o /dev/null -w '%{http_code}\n' localhost:18080/
docker rm -f cams-test
```
Expected: `uid=1000 gid=1000`; `{"status":"ok","version":"local-test"}`; `200`.

- [ ] **Step 3: Commit**

```bash
git add Dockerfile .dockerignore CHANGELOG.md
git commit -m "build: container image running as uid 1000"
```

---

### Task 11: Repository documentation and the three workflows

**Files:**
- Create: `README.md`, `CLAUDE.md`, `LICENSE`, `.github/dependabot.yml`, `.github/codeql-accepted.tsv`
- Create: `.github/workflows/production-checks.yml`, `.github/workflows/build-push.yml`, `.github/workflows/deploy-production.yml`

**Interfaces:**
- Produces: PR check contexts `test`, `e2e` and `codeql`; image `ghcr.io/klaushofrichter/cams`; the deploy writes `manifests/cams/cams-ksvc.yaml` in kube-setup.

- [ ] **Step 1: `LICENSE`**

MIT licence text, `Copyright (c) 2026 Klaus Hofrichter` (same as `~/Development/kauf-server/LICENSE`):
```bash
sed 's/^Copyright.*/Copyright (c) 2026 Klaus Hofrichter/' ~/Development/kauf-server/LICENSE > LICENSE
head -3 LICENSE
```
Expected: `MIT License`, blank line, and the copyright line.

- [ ] **Step 2: `.github/dependabot.yml`**

Copy verbatim from `~/Development/www-klaushofrichter/.github/dependabot.yml`: npm, github-actions and docker; weekly, Monday 06:00 America/Chicago; groups as there.
```bash
mkdir -p .github/workflows && cp ~/Development/www-klaushofrichter/.github/dependabot.yml .github/dependabot.yml
```

- [ ] **Step 3: `.github/codeql-accepted.tsv`**

```
# Accepted CodeQL findings. The gate in production-checks.yml ignores exactly
# these, and nothing else. Changing this file takes a pull request.
# Format: ruleId<TAB>path<TAB>reason
```

- [ ] **Step 4: `.github/workflows/production-checks.yml`**

```yaml
name: PR checks

on:
  pull_request:
    branches: [main, production]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 26
      - run: npm ci
      - run: npm test
      # Build every artifact in PR checks: the server, the web bundle and the
      # Svelte type check.
      - run: npm run build
      - run: npm run check
      - run: npm audit --audit-level=high

  e2e:
    # GitHub-hosted only: a browser on the self-hosted runner gets OOM-killed.
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 26
      - run: npm ci
      - run: sudo rm -f /etc/apt/sources.list.d/google-chrome.list
      - run: npx playwright install --with-deps chromium
      - run: npm run build
      # playwright.config.ts starts the built server with e2e/env.ts values.
      - run: npm run test:e2e
        env:
          CI: 'true'

  codeql:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write
      actions: read
    steps:
      - uses: actions/checkout@v7
      - uses: github/codeql-action/init@v4
        with:
          languages: javascript-typescript
      - uses: github/codeql-action/analyze@v4
        with:
          output: sarif-results
          upload: never
      - name: Fail if CodeQL found any results
        run: |
          set -euo pipefail
          accepted=.github/codeql-accepted.tsv
          blocking=0
          for f in sarif-results/*.sarif; do
            while IFS=$'\t' read -r rule uri line message; do
              [ -n "$rule" ] || continue
              if grep -v '^#' "$accepted" | awk -F'\t' -v r="$rule" -v p="$uri" '$1==r && $2==p {found=1} END {exit !found}'; then
                echo "::notice::CodeQL $rule at $uri:$line — accepted exception, see $accepted"
              else
                echo "::error::CodeQL $rule — $message"
                echo "    at $uri:$line"
                blocking=$((blocking + 1))
              fi
            done < <(jq -r '.runs[].results[]
              | select((.suppressions // []) | length == 0)
              | [.ruleId,
                 .locations[0].physicalLocation.artifactLocation.uri,
                 (.locations[0].physicalLocation.region.startLine | tostring),
                 .message.text] | @tsv' "$f")
          done
          echo "CodeQL blocking findings: $blocking"
          [ "$blocking" -eq 0 ] || { echo "::error::CodeQL found $blocking unaccepted finding(s)"; exit 1; }
```

- [ ] **Step 5: `.github/workflows/build-push.yml`**

```yaml
name: Build and publish image

on:
  push:
    branches: [main]

permissions:
  contents: read
  packages: write

jobs:
  build-push:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 26
      - run: |
          npm ci
          npm test
      - uses: docker/login-action@v4
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v7
        with:
          context: .
          push: true
          build-args: |
            APP_VERSION=main
          # :main ONLY. deploy-production.yml is the sole writer of :<sha>,
          # :v<version> and :latest; a second writer could replace the image
          # under the ksvc's :<sha> pin.
          tags: |
            ghcr.io/klaushofrichter/cams:main
```

- [ ] **Step 6: `.github/workflows/deploy-production.yml`**

```yaml
name: Deploy production

on:
  push:
    branches: [production]
  workflow_dispatch:

permissions:
  contents: write
  packages: write

jobs:
  deploy:
    runs-on: [self-hosted, k3s]
    steps:
      - name: Refuse to deploy anything but production
        if: github.ref != 'refs/heads/production'
        run: |
          echo "::error::deploys run from production only (got ${GITHUB_REF})"
          exit 1

      - uses: actions/checkout@v7
        with:
          fetch-depth: 0

      - name: Install kubectl and configure in-cluster access
        run: |
          set -euo pipefail
          if ! command -v kubectl >/dev/null 2>&1; then
            curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
            chmod +x kubectl
            sudo mv kubectl /usr/local/bin/kubectl
          fi
          SA_DIR=/var/run/secrets/kubernetes.io/serviceaccount
          kubectl config set-cluster in-cluster --server=https://kubernetes.default.svc --certificate-authority="${SA_DIR}/ca.crt"
          kubectl config set-credentials deploy-sa --token="$(cat "${SA_DIR}/token")"
          kubectl config set-context in-cluster --cluster=in-cluster --user=deploy-sa --namespace=cams
          kubectl config use-context in-cluster

      - name: Generate the version
        id: ver
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          set -euo pipefail
          DATE=$(TZ=America/Chicago date +%Y.%m.%d)
          # Own assignment so a gh failure fails the step instead of reading as
          # "no releases today" and reusing a shipped version.
          RELEASES=$(gh release list --repo "$GITHUB_REPOSITORY" --limit 200 --json tagName -q '.[].tagName')
          TODAY=$(printf '%s\n' "$RELEASES" | grep -c "^v${DATE}\." || true)
          VERSION="${DATE}.$((TODAY + 1))"
          echo "version=$VERSION" >> "$GITHUB_OUTPUT"
          echo "Releasing v$VERSION"

      - uses: docker/login-action@v4
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - uses: docker/build-push-action@v7
        with:
          context: .
          push: true
          build-args: |
            APP_VERSION=${{ steps.ver.outputs.version }}
          tags: |
            ghcr.io/klaushofrichter/cams:${{ github.sha }}
            ghcr.io/klaushofrichter/cams:v${{ steps.ver.outputs.version }}
            ghcr.io/klaushofrichter/cams:latest

      - name: Prune old Docker images
        run: docker system prune -af --filter "until=168h" || true

      - name: Update kube-setup manifest and deploy
        env:
          KUBE_SETUP_DEPLOY_TOKEN: ${{ secrets.KUBE_SETUP_DEPLOY_TOKEN }}
          SHA: ${{ github.sha }}
        run: |
          set -euo pipefail
          rm -rf /tmp/kube-setup-deploy
          git clone "https://x-access-token:${KUBE_SETUP_DEPLOY_TOKEN}@github.com/klaushofrichter/kube-setup.git" /tmp/kube-setup-deploy
          cd /tmp/kube-setup-deploy
          M=manifests/cams/cams-ksvc.yaml
          sed -i "s|image: ghcr.io/klaushofrichter/cams:.*|image: ghcr.io/klaushofrichter/cams:${SHA}|" "$M"
          # A silently no-op sed would commit an unchanged manifest and let git
          # drift from the cluster while reporting success.
          grep -q "image: ghcr.io/klaushofrichter/cams:${SHA}$" "$M" \
            || { echo "::error::manifest image line did not update to ${SHA}"; exit 1; }
          git config user.name "cams-deploy-bot"
          git config user.email "actions@users.noreply.github.com"
          git add "$M"
          if git diff --cached --quiet; then
            echo "Manifest already at ${SHA}; nothing to commit."
          else
            git commit -m "Deploy cams ${SHA}"
            git push   # push before apply, always
          fi
          kubectl apply -f "$M"
          rm -rf /tmp/kube-setup-deploy

      - name: Verify rollout
        run: |
          set -euo pipefail
          kubectl wait --for=condition=Ready ksvc/cams -n cams --timeout=180s
          kubectl get ksvc cams -n cams

      # curl, not Playwright: a browser OOM-kills this runner. The full
      # Playwright suite ran on GitHub's runners before this merge.
      - name: Smoke-test the public endpoints
        id: smoke
        env:
          VERSION: ${{ steps.ver.outputs.version }}
        run: |
          set -euo pipefail
          BASE=https://cams.skylar.technology
          # Polled until the served version matches: Knative can answer from
          # the previous revision for a moment after Ready.
          code=""; served=""; ok=""
          for i in $(seq 1 10); do
            code=$(curl -s -o /tmp/health.json -w "%{http_code}" "$BASE/health" || true)
            if [ "$code" = "200" ]; then
              served=$(grep -o '"version":"[^"]*"' /tmp/health.json | head -1 | cut -d'"' -f4 || true)
              if [ "$served" = "$VERSION" ]; then ok=1; echo "health ok, serving ${served}"; break; fi
              echo "still serving ${served:-unknown}, waiting for ${VERSION} (${i}/10)"
            else
              echo "health not ready (HTTP ${code}), retry ${i}/10"
            fi
            sleep 6
          done
          [ -n "$ok" ] || { echo "::error::/health never reported ${VERSION} (last HTTP ${code:-none}, version ${served:-none})"; exit 1; }
          landing=$(curl -s -o /tmp/landing.html -w "%{http_code}" "$BASE/")
          [ "$landing" = "200" ] || { echo "::error::landing page returned ${landing}"; exit 1; }
          grep -q 'id="root"' /tmp/landing.html || { echo "::error::landing page HTML missing its root element"; exit 1; }
          app=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/app/live")
          [ "$app" = "302" ] || { echo "::error::signed-out /app/live returned ${app}, expected 302 (auth not enforced?)"; exit 1; }
          api=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/me")
          [ "$api" = "401" ] || { echo "::error::signed-out /api/me returned ${api}, expected 401"; exit 1; }
          {
            echo "served_version=$served"
            echo "landing_code=$landing"
            echo "app_code=$app"
            echo "api_code=$api"
            echo "base=$BASE"
            echo "checked_at=$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
          } >> "$GITHUB_OUTPUT"

      - name: Tag the release
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          VERSION: ${{ steps.ver.outputs.version }}
          SERVED: ${{ steps.smoke.outputs.served_version }}
          LANDING: ${{ steps.smoke.outputs.landing_code }}
          APP: ${{ steps.smoke.outputs.app_code }}
          API: ${{ steps.smoke.outputs.api_code }}
          BASE: ${{ steps.smoke.outputs.base }}
          CHECKED_AT: ${{ steps.smoke.outputs.checked_at }}
        run: |
          set -euo pipefail
          TAG="v${VERSION}"
          if gh release view "$TAG" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1; then
            echo "$TAG already released - skipping."; exit 0
          fi
          : > /tmp/notes.md
          awk '/^## \[Unreleased\]/ { grab = 1; next } grab && /^## / { exit } grab { print }' CHANGELOG.md \
            | sed '/^[[:space:]]*$/d' > /tmp/curated.md
          if [ -s /tmp/curated.md ]; then cat /tmp/curated.md >> /tmp/notes.md; printf '\n' >> /tmp/notes.md; fi
          PREV=$(gh release list --repo "$GITHUB_REPOSITORY" --limit 1 --json tagName -q '.[0].tagName' 2>/dev/null || true)
          printf '### Changes\n\n' >> /tmp/notes.md
          if [ -n "$PREV" ] && git rev-parse "$PREV" >/dev/null 2>&1; then
            git log --no-merges --pretty='- %s' "${PREV}..HEAD" >> /tmp/notes.md
            printf '\n**Full diff**: %s/compare/%s...%s\n' "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY" "$PREV" "$TAG" >> /tmp/notes.md
          else
            git log --no-merges --pretty='- %s' -20 >> /tmp/notes.md
          fi
          printf '\n### Verified at release\n\n' >> /tmp/notes.md
          printf -- '- Rollout: `ksvc/cams` reached Ready\n' >> /tmp/notes.md
          printf -- '- `GET %s/health` -> 200, reported version `%s`, matching this build\n' "$BASE" "$SERVED" >> /tmp/notes.md
          printf -- '- `GET %s/` -> %s (landing page)\n' "$BASE" "$LANDING" >> /tmp/notes.md
          printf -- '- `GET %s/app/live` signed out -> %s (auth enforced)\n' "$BASE" "$APP" >> /tmp/notes.md
          printf -- '- `GET %s/api/me` signed out -> %s\n' "$BASE" "$API" >> /tmp/notes.md
          printf -- '- Checked at %s by [run %s](%s/%s/actions/runs/%s)\n' "$CHECKED_AT" "$GITHUB_RUN_ID" "$GITHUB_SERVER_URL" "$GITHUB_REPOSITORY" "$GITHUB_RUN_ID" >> /tmp/notes.md
          printf '\nImage: `ghcr.io/klaushofrichter/cams:%s`\n' "$TAG" >> /tmp/notes.md
          gh release create "$TAG" --repo "$GITHUB_REPOSITORY" --target "$GITHUB_SHA" --title "$TAG" --notes-file /tmp/notes.md
          echo "Released $TAG"
```

- [ ] **Step 7: `README.md`**

````markdown
# cams

[![Release](https://img.shields.io/github/v/release/klaushofrichter/cams)](https://github.com/klaushofrichter/cams/releases)
[![PR checks](https://github.com/klaushofrichter/cams/actions/workflows/production-checks.yml/badge.svg)](https://github.com/klaushofrichter/cams/actions/workflows/production-checks.yml)
[![Build and publish image](https://github.com/klaushofrichter/cams/actions/workflows/build-push.yml/badge.svg)](https://github.com/klaushofrichter/cams/actions/workflows/build-push.yml)
[![Deploy production](https://github.com/klaushofrichter/cams/actions/workflows/deploy-production.yml/badge.svg)](https://github.com/klaushofrichter/cams/actions/workflows/deploy-production.yml)
<!-- Static badge: Dependabot has no status endpoint; alerts and security fixes are enabled in repo settings. -->
![Dependabot](https://img.shields.io/badge/dependabot-enabled-025E8C?logo=dependabot)

Private viewer for Skylar Technology's Reolink security cameras, at
<https://cams.skylar.technology>: live video, recorded events with AI detection,
clip playback and downloads, and camera settings, behind Google sign-in.

## How it fits together

- `server/`: Express 5 + TypeScript. Google OAuth, sessions, `/health`, the JSON API, and serving the web build.
- `web/`: Svelte 5 + Vite. `index.html` is the public landing page; `app.html` is the signed-in app.
- The app runs as a Knative service on the k3s cluster. Its manifests live in the `kube-setup` repo, not here.

## Development

```bash
npm ci
cp .env.example .env     # fill in values
npm run dev              # server on :8080
npm run dev:web          # Vite on :5173, proxying /api and /auth to :8080
```

## Testing

```bash
npm test                 # vitest: server + web libraries
npm run build && npm run test:e2e   # Playwright, desktop and phone viewports
```

The e2e suite signs its own session cookie with a test secret (`e2e/session.ts`), so it never talks to Google.

## Deployment and releases

`main` is built and published as `ghcr.io/klaushofrichter/cams:main` but never deployed. A PR from `main` to `production` runs `test`, `e2e` and `codeql`; merging it deploys through the in-cluster runner, smoke-tests the public URL and creates a `vYYYY.MM.DD.N` release.

## Security

- **Sign-in:** Google OAuth with an email allow-list re-checked on every request.
- **Session:** an httpOnly, Secure, SameSite=Lax cookie.
- **Other protections:** a same-origin check on state-changing API calls, and rate limits on sign-in and the API.
- **Container:** runs as uid 1000 with all capabilities dropped.
````

- [ ] **Step 8: `CLAUDE.md`**

```markdown
# cams

Camera viewer for Reolink cameras at cams.skylar.technology. Spec: `docs/superpowers/specs/2026-09-25-cams-design.md`. Plans: `docs/superpowers/plans/`.

## Commands

- `npm test`: vitest (server tests in `test/`, web lib tests in `web/src/**/*.test.ts`)
- `npm run build`: `tsc` for the server plus `vite build` for the web app. tsc is the only server type-checker, so run the build.
- `npm run check`: svelte-check for `web/`
- `npm run test:e2e`: Playwright. It runs the BUILT server on :8099 and reuses one already running there locally, so rebuild first.
- `npm run dev` / `npm run dev:web`: local server and Vite dev server

## Branches and releases

- Work on `main` (or a feature branch, then a PR to main). `main` builds `:main` only and is never deployed.
- To deploy: PR `main` -> `production` (required checks `test`, `e2e`, `codeql`), then merge.
- The version is generated at deploy time (`YYYY.MM.DD.N`). Never store a version in the sources.
- Put user-visible changes under `## [Unreleased]` in CHANGELOG.md; the deploy moves them into the release notes.

## Rules that are easy to break

- Don't run Playwright on the self-hosted runner (OOM). It runs in production-checks.yml on GitHub runners.
- Don't push `:<sha>`, `:v*` or `:latest` from build-push.yml. deploy-production.yml is their only writer.
- Cluster manifests live in kube-setup (`manifests/cams/`). Ask the kube-setup session for changes; don't edit that repo from here.
- Never log camera passwords, tokens, cookies or client IPs. Detailed payloads go at debug level only (debug stays in the cluster).
- Every colour comes from the CSS tokens in `web/src/styles/theme.css`, scrollbars included.
- Every new UI element used by e2e gets a `data-testid`, and e2e runs at desktop (1440x900) and phone (390x844).
```

- [ ] **Step 9: Validate the workflow YAML and commit**

Run: `python3 -c "import yaml,glob; [yaml.safe_load(open(f)) for f in glob.glob('.github/**/*.yml', recursive=True)]; print('yaml ok')"`
Expected: `yaml ok`.

```bash
git add README.md CLAUDE.md LICENSE .github
git commit -m "ci: PR checks, image build, production deploy; repo docs"
```

---

### Task 12: GitHub: push, first PR run, Dependabot and branch protection

**Files:** none (GitHub settings)

- [ ] **Step 1: Push `main`**

Run: `git push origin main`
Expected: `build-push.yml` starts; `gh run list --workflow build-push.yml --limit 1` eventually shows `completed success`, and `ghcr.io/klaushofrichter/cams:main` exists.

- [ ] **Step 2: Enable Dependabot alerts and security fixes**

Run:
```bash
gh api -X PUT repos/klaushofrichter/cams/vulnerability-alerts
gh api -X PUT repos/klaushofrichter/cams/automated-security-fixes
gh api repos/klaushofrichter/cams/vulnerability-alerts -i | head -1
gh api repos/klaushofrichter/cams/automated-security-fixes --jq .enabled
```
Expected: `HTTP/2.0 204` (alerts enabled) and `true`.

- [ ] **Step 3: Create `production` and run the checks through a PR**

Run:
```bash
git push origin main:production
git switch -c chore/first-promotion
git commit --allow-empty -m "chore: first promotion through PR checks"
git push -u origin chore/first-promotion
gh pr create --base production --head chore/first-promotion --title "First promotion: verify PR checks" --body "Exercises test, e2e and codeql before branch protection is enabled.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
gh pr checks --watch
```
Expected: `test`, `e2e` and `codeql` all pass. Do **not** merge yet: the deploy needs Task 13's cluster pieces.

(Pushing `main` to `production` in this step also triggers `deploy-production.yml`. With no runner registered yet, that job stays queued. Cancel it with `gh run cancel $(gh run list --workflow deploy-production.yml --limit 1 --json databaseId -q '.[0].databaseId')`.)

- [ ] **Step 4: Protect `production`**

Run:
```bash
gh api -X PUT repos/klaushofrichter/cams/branches/production/protection --input - <<'EOF'
{
  "required_status_checks": { "strict": false, "contexts": ["test", "e2e", "codeql"] },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null
}
EOF
gh api repos/klaushofrichter/cams/branches/production/protection --jq '.required_status_checks.contexts'
```
Expected: `["test","e2e","codeql"]`. `enforce_admins: false` is deliberate: admin override stays possible for emergencies, as on the other services.

---

### Task 13: Cluster wiring, Secrets and the first production deploy

**Files:**
- Create: `scripts/create-secrets.sh`

**Interfaces:**
- Consumes:
  - The image `ghcr.io/klaushofrichter/cams` (Task 11).
  - `~/Development/reolink/.env`, which holds `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `CAMS_GITHUB_PAT` and `ALLOWED_EMAILS` (comma-separated; the script copies it into the Secret as-is).
- Produces: the `cams-oauth` Secret in namespace `cams`, the `runner-pat` Secret (key `token`) in `cams-runner`, and a live deployment.

- [ ] **Step 1: Write `scripts/create-secrets.sh`**

```bash
#!/usr/bin/env bash
# Creates or updates the cams Secrets from an env file. Never prints values.
#   usage: scripts/create-secrets.sh [env-file]   (default: ~/Development/reolink/.env)
# Needs: namespaces cams and cams-runner (created by kube-setup).
set -euo pipefail
ENV_FILE="${1:-$HOME/Development/reolink/.env}"
export KUBECONFIG="${KUBECONFIG:-$HOME/.kube/k3s-config}"
set -a; . "$ENV_FILE"; set +a
: "${GOOGLE_OAUTH_CLIENT_ID:?missing in $ENV_FILE}"
: "${GOOGLE_OAUTH_CLIENT_SECRET:?missing in $ENV_FILE}"
: "${CAMS_GITHUB_PAT:?missing in $ENV_FILE}"
: "${ALLOWED_EMAILS:?missing in $ENV_FILE}"

# Keep an existing COOKIE_SECRET so re-running doesn't sign everyone out.
existing=$(kubectl -n cams get secret cams-oauth -o jsonpath='{.data.COOKIE_SECRET}' 2>/dev/null | base64 -d || true)
COOKIE_SECRET="${existing:-$(openssl rand -hex 32)}"

kubectl -n cams create secret generic cams-oauth \
  --from-literal=GOOGLE_CLIENT_ID="$GOOGLE_OAUTH_CLIENT_ID" \
  --from-literal=GOOGLE_CLIENT_SECRET="$GOOGLE_OAUTH_CLIENT_SECRET" \
  --from-literal=GOOGLE_REDIRECT_URI="https://cams.skylar.technology/auth/google/callback" \
  --from-literal=ALLOWED_EMAILS="$ALLOWED_EMAILS" \
  --from-literal=COOKIE_SECRET="$COOKIE_SECRET" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl -n cams-runner create secret generic runner-pat \
  --from-literal=token="$CAMS_GITHUB_PAT" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl -n cams describe secret cams-oauth | sed -n '/^Data/,$p'
kubectl -n cams-runner describe secret runner-pat | sed -n '/^Data/,$p'
```

Run: `chmod +x scripts/create-secrets.sh && bash -n scripts/create-secrets.sh && echo syntax-ok`
Expected: `syntax-ok`.

```bash
git add scripts/create-secrets.sh
git commit -m "chore: script to create the cams Secrets from an env file"
git push origin main
```

- [ ] **Step 2: Ask the kube-setup session for the cluster pieces**

Send to `kube-setup-1d` (SendMessage):

```
cams cluster request (spec §9, Plan 1 Task 13). The image exists: ghcr.io/klaushofrichter/cams:main. The first :<sha> comes from the first deploy.

1. Namespace cams:
   - ksvc cams: min/max-scale 1, containerConcurrency 0, timeoutSeconds 600, port 8080.
   - readinessProbe GET /health; resources requests 50m/128Mi, limits 500m/256Mi.
   - Requirement-7 securityContext, uid/gid 1000.
   - envFrom secretRef cams-oauth.
   - Secret cams-cameras (optional: true) mounted read-only at /etc/cams with env CAMERAS_FILE=/etc/cams/cameras.json. It won't exist until Plan 2; the app treats a missing file as "no cameras".
   - enableServiceLinks: false. Initial image ghcr.io/klaushofrichter/cams:main (the deploy rewrites it to the sha).
2. ClusterDomainClaim and DomainMapping for cams.skylar.technology. Pre-create the cert before its tls entry goes onto the shared gateway ingress, per your trap notes.
3. Namespace cams-runner:
   - The runner deployment for repo klaushofrichter/cams (labels self-hosted, k3s), same pattern as art-runner.
   - PAT Secret runner-pat, key token. Klaus creates it with our script, so please don't create it.
   - RBAC limited to ksvc cams in namespace cams, same verbs as art.
4. Add both namespaces to scripts/export.sh and bootstrap.sh.
5. Add cams to the version-exporter's scrape list.
6. The repo secret KUBE_SETUP_DEPLOY_TOKEN on klaushofrichter/cams: set it as for the other services, if that's yours to do; otherwise tell me and Klaus will.

Please reply when 1–3 are applied, with the ksvc name/namespace and the runner's registration status. Pushed before applied, as always.
```

Wait for the reply before Step 4.

- [ ] **Step 3: Owner actions (Klaus)**

Ask Klaus to:
1. Create the Squarespace A record `cams.skylar.technology` pointing to the current public IP. Check the IP with `curl -s https://api.ipify.org`.
2. Once kube-setup confirms the namespaces exist, run `~/Development/cams/scripts/create-secrets.sh` (`! bash ~/Development/cams/scripts/create-secrets.sh`).
3. Confirm the repo secret `KUBE_SETUP_DEPLOY_TOKEN` is set (`gh secret list --repo klaushofrichter/cams`), if kube-setup didn't set it.

Verify: `dig +short cams.skylar.technology @1.1.1.1` equals `curl -s https://api.ipify.org`, and `kubectl --kubeconfig ~/.kube/k3s-config -n cams describe secret cams-oauth` lists five keys.

- [ ] **Step 4: Deploy**

Run:
```bash
gh pr merge chore/first-promotion --merge
gh run watch "$(gh run list --workflow deploy-production.yml --limit 1 --json databaseId -q '.[0].databaseId')"
```
Expected: the run succeeds and `gh release list --repo klaushofrichter/cams --limit 1` shows `v2026.MM.DD.1`.

- [ ] **Step 5: Verify production like a user**

Run:
```bash
curl -s https://cams.skylar.technology/health
curl -s -o /dev/null -w '%{http_code}\n' https://cams.skylar.technology/app/live
kubectl --kubeconfig ~/.kube/k3s-config -n cams exec deploy/$(kubectl --kubeconfig ~/.kube/k3s-config -n cams get deploy -o name | head -1 | cut -d/ -f2) -c user-container -- grep -E 'CapEff|NoNewPrivs|Seccomp:' /proc/1/status
```
Expected:
- `/health` returns the release's version.
- `/app/live` returns `302`.
- The container status shows `CapEff: 0000000000000000`, `NoNewPrivs: 1` and `Seccomp: 2`.

Then ask Klaus to open https://cams.skylar.technology in a browser and check:
- sign-in with Google works;
- the app shell appears;
- theme and sidebar work;
- logout returns to the landing page.

- [ ] **Step 6: Record in Obsidian and close the plan**

Ask the kube-setup session to update its generated Services note: cams is live, with namespace, domain and repo. Then update `CHANGELOG.md`: move nothing, because the deploy harvested `[Unreleased]`. Commit any follow-up fixes.

---

## Self-review notes

- **Spec coverage for Plan 1:**
  - §1 purpose: the landing page (Task 7).
  - §3 architecture skeleton (Tasks 1, 5, 7).
  - §4 auth and security (Tasks 2–5, 10).
  - §5 UI shell, theme, mark and landing (Tasks 6–8).
  - §6 `/health` independence (Task 1).
  - §7 testing: unit tests throughout, e2e (Task 9), smoke test (Task 11).
  - §8 repo and CI (Tasks 11–12).
  - §9 cluster (Task 13).
  - §10 owner actions (Task 13).
  - Camera media, recordings, settings and the §11 open checks belong to Plans 2–4, per the roadmap.
- **Names used across tasks:**
  - `SESSION_COOKIE`, `RETURN_COOKIE`, `currentUser`, `requireAuthPage`, `requireAuthApi`, `noStore`
  - `createAuthRateLimit`, `createApiRateLimit`, `resetRateLimits`
  - `listCameras`, `setCameras`, `loadCameras`
  - `webDir`, `pagesRouter`
  - `parseRoute`, `NAV_ITEMS`, `isActive`, `navigate`, `initRouter`, `route`
  - `persistedBoolean`, `sidebarCollapsed`, `drawerOpen`, `me`, `cameras`, `selectedCameraId`
  - `getJson`, `UnauthorizedError`, `toggleTheme`, `currentTheme`, `duration`
