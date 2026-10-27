// The MCP limits (spec 2026-10-27-mcp-server-design §7), in memory like the
// other limits (the ksvc is one replica): fixed windows per key. Caps are
// read per call so tests can lower them.
function fromEnv(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

export class Budget {
  private hits = new Map<string, { start: number; n: number }>();
  constructor(private readonly limit: () => number, private readonly windowMs: number) {}

  // 0 when the call may go ahead (and is counted); else seconds to wait.
  take(key: string, now = Date.now()): number {
    const h = this.hits.get(key);
    if (!h || now - h.start >= this.windowMs) {
      if (this.hits.size > 10_000) this.prune(now);
      this.hits.set(key, { start: now, n: 1 });
      return 0;
    }
    if (h.n >= this.limit()) return Math.max(1, Math.ceil((h.start + this.windowMs - now) / 1000));
    h.n++;
    return 0;
  }

  // Seconds to wait, without counting (a check before the work).
  peek(key: string, now = Date.now()): number {
    const h = this.hits.get(key);
    if (!h || now - h.start >= this.windowMs || h.n < this.limit()) return 0;
    return Math.max(1, Math.ceil((h.start + this.windowMs - now) / 1000));
  }

  // Gives back one call counted by take() (the work was refused after all).
  refund(key: string): void {
    const h = this.hits.get(key);
    if (h && h.n > 0) h.n--;
  }

  private prune(now: number): void {
    for (const [k, h] of this.hits) if (now - h.start >= this.windowMs) this.hits.delete(k);
  }

  reset(): void {
    this.hits.clear();
  }
}

const MIN = 60_000;
export const limits = {
  tokenMinute: new Budget(() => fromEnv('RATE_LIMIT_MCP_PER_MIN', 60), MIN),
  tokenDay: new Budget(() => fromEnv('RATE_LIMIT_MCP_PER_DAY', 2000), 86_400_000),
  accountMinute: new Budget(() => fromEnv('RATE_LIMIT_MCP_ACCOUNT_PER_MIN', 300), MIN),
  clipsHour: new Budget(() => fromEnv('RATE_LIMIT_MCP_CLIPS_PER_HOUR', 10), 3_600_000),
  mediaMinute: new Budget(() => fromEnv('RATE_LIMIT_MCP_MEDIA_PER_MIN', 30), MIN),
  // Failed bearer tokens per address (the token sign-in's rule).
  badBearer: new Budget(() => fromEnv('RATE_LIMIT_TOKEN_FAILURES', 10), 15 * MIN),
};

export function resetMcpLimits(): void {
  Object.values(limits).forEach((b) => b.reset());
}
