import rateLimit, { MemoryStore, RateLimitRequestHandler } from 'express-rate-limit';
import { Request } from 'express';

function fromEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// Overridable so the e2e suite can lift the caps; production sets neither.
const WINDOW_MS = fromEnv('RATE_LIMIT_WINDOW_MS', 5 * 60 * 1000);
const AUTH_MAX = fromEnv('RATE_LIMIT_MAX', 40);
const API_MAX = fromEnv('RATE_LIMIT_API_MAX', 600);
const MEDIA_MAX = fromEnv('RATE_LIMIT_MEDIA_MAX', 3000);

// Matched against req.path once mounted under /api (the prefix is already
// stripped there), so this covers a clip's video, thumbnail and download
// routes only.
const MEDIA_PATH = /^\/cameras\/[^/]+\/clips\/[^/]+\/(video|thumb\.jpg|download)$/;

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

// Skips clip media requests: they get their own, much higher budget below,
// so a page full of thumbnail requests doesn't eat into the general API's.
export function createApiRateLimit(): RateLimitRequestHandler {
  return build(API_MAX, { skip: (req) => MEDIA_PATH.test(req.path) });
}

// Clip video/thumbnail/download requests only.
export function createMediaRateLimit(): RateLimitRequestHandler {
  return build(MEDIA_MAX, { skip: (req) => !MEDIA_PATH.test(req.path) });
}

export function resetRateLimits(): void {
  stores.forEach((store) => store.resetAll());
}
