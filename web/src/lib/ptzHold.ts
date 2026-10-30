// Tap and hold on a PTZ button (cam-proxy spec 2026-10-30-ptz-capabilities-design
// §5.1). A tap is one move of TAP_MS, which the proxy ends by itself. Held
// past REPEAT_MS it becomes a hold: a move of HOLD_MS every REPEAT_MS, and a
// stop on release. So a tab that goes away leaves the camera stopped within
// HOLD_MS at most.
export const TAP_MS = 400;
export const HOLD_MS = 600;
export const REPEAT_MS = 250;

export interface Hold {
  press(): void;
  release(): void; // the button let go: a hold stops, a tap runs out by itself
  cancel(): void; // left, cancelled, hidden: always stops
  active(): boolean;
}

export function createHold(o: { start(durationMs: number): Promise<void>; stop(): Promise<void>; onError(e: unknown): void }): Hold {
  let active = false;
  let holding = false;
  let press = 0; // the current press; an older one's failure is stale
  let failed = false; // this press already reported an error
  let first: ReturnType<typeof setTimeout> | undefined;
  let repeat: ReturnType<typeof setInterval> | undefined;

  const clear = () => {
    clearTimeout(first);
    clearInterval(repeat);
    first = repeat = undefined;
  };
  // A stop that overtakes the last move on the way is bounded by that move's 600 ms lease.
  const stop = () => void o.stop().catch((e: unknown) => o.onError(e));
  // Ends the press; stops the camera when asked to.
  const end = (sendStop: boolean) => {
    clear();
    active = false;
    holding = false;
    if (sendStop) stop();
  };
  const start = (ms: number) => {
    const mine = press;
    o.start(ms).catch((e: unknown) => {
      if (mine !== press || failed) return;
      failed = true;
      if (active) end(holding);
      o.onError(e);
    });
  };

  return {
    press() {
      if (active) return;
      active = true;
      holding = false;
      failed = false;
      press++;
      start(TAP_MS);
      first = setTimeout(() => {
        holding = true;
        start(HOLD_MS);
        repeat = setInterval(() => start(HOLD_MS), REPEAT_MS);
      }, REPEAT_MS);
    },
    release() {
      if (active) end(holding);
    },
    cancel() {
      if (active) end(true);
    },
    active: () => active,
  };
}
