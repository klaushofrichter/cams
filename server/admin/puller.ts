// The pull loop (M §9.4): every 60 s with If-None-Match, at once (debounced)
// after a sign-in or a "changed" report; a failed pull keeps everything and
// backs off 60 s × 2ⁿ, capped at 5 min, ±10 % jitter.
export interface PullerOptions {
  intervalMs?: number;
  maxBackoffMs?: number;
  debounceMs?: number;
  pull: () => Promise<boolean>; // true: the pull reached cams-admin and was good
}

export class Puller {
  private timer: NodeJS.Timeout | null = null;
  private soonTimer: NodeJS.Timeout | null = null;
  private failures = 0;
  private running: Promise<void> | null = null;
  private stopped = false;
  private readonly interval: number;
  private readonly maxBackoff: number;
  private readonly debounce: number;

  constructor(private readonly o: PullerOptions) {
    this.interval = o.intervalMs ?? 60_000;
    this.maxBackoff = o.maxBackoffMs ?? 300_000;
    this.debounce = o.debounceMs ?? 10_000;
  }

  // The wait before the next scheduled pull.
  nextDelayMs(random: () => number = Math.random): number {
    const base = this.failures ? Math.min(this.interval * 2 ** this.failures, this.maxBackoff) : this.interval;
    return Math.round(base * (0.9 + 0.2 * random()));
  }

  start(): void {
    this.stopped = false;
    void this.pullNow();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.soonTimer) clearTimeout(this.soonTimer);
    this.timer = this.soonTimer = null;
  }

  soon(): void {
    if (this.stopped || this.soonTimer) return;
    this.soonTimer = setTimeout(() => {
      this.soonTimer = null;
      void this.pullNow();
    }, this.debounce);
    this.soonTimer.unref();
  }

  // One pull now (a running one is joined), then the next one scheduled.
  pullNow(): Promise<void> {
    this.running ??= (async () => {
      let ok = false;
      try {
        ok = await this.o.pull();
      } catch {
        ok = false;
      }
      this.failures = ok ? 0 : this.failures + 1;
    })().finally(() => {
      this.running = null;
      this.schedule();
    });
    return this.running;
  }

  private schedule(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.pullNow(), this.nextDelayMs());
    this.timer.unref();
  }
}
