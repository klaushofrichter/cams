import rateLimit, { MemoryStore, RateLimitRequestHandler } from 'express-rate-limit';
import { Request } from 'express';
import { currentUser } from './requireAuth';
import { isVerifiedInternal } from '../mcp/internal';
import { intEnv } from '../env';
import { logger } from '../logger';


// Overridable so the e2e suite can lift the caps; production sets neither.
const WINDOW_MS = intEnv('RATE_LIMIT_WINDOW_MS', 5 * 60 * 1000);
const AUTH_MAX = intEnv('RATE_LIMIT_MAX', 40);
const API_MAX = intEnv('RATE_LIMIT_API_MAX', 600);
const MEDIA_MAX = intEnv('RATE_LIMIT_MEDIA_MAX', 3000);
// cam-proxy stills and sprites: small, served from the proxy's disk, and
// asked for in bursts (a day of Timeline sprites, stills while scrubbing).
const IMAGE_MAX = intEnv('RATE_LIMIT_IMAGE_MAX', 20000);
// The web bundle, the landing page's screenshots and the icons: what a page
// load fetches besides the page itself. Their own, much higher budget
// (createStaticRateLimit): a page view is about 10 of them, and a visitor
// paging through the site, or the public-pages suite's four browsers plus
// Lighthouse on one address, spent the pages' 600 in minutes and got 429s
// for the stylesheet (kube-setup's "public web pages" baseline, 2026-11-11).
const STATIC_MAX = intEnv('RATE_LIMIT_STATIC_MAX', 20000);
// PTZ moves, zoom, focus and stop: holding the pad sends 4 a second, which
// would spend the general budget in 2.5 minutes. 5 a second over the window.
export const PTZ_MAX = intEnv('RATE_LIMIT_PTZ_MAX', 1500);

// Matched against req.path once mounted under /api (the prefix is already
// stripped there). Clip media: a clip's video, thumbnail and download.
// Images: a cam-proxy sprite or still (the Timeline page: a day is up to
// 1440 sprites), with their own budget since 2026-09-29.
const CLIP_PATH = /^\/cameras\/[^/]+\/clips\/[^/]+\/(video|thumb\.jpg|download)$/;
const IMAGE_PATH = /^\/cameras\/[^/]+\/((previews|stills)\/\d{1,15}\.jpg|still\/latest\.jpg|still-checks\/\d{1,12}\.jpg)$/;
// An archived clip's video and thumbnail (cam-proxy's archive): a player sends
// many ranges, and the Archive page a thumbnail per clip.
const ARCHIVE_MEDIA_PATH = /^\/archive\/[^/]+\/items\/\d{1,12}\/(video|thumbnail)$/;
// PTZ control calls (not positions, which are ordinary API calls).
export const PTZ_CONTROL_PATH = /^\/cameras\/[^/]+\/ptz\/(move|zoom|focus|stop)$/;
const MEDIA_PATH = { test: (p: string) => CLIP_PATH.test(p) || IMAGE_PATH.test(p) || ARCHIVE_MEDIA_PATH.test(p) };

// In-memory stores are correct only because the ksvc is pinned to one
// replica. Held here so tests can reset them between cases.
const stores: MemoryStore[] = [];

function build(limit: number, opts: { skip?: (req: Request) => boolean } = {}): RateLimitRequestHandler {
  const store = new MemoryStore();
  stores.push(store);
  return rateLimit({ windowMs: WINDOW_MS, limit, standardHeaders: true, legacyHeaders: false, store, skip: opts.skip });
}

export function createAuthRateLimit(): RateLimitRequestHandler {
  return build(AUTH_MAX);
}

// The token login's failures (POST /auth/token), per address: 10 per 15
// minutes. Only a failure counts (res.locals.tokenFailed, set by the handler
// for a well-formed token that doesn't match): successes don't, so the owner
// signing in on several browsers never trips it, and malformed requests (not
// JSON, a token in the URL, too large, a bad format) or cams-admin being out
// of reach don't either (code review 2026-11-14). Per address only, no global
// cap, which would let anyone on the LAN lock the owner out (spec
// 2026-10-04-pi-deployment-design). Read per request, so tests can set it.
export function createTokenFailureLimit(): RateLimitRequestHandler {
  const store = new MemoryStore();
  stores.push(store);
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: () => intEnv('RATE_LIMIT_TOKEN_FAILURES', 10),
    standardHeaders: true,
    legacyHeaders: false,
    store,
    skipSuccessfulRequests: true,
    requestWasSuccessful: (_req, res) => res.locals.tokenFailed !== true,
    message: { error: 'too_many_attempts' },
  });
}

// Viewer tokens (cams-admin design 2026-11-05, "Brute force"): the per-address
// limit above, and no bucket for every address together. Such a bucket let
// anyone fill it from a handful of addresses and lock every viewer out (code
// review 2026-11-14), the reason the Pi token has none. A viewer token is
// cav_ + 22 base-62 characters, 131 random bits: nothing to guess even
// spread over many addresses. Failures across all addresses are counted only
// to log a flood, once per 15 minutes past the threshold; nobody is refused.
// The threshold is read per request, so tests can set it.
const FLOOD_WINDOW_MS = 15 * 60 * 1000;
let flood = { start: 0, count: 0, logged: false };
export function noteViewerTokenFailure(now = Date.now()): void {
  if (now - flood.start >= FLOOD_WINDOW_MS) flood = { start: now, count: 0, logged: false };
  flood.count += 1;
  if (!flood.logged && flood.count > intEnv('RATE_LIMIT_VIEWER_TOKEN_FAILURES', 100)) {
    flood.logged = true;
    logger.warn({ kind: 'auth', failures: flood.count, windowMin: FLOOD_WINDOW_MS / 60_000 }, 'viewer_token_failures_high');
  }
}

// MCP tools' internal calls skip the per-address limits below: they all come
// from loopback, and the MCP layer has its own per-token and per-account ones.
// Skips clip media requests: they get their own, much higher budget below,
// so a page full of thumbnail requests doesn't eat into the general API's.
export function createApiRateLimit(): RateLimitRequestHandler {
  return build(API_MAX, { skip: (req) => isVerifiedInternal(req) || MEDIA_PATH.test(req.path) || PTZ_CONTROL_PATH.test(req.path) });
}

// PTZ control calls only (plan 2026-10-30-ptz-panel): their own budget.
export function createPtzRateLimit(): RateLimitRequestHandler {
  return build(PTZ_MAX, { skip: (req) => isVerifiedInternal(req) || !PTZ_CONTROL_PATH.test(req.path) });
}

// Clip video/thumbnail/download requests only, and archived clips' video and thumbnails.
export function createMediaRateLimit(): RateLimitRequestHandler {
  return build(MEDIA_MAX, { skip: (req) => isVerifiedInternal(req) || (!CLIP_PATH.test(req.path) && !ARCHIVE_MEDIA_PATH.test(req.path)) });
}

// cam-proxy stills and sprites only.
export function createImageRateLimit(): RateLimitRequestHandler {
  return build(IMAGE_MAX, { skip: (req) => isVerifiedInternal(req) || !IMAGE_PATH.test(req.path) });
}

// The pages router's static files (server/routes/pages.ts): matched against
// req.path at the root. /assets/<hashed file>, /landing/<name>.webp and the
// public files at the web root by name.
export const STATIC_ROOT_FILES: ReadonlySet<string> = new Set(['favicon.svg', 'favicon-32.png', 'apple-touch-icon.png', 'icon-512.png', 'site.webmanifest', 'llms.txt']);
export function isStaticPath(path: string): boolean {
  if (path.startsWith('/assets/') || /^\/landing\/[^/]+$/.test(path)) return true;
  return /^\/[^/]+$/.test(path) && STATIC_ROOT_FILES.has(path.slice(1));
}

// The pages themselves (/, /signin, /token, /app/...): the API's budget, with
// the static files left out of it.
export function createPagesRateLimit(): RateLimitRequestHandler {
  return build(API_MAX, { skip: (req) => isStaticPath(req.path) });
}

// The static files only, with their own budget: never counted against the
// pages, still capped (CodeQL js/missing-rate-limiting, and a flood).
export function createStaticRateLimit(): RateLimitRequestHandler {
  return build(STATIC_MAX, { skip: (req) => !isStaticPath(req.path) });
}

// Still checks (cams #179): each may cost a Vision call. Per signed-in user,
// 6 a minute and 60 a day (the design's numbers); the proxy's own checks cap
// is the budget's hard stop. In memory: a restart starts them over.
// Overridable for the e2e suite; read per request, so tests can set them.
export function createCheckRateLimits(): RateLimitRequestHandler[] {
  return ([[60_000, () => intEnv('RATE_LIMIT_CHECKS_PER_MIN', 6)], [86_400_000, () => intEnv('RATE_LIMIT_CHECKS_PER_DAY', 60)]] as const).map(([windowMs, limit]) => perUser(windowMs, limit));
}

// A limit per signed-in user, its cap read per request.
function perUser(windowMs: number, limit: () => number): RateLimitRequestHandler {
  const store = new MemoryStore();
  stores.push(store);
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    store,
    keyGenerator: (req) => `user:${currentUser(req)?.email ?? 'unknown'}`,
    message: { error: 'rate_limited' },
  });
}

// The Archive (cam-proxy's archive contract §0): per signed-in user, 10 new
// clips and 4 ZIPs a minute, the proxy's own per-client limits (cams is one
// client to it, so one person can't use up everyone's). Read per request.
export function createArchiveRateLimit(kind: 'create' | 'zip'): RateLimitRequestHandler {
  return perUser(60_000, () => (kind === 'create' ? intEnv('RATE_LIMIT_ARCHIVE_PER_MIN', 10) : intEnv('RATE_LIMIT_ARCHIVE_ZIP_PER_MIN', 4)));
}

export function resetRateLimits(): void {
  stores.forEach((store) => store.resetAll());
  flood = { start: 0, count: 0, logged: false };
}
