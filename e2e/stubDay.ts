import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Page, Route } from '@playwright/test';
import { chicagoIso, chicagoMs } from './fakeProxyData';

// A day of Den's (cam1) events served by the page's own routes, every clip
// one generated test video: specs that need fixed events at any time of day.

export const chicagoDay = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(ms));
// Yesterday: all in the past, whatever time of day this runs.
export const YESTERDAY = () => chicagoDay(Date.now() - 86_400_000);

export type StubEvent = ReturnType<typeof event>;
export function event(date: string, start: string, end: string, trigger: string) {
  const compact = (t: string) => t.replaceAll(':', '');
  const s = chicagoMs(date, start);
  const e = chicagoMs(date, end);
  return {
    id: `${date.replaceAll('-', '')}-${compact(start)}-${compact(end)}`, start: chicagoIso(date, start), end: chicagoIso(date, end),
    durationSec: (e - s) / 1000, triggers: [trigger], sizeSub: 1, sizeMain: 1,
  };
}

// Longer than any event here: the player treats a seek past a video's end as that clip's end.
export const CLIP_S = 30;
let mp4: Buffer | undefined;
function video(): Buffer {
  if (mp4) return mp4;
  const dir = mkdtempSync(join(tmpdir(), 'cams-e2e-stubday-'));
  execFileSync(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=320x180:rate=10`, '-t', String(CLIP_S),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '10', '-movflags', '+faststart', join(dir, 'clip.mp4')]);
  mp4 = readFileSync(join(dir, 'clip.mp4'));
  return mp4;
}

function serveMp4(route: Route) {
  const body = video();
  const m = /bytes=(\d+)-(\d*)/.exec(route.request().headers()['range'] ?? '');
  if (!m) return route.fulfill({ status: 200, contentType: 'video/mp4', headers: { 'Accept-Ranges': 'bytes' }, body });
  const from = Number(m[1]);
  const to = m[2] ? Math.min(Number(m[2]), body.length - 1) : body.length - 1;
  return route.fulfill({
    status: 206, contentType: 'video/mp4', body: body.subarray(from, to + 1),
    headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${from}-${to}/${body.length}` },
  });
}

// `events` on `date`; every clip plays; a filter change is never saved for the shared user.
export async function stubDay(page: Page, date: string, events: StubEvent[]) {
  await page.route('**/api/preferences', async (route) => {
    if (route.request().method() !== 'GET') return route.fulfill({ json: route.request().postDataJSON() });
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), eventFilter: ['person', 'vehicle', 'pet', 'motion'] } });
  });
  await page.route(/\/api\/cameras\/cam1\/events\?date=/, async (route) => {
    if (new URL(route.request().url()).searchParams.get('date') !== date) return route.fallback();
    await route.fulfill({ json: { date, events, downloads: 'ok' } });
  });
  await page.route(/\/api\/cameras\/cam1\/clips\/[^/]+\/video/, serveMp4);
}

// The URL's position in ms: new links say epoch seconds, old ones ms.
export function urlAt(url: string): number {
  const raw = new URL(url).searchParams.get('at') ?? '';
  const n = Number(raw);
  return /^\d{9,11}$/.test(raw) ? n * 1000 : n;
}

// The moment the player shows, in ms (its clock line, to the second).
export async function shownAt(page: Page, date: string): Promise<number> {
  const text = (await page.getByTestId('clip-time').textContent()) ?? '';
  const m = /(\d{1,2}):(\d{2}):(\d{2})\s*([AP]M)?/.exec(text);
  if (!m) throw new Error(`no time in "${text}"`);
  let h = Number(m[1]) % (m[4] ? 12 : 24);
  if (m[4] === 'PM') h += 12;
  return chicagoMs(date, `${String(h).padStart(2, '0')}:${m[2]}:${m[3]}`);
}
