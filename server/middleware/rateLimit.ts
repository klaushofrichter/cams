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
// cam-proxy stills and sprites: small, served from the proxy's disk, and
// asked for in bursts (a day of Timeline sprites, stills while scrubbing).
const IMAGE_MAX = fromEnv('RATE_LIMIT_IMAGE_MAX', 20000);

// Matched against req.path once mounted under /api (the prefix is already
// stripped there). Clip media: a clip's video, thumbnail and download.
// Images: a cam-proxy sprite or still (the Timeline page: a day is up to
// 1440 sprites), with their own budget since 2026-09-29.
const CLIP_PATH = /^\/cameras\/[^/]+\/clips\/[^/]+\/(video|thumb\.jpg|download)$/;
const IMAGE_PATH = /^\/cameras\/[^/]+\/((previews|stills)\/\d{1,15}\.jpg|still\/latest\.jpg)$/;
const MEDIA_PATH = { test: (p: string) => CLIP_PATH.test(p) || IMAGE_PATH.test(p) };

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
  return build(MEDIA_MAX, { skip: (req) => !CLIP_PATH.test(req.path) });
}

// cam-proxy stills and sprites only.
export function createImageRateLimit(): RateLimitRequestHandler {
  return build(IMAGE_MAX, { skip: (req) => !IMAGE_PATH.test(req.path) });
}

export function resetRateLimits(): void {
  stores.forEach((store) => store.resetAll());
}
