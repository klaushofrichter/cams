import type { Run } from './strip';
import type { PreviewMinute } from './timeline';

// The band of small frames under the strip (Klaus, 2026-09-28): half the
// event list's 96×54 thumbnails, a visible gap and a frame around each, as many as the
// width holds. The frames sit on a fixed grid in time, so they slide with
// the strip instead of changing picture every second.
export const FILM_W = 48;
export const FILM_H = 27;
export const FILM_GAP = 8; // a visible gap (Klaus, 2026-09-28)

export interface FilmFrame {
  t: number;
  left: number; // % of the window, the frame's centre
  tile: { minute: PreviewMinute; index: number } | null;
}

// The preview tile at t, or the nearest present one within 3 s (cam-sim
// drops tiles). Only minutes whose metadata is loaded; each frame shows its
// minute's sprite, fetched once (finished minutes are cached 7 days).
function tileNear(byMinute: Map<number, PreviewMinute>, t: number): FilmFrame['tile'] {
  for (const d of [0, -1000, 1000, -2000, 2000, -3000, 3000]) {
    const s = t + d;
    const m = byMinute.get(Math.floor(s / 60_000) * 60_000);
    if (!m) continue;
    const index = Math.floor((s - m.minute) / (m.intervalS * 1000));
    if (m.present[index]) return { minute: m, index };
  }
  return null;
}

export function filmFrames(win: Run, width: number, previews: PreviewMinute[]): FilmFrame[] {
  const n = Math.floor((width + FILM_GAP) / (FILM_W + FILM_GAP));
  const span = win.end - win.start;
  if (n <= 0 || !(span > 0)) return [];
  const step = span / n;
  const byMinute = new Map(previews.map((m) => [m.minute, m]));
  const out: FilmFrame[] = [];
  for (let g = Math.ceil((win.start - step / 2) / step); ; g++) {
    const t = g * step + step / 2;
    if (t >= win.end) break;
    if (t < win.start) continue;
    out.push({ t, left: ((t - win.start) / span) * 100, tile: tileNear(byMinute, t) });
  }
  return out;
}
