// The Save dialog's limits and its one rule for the result's length (Klaus,
// 2026-10-04). The server checks a composition with these before asking the
// cam-proxy, and the dialog imports this module, so the two never disagree.
// cam-proxy has the same rule (src/compose/plan.ts there, compositionWindow)
// on the same table of cases (test/clipLimits.test.ts here).

// A plain save: the recording as it is (SD, or 4K, no pre- or post-roll),
// nothing encoded.
export const PLAIN_MAX_S = 600;
// A generated clip (pre-/post-roll, another size): encoded on the cam-proxy,
// on a Pi 4 for the real camera. 1080p takes about three times as long as SD,
// so it has a lower limit (cam-proxy's COMPOSE_MAX_S and COMPOSE_MAX_S_1080P).
export const GENERATE_MAX_S = 300;
export const GENERATE_MAX_S_1080P = 120;
// Pre- and post-roll: whole seconds; a negative one cuts the recording. The
// result's length is the real limit; this only keeps the numbers sane.
export const ROLL_LIMIT_S = 3600;

export type SaveSize = 'sd' | '360p' | '720p' | '1080p' | '4k';

export const generateMaxS = (size: string): number => (size === '1080p' ? GENERATE_MAX_S_1080P : GENERATE_MAX_S);
// Whether a save is plain: 4K is always the original; SD is when both rolls are 0.
export const isPlain = (size: SaveSize, preS: number, postS: number): boolean => size === '4k' || (size === 'sd' && preS === 0 && postS === 0);
export const saveMaxS = (size: SaveSize, preS: number, postS: number): number => (isPlain(size, preS, postS) ? PLAIN_MAX_S : generateMaxS(size));

// Seconds as the dialog shows them, everywhere (header, result, limits,
// errors; Klaus, 2026-10-04): "44s", "1m 43s", "5m", "10m", "1h 2m 5s";
// parts that are 0 are left out.
export function formatSeconds(s: number): string {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const parts = [h ? `${h}h` : '', m ? `${m}m` : '', sec || (!h && !m) ? `${sec}s` : ''].filter(Boolean);
  return parts.join(' ');
}

export type Length = { ok: true; seconds: number } | { ok: false; error: string };

// The result of a clip of clipS seconds with a pre- and post-roll: the window
// [-pre, clipS + post], at least 1 s of the clip left, at most maxS long.
export function resultLength(clipS: number, preS: number, postS: number, maxS: number): Length {
  const roll = (v: number) => Number.isInteger(v) && Math.abs(v) <= ROLL_LIMIT_S;
  if (!roll(preS) || !roll(postS)) return { ok: false, error: `Whole seconds from -${ROLL_LIMIT_S} to ${ROLL_LIMIT_S}` };
  const start = -preS, end = clipS + postS;
  if (Math.min(end, clipS) - Math.max(start, 0) < 1) return { ok: false, error: 'At least 1 s of the clip must remain' };
  const seconds = end - start;
  return seconds > maxS ? { ok: false, error: `At most ${formatSeconds(maxS)}` } : { ok: true, seconds };
}
