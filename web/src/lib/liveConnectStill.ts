// Klaus, 2026-10-06: while the live view connects (first load, camera
// switch, reconnect, coming back), a still from the camera gateway that is
// less than 60 s old shows in the player instead of black, newer ones replace
// it, and live takes over once its first frame is on screen. It is the stills
// fallback (LiveStill) starting early, limited to fresh stills until the
// fallback's own 5 s are up. Framework-free for testing.

export const FRESH_STILL_MS = 60_000;
// The gateway's clock against the browser's: a still stamped up to 30 s in
// the future still counts as fresh.
export const STILL_SKEW_MS = 30_000;

// Fresh by the still's own capture time (X-Still-Time), not the fetch time.
export function isFreshStill(at: number | null, now: number): boolean {
  if (at === null) return false;
  const age = now - at;
  return age < FRESH_STILL_MS && age >= -STILL_SKEW_MS;
}

export interface StillRef {
  cameraId: string;
  at: number | null;
}

// What to do with a still that just loaded: show it, keep the one shown, or
// drop it (shown nothing). `freshOnly`: still connecting, before the 5 s
// stills fallback.
export function decideStill(i: { cameraId: string; freshOnly: boolean; now: number; current: StillRef | null; next: StillRef }): 'show' | 'keep' | 'drop' {
  const { next, current } = i;
  if (next.cameraId !== i.cameraId) return 'drop'; // a late answer for the camera switched away from
  const mine = current?.cameraId === i.cameraId ? current : null;
  if (i.freshOnly && !isFreshStill(next.at, i.now)) return mine ? 'keep' : 'drop';
  if (mine && mine.at !== null && next.at !== null && next.at <= mine.at) return 'keep'; // not newer
  return 'show';
}

// While connecting: one request on connect, and the next ones (the stills'
// one a second) only while a fresh still shows. The fallback polls always.
export function keepPolling(i: { freshOnly: boolean; asked: number; showing: boolean }): boolean {
  return !i.freshOnly || i.asked === 0 || i.showing;
}

// Calls `done` once the video's first frame is on screen (or after
// `timeoutMs`: a hidden tab paints nothing), so the still over it goes only
// then and live takes over without a black flash. Returns a cancel.
export function whenPainted(video: HTMLVideoElement, done: () => void, timeoutMs = 300): () => void {
  let over = false;
  let frameHandle: number | null = null;
  const rafs: number[] = [];
  const v = video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number; cancelVideoFrameCallback?: (h: number) => void };
  const cleanup = () => {
    clearTimeout(timer);
    if (frameHandle !== null) v.cancelVideoFrameCallback?.(frameHandle);
    if (typeof cancelAnimationFrame === 'function') rafs.forEach((h) => cancelAnimationFrame(h));
  };
  const finish = () => {
    if (over) return;
    over = true;
    cleanup();
    done();
  };
  const timer = setTimeout(finish, timeoutMs);
  if (typeof v.requestVideoFrameCallback === 'function') frameHandle = v.requestVideoFrameCallback(() => finish());
  else if (typeof requestAnimationFrame === 'function') rafs.push(requestAnimationFrame(() => rafs.push(requestAnimationFrame(finish))));
  else finish();
  return () => {
    over = true;
    cleanup();
  };
}
