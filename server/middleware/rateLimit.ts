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
