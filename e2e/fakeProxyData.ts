// What the e2e fake cam-proxy (test/proxy/fakeProxy.ts) holds: stills and
// sprites for Den from ten minutes before start-up to the current minute, and one clip covering today for
// Barn, whose camera refuses downloads like the real one. It holds no SD
// recordings: its recordings routes answer 503 camera_offline (404 not_found
// for an id /api/cameras doesn't list), so cams lists Den's and Barn's days
// with the camera's own Search and plays FTP copies, as with a proxy that
// can't reach its camera. Den's vehicle recording of today (cam-sim's demo,
// 09:30:00 camera time, America/Chicago) has a vehicle event 6 s in, with a
// still of its own at that second (issue #157: the card's thumbnail), and its
// motion recording (12:05:05) a still of its own 2 s in (its thumbnail). The
// media are ffmpeg test patterns made at start-up (nothing committed).
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { FakeProxy } from '../test/proxy/fakeProxy';

export const FAKE_PROXY_PORT = 8095;
export const FAKE_PROXY_TOKEN = 'e2e-fake-proxy-token-not-a-secret-000000';

function media(): { jpeg: Buffer; sprite: Buffer; mp4: Buffer; detection: Buffer; motion: Buffer } {
  const dir = mkdtempSync(join(tmpdir(), 'cams-e2e-proxy-'));
  const ff = (args: string[]) => execFileSync(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-v', 'error', '-y', ...args]);
  ff(['-f', 'lavfi', '-i', 'testsrc=size=896x512', '-frames:v', '1', join(dir, 'still.jpg')]);
  ff(['-f', 'lavfi', '-i', 'testsrc=size=1600x540', '-frames:v', '1', join(dir, 'sprite.jpg')]);
  ff(['-f', 'lavfi', '-i', 'smptehdbars=size=896x512', '-frames:v', '1', join(dir, 'detection.jpg')]);
  ff(['-f', 'lavfi', '-i', 'rgbtestsrc=size=896x512', '-frames:v', '1', join(dir, 'motion.jpg')]);
  ff(['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(dir, 'clip.mp4')]);
  return { jpeg: readFileSync(join(dir, 'still.jpg')), sprite: readFileSync(join(dir, 'sprite.jpg')), mp4: readFileSync(join(dir, 'clip.mp4')), detection: readFileSync(join(dir, 'detection.jpg')), motion: readFileSync(join(dir, 'motion.jpg')) };
}

// Unix ms of a wall-clock time in America/Chicago on `date` (YYYY-MM-DD).
export function chicagoMs(date: string, hms: string): number {
  const guess = Date.parse(`${date}T${hms}Z`);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(guess);
  const p = (t: string) => parts.find((x) => x.type === t)!.value;
  return guess - (Date.parse(`${p('year')}-${p('month')}-${p('day')}T${p('hour')}:${p('minute')}:${p('second')}Z`) - guess);
}

const chicagoToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
// Den's vehicle detection of today (issue #157).
export const vehicleDetectionMs = (): number => chicagoMs(chicagoToday(), '09:30:06');
// The still 2 s into Den's motion recording of today.
export const motionStillMs = (): number => chicagoMs(chicagoToday(), '12:05:07');

export function seed(fake: FakeProxy): { jpeg: Buffer; sprite: Buffer } {
  const { jpeg, sprite, mp4, detection, motion } = media();
  const now = Math.floor(Date.now() / 60_000) * 60_000;
  const stills = new Map<number, Buffer>();
  const previews = new Map<number, Buffer>();
  const minute = (m: number) => {
    previews.set(m, sprite);
    for (let s = 0; s < 60; s += 10) stills.set(m + s * 1000, jpeg);
  };
  for (let m = now - 10 * 60_000; m <= now; m += 60_000) minute(m);
  // Den's newest minute stays the current one, as with the real proxy: the
  // Timeline specs ask for "the newest minute" and the last few minutes'
  // sprites whenever they run, which on CI is several minutes after start-up.
  setInterval(() => minute(Math.floor(Date.now() / 60_000) * 60_000), 5_000).unref();
  const detected = vehicleDetectionMs();
  stills.set(detected, detection);
  stills.set(motionStillMs(), motion);
  fake.events.set('cam1', [{ id: 1, kind: 'vehicle', source: 'onvif', start: detected, end: detected + 8000, endReason: 'state', analysis: null }]);
  fake.stills.set('cam1', stills);
  // Barn: a still every 5 s from ten minutes before start-up to an hour after,
  // so the Live fallback always finds a recent one.
  const barn = new Map<number, Buffer>();
  // One still per second, as the real proxy keeps them (the History strip
  // plays them at 1 fps), from 15 minutes before the fake starts to an hour
  // after: Live's stills fallback asks for the latest recent still whenever
  // its test runs, which on CI is minutes after the start.
  for (let t = now - 15 * 60_000; t <= now + 60 * 60_000; t += 1000) barn.set(t, jpeg);
  fake.stills.set('barn', barn);
  fake.previews.set('cam1', previews);
  // Covers 36 hours back and 12 ahead, so "today" is inside it in the
  // browser's time zone (America/Chicago) whatever the runner's is: local
  // midnight on a UTC runner missed Chicago's day between 00:00 and 05:00 UTC.
  const start = Date.now() - 36 * 3_600_000;
  fake.clips.push({ id: 1, cam: 'barn', start, end: Date.now() + 12 * 3_600_000, stream: 'main', events: [], body: mp4, snapshot: jpeg });
  return { jpeg, sprite };
}
