import rateLimit, { MemoryStore, RateLimitRequestHandler } from 'express-rate-limit';
import { Request } from 'express';
import { currentUser } from './requireAuth';
import { isVerifiedInternal } from '../mcp/internal';

function fromEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// Overridable so the e2e suite can lift the caps; production sets neither.
const WINDOW_MS = fromEnv('RATE_LIMIT_WINDOW_MS', 5 * 60 * 1000);
const AUTH_MAX = fromEnv('RATE_LIMIT_MAX', 40);
const API_MAX = fromEnv('RATE_LIMIT_API_MAX', 600);
const MEDIA_MAX = fromEnv('RATE_LIMIT_MEDIA_MAX', 3000);
// cam-proxy stills and sprites: small, served from the proxy's disk, and
// asked for in bursts (a day of Timeline sprites, stills while scrubbing).
const IMAGE_MAX = fromEnv('RATE_LIMIT_IMAGE_MAX', 20000);
// The web bundle, the landing page's screenshots and the icons: what a page
// load fetches besides the page itself. Their own, much higher budget
// (createStaticRateLimit): a page view is about 10 of them, and a visitor
// paging through the site, or the public-pages suite's four browsers plus
// Lighthouse on one address, spent the pages' 600 in minutes and got 429s
// for the stylesheet (kube-setup's "public web pages" baseline, 2026-11-11).
const STATIC_MAX = fromEnv('RATE_LIMIT_STATIC_MAX', 20000);
// PTZ moves, zoom, focus and stop: holding the pad sends 4 a second, which
// would spend the general budget in 2.5 minutes. 5 a second over the window.
export const PTZ_MAX = fromEnv('RATE_LIMIT_PTZ_MAX', 1500);

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
// minutes. Successes don't count (res.locals.tokenOk, set by the handler), so
// the owner signing in on several browsers never trips it. Per address only,
// no global cap, which would let anyone on the LAN lock the owner out (spec
// 2026-10-04-pi-deployment-design). Read per request, so tests can set it.
export function createTokenFailureLimit(): RateLimitRequestHandler {
  const store = new MemoryStore();
  stores.push(store);
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: () => fromEnv('RATE_LIMIT_TOKEN_FAILURES', 10),
    standardHeaders: true,
    legacyHeaders: false,
    store,
    skipSuccessfulRequests: true,
    requestWasSuccessful: (_req, res) => res.locals.tokenOk === true,
    message: { error: 'too_many_attempts' },
  });
}

// Viewer tokens (cams-admin design 2026-11-05, "Brute force"): besides the
// per-address limit above, one bucket for every address together, 100 failed
// token sign-ins per 15 minutes. 131 random bits leave nothing to guess; this
// caps a spread-out attempt. Signed-in sessions are not affected, and the
// Pi's own token login (POST /auth/token) doesn't use this bucket. Read per
// request, so tests can set it.
export function createViewerTokenGlobalLimit(): RateLimitRequestHandler {
  const store = new MemoryStore();
  stores.push(store);
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: () => fromEnv('RATE_LIMIT_VIEWER_TOKEN_FAILURES', 100),
    standardHeaders: true,
    legacyHeaders: false,
    store,
    keyGenerator: () => 'viewer-tokens',
    skipSuccessfulRequests: true,
    requestWasSuccessful: (_req, res) => res.locals.tokenOk === true,
    message: { error: 'too_many_attempts' },
  });
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
  return ([[60_000, () => fromEnv('RATE_LIMIT_CHECKS_PER_MIN', 6)], [86_400_000, () => fromEnv('RATE_LIMIT_CHECKS_PER_DAY', 60)]] as const).map(([windowMs, limit]) => perUser(windowMs, limit));
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
  return perUser(60_000, () => (kind === 'create' ? fromEnv('RATE_LIMIT_ARCHIVE_PER_MIN', 10) : fromEnv('RATE_LIMIT_ARCHIVE_ZIP_PER_MIN', 4)));
}

export function resetRateLimits(): void {
  stores.forEach((store) => store.resetAll());
}
