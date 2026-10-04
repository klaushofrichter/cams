// Composed SD clips (cam-proxy spec 2026-09-28): the save dialog's API.
import { formatSeconds, generateMaxS, GENERATE_MAX_S, PLAIN_MAX_S, ROLL_LIMIT_S } from '../../../server/clipLimits';
import { apiFetch } from './api';
export type ComposeSize = 'sd' | '360p' | '720p' | '1080p';
export const SIZE_LABELS: Record<ComposeSize, string> = {
  sd: 'SD 896×512 (original)', '360p': '640×360', '720p': '1280×720 (upscaled)', '1080p': '1920×1080 (upscaled)',
};
// What the save dialog offers: the composed sizes, plus the camera's original
// main stream (4K, formerly "Full"), which is saved as it is (Klaus, 2026-09-29).
export type SaveSize = ComposeSize | '4k';
export const ORIGINAL_4K_LABEL = '4K 4512×2512 (original)';
export interface JobView { id: string; state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'; progress: number; durationS: number; error?: string }

// The limits and the length rule are the server's own module, so the dialog
// and the server never disagree (Klaus, 2026-10-04: plain save 600 s,
// generated 300 s, 120 s at 1080p; seconds shown as "44 s", "114 s (1:54)").
export { formatSeconds, GENERATE_MAX_S, GENERATE_MAX_S_1080P, isPlain, PLAIN_MAX_S, resultLength, saveMaxS } from '../../../server/clipLimits';

// A roll slider's range, given the other roll (clip of clipS seconds, a
// size's generated limit): at least 1 s of the clip stays and the result
// never passes the limit. The plain save (SD, both rolls 0) may be longer
// than a generated clip: then 0 is allowed too, and the values between the
// generated limit (`gapFrom`) and 0 are not (snapRoll).
export interface RollRange { min: number; max: number; gapFrom?: number }
export function rollRange(clipS: number, otherS: number, size: string): RollRange {
  const min = Math.max(-ROLL_LIMIT_S, 1 - clipS - Math.min(otherS, 0));
  const max = Math.min(ROLL_LIMIT_S, generateMaxS(size) - clipS - otherS);
  if (size === 'sd' && otherS === 0 && clipS <= PLAIN_MAX_S && max < 0) return { min, max: 0, gapFrom: max };
  return { min, max: Math.max(min, max) };
}
// A slider's value inside its range, out of the gap to the nearer side.
export function snapRoll(v: number, r: RollRange): number {
  const x = Math.min(r.max, Math.max(r.min, Math.round(v)));
  if (r.gapFrom !== undefined && x > r.gapFrom && x < 0) return x - r.gapFrom <= -x ? r.gapFrom : 0;
  return x;
}
// The rolls a dialog opens with: none, unless the clip is longer than even a
// plain save; then the post-roll cuts it to the generated limit at its end.
export function presetRolls(clipS: number): { preS: number; postS: number; note: string } {
  if (clipS <= PLAIN_MAX_S) return { preS: 0, postS: 0, note: '' };
  return { preS: 0, postS: GENERATE_MAX_S - clipS, note: `This recording is ${formatSeconds(clipS)}, longer than a save can be: the post-roll cuts it to ${formatSeconds(GENERATE_MAX_S)} at its end.` };
}
// The camera's local time, from the event id (YYYYMMDD-HHMMSS-…), like the
// original download's name (issue #72), not the browser's zone.
export function composedName(cam: string, eventId: string, size: ComposeSize): string {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(eventId);
  const when = m ? `${m[1]}-${m[2]}-${m[3]}_${m[4]}-${m[5]}-${m[6]}` : 'clip';
  return `${cam}-${when}-composed-${size}.mp4`;
}

// Whether the proxy has a copy of the event (issue #72); true when unsure.
export async function isAvailable(cam: string, eventId: string): Promise<boolean> {
  try {
    const r = await apiFetch(`${base(cam)}/available?eventId=${encodeURIComponent(eventId)}`);
    const j = (await r.json()) as { available?: unknown };
    return j.available !== false;
  } catch {
    return true;
  }
}

// Whether a 4K (main) download can be served now (Klaus, 2026-10-02: no
// silent quality downgrade); true when unsure, as the Save itself then tells.
export async function fullQualityAvailable(cam: string, clipId: string): Promise<boolean> {
  try {
    const r = await apiFetch(`/api/cameras/${encodeURIComponent(cam)}/clips/${encodeURIComponent(clipId)}/full-quality`);
    const j = (await r.json()) as { available?: unknown };
    return j.available !== false;
  } catch {
    return true;
  }
}
const base = (cam: string) => `/api/cameras/${encodeURIComponent(cam)}/compositions`;
export async function startJob(cam: string, body: { eventId: string; preS: number; postS: number; size: ComposeSize; badge: boolean; timeZone?: string }): Promise<JobView> {
  const r = await apiFetch(base(cam), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as JobView & { error?: string; detail?: string };
  if (!r.ok) {
    // The proxy's own reason when it gives one (its clip may differ from the event).
    const detail = typeof j.detail === 'string' && j.detail ? j.detail.charAt(0).toUpperCase() + j.detail.slice(1) + '.' : '';
    throw new Error(j.error === 'busy' ? 'The proxy is busy; try again in a minute.' : j.error === 'no_clip' ? 'The proxy has no copy of this clip.' : detail || 'The clip could not be composed.');
  }
  return j;
}
// null: the job is gone (404). Other failures throw, so the caller can retry.
export async function pollJob(cam: string, id: string): Promise<JobView | null> {
  const r = await apiFetch(`${base(cam)}/${id}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`poll answered ${r.status}`);
  return (await r.json()) as JobView;
}
export function cancelJob(cam: string, id: string): void {
  void apiFetch(`${base(cam)}/${id}`, { method: 'DELETE', keepalive: true }).catch(() => {});
}
export const videoUrl = (cam: string, id: string, inline: boolean, name?: string) =>
  `${base(cam)}/${id}/video${inline ? '?inline=1' : name ? `?name=${encodeURIComponent(name)}` : ''}`;
