// Composed SD clips (cam-proxy spec 2026-09-28): the Downloads modal's API.
export type ComposeSize = 'sd' | '360p' | '720p' | '1080p';
export const SIZE_LABELS: Record<ComposeSize, string> = {
  sd: 'SD 896×512 (original)', '360p': '640×360', '720p': '1280×720 (upscaled)', '1080p': '1920×1080 (upscaled)',
};
export interface JobView { id: string; state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'; progress: number; durationS: number; error?: string }

const roll = (v: number) => Number.isInteger(v) && v >= -600 && v <= 60;
export function resultLength(clipS: number, preS: number, postS: number): { ok: true; seconds: number } | { ok: false; error: string } {
  if (!roll(preS) || !roll(postS)) return { ok: false, error: 'Whole seconds from -600 to 60' };
  const start = -preS, end = clipS + postS;
  if (Math.min(end, clipS) - Math.max(start, 0) < 1) return { ok: false, error: 'At least 1 s of the clip must remain' };
  const seconds = end - start;
  return seconds > 60 ? { ok: false, error: 'At most 1:00' } : { ok: true, seconds };
}
export const formatLength = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
export function composedName(cam: string, startIso: string, size: ComposeSize): string {
  const d = new Date(startIso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${cam}-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}-composed-${size}.mp4`;
}
const base = (cam: string) => `/api/cameras/${encodeURIComponent(cam)}/compositions`;
export async function startJob(cam: string, body: { eventId: string; preS: number; postS: number; size: ComposeSize; badge: boolean; timeZone?: string }): Promise<JobView> {
  const r = await fetch(base(cam), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
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
  const r = await fetch(`${base(cam)}/${id}`, { credentials: 'same-origin' });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`poll answered ${r.status}`);
  return (await r.json()) as JobView;
}
export function cancelJob(cam: string, id: string): void {
  void fetch(`${base(cam)}/${id}`, { method: 'DELETE', credentials: 'same-origin', keepalive: true }).catch(() => {});
}
export const videoUrl = (cam: string, id: string, inline: boolean, name?: string) =>
  `${base(cam)}/${id}/video${inline ? '?inline=1' : name ? `?name=${encodeURIComponent(name)}` : ''}`;
