// What the e2e fake cam-proxy (test/proxy/fakeProxy.ts) holds: the last ten
// minutes of stills and sprites for Den, and one clip covering today for
// Barn, whose camera refuses downloads like the real one. The media are
// ffmpeg test patterns made at start-up (nothing committed).
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { FakeProxy } from '../test/proxy/fakeProxy';

export const FAKE_PROXY_PORT = 8095;
export const FAKE_PROXY_TOKEN = 'e2e-fake-proxy-token-not-a-secret-000000';

function media(): { jpeg: Buffer; sprite: Buffer; mp4: Buffer } {
  const dir = mkdtempSync(join(tmpdir(), 'cams-e2e-proxy-'));
  const ff = (args: string[]) => execFileSync(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-v', 'error', '-y', ...args]);
  ff(['-f', 'lavfi', '-i', 'testsrc=size=896x512', '-frames:v', '1', join(dir, 'still.jpg')]);
  ff(['-f', 'lavfi', '-i', 'testsrc=size=1600x540', '-frames:v', '1', join(dir, 'sprite.jpg')]);
  ff(['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(dir, 'clip.mp4')]);
  return { jpeg: readFileSync(join(dir, 'still.jpg')), sprite: readFileSync(join(dir, 'sprite.jpg')), mp4: readFileSync(join(dir, 'clip.mp4')) };
}

export function seed(fake: FakeProxy): void {
  const { jpeg, sprite, mp4 } = media();
  const now = Math.floor(Date.now() / 60_000) * 60_000;
  const stills = new Map<number, Buffer>();
  const previews = new Map<number, Buffer>();
  for (let m = now - 10 * 60_000; m <= now; m += 60_000) {
    previews.set(m, sprite);
    for (let s = 0; s < 60; s += 10) stills.set(m + s * 1000, jpeg);
  }
  fake.stills.set('cam1', stills);
  // Barn: a still every 5 s from ten minutes before start-up to an hour after,
  // so the Live fallback always finds a recent one.
  const barn = new Map<number, Buffer>();
  for (let t = now - 10 * 60_000; t <= now + 60 * 60_000; t += 5000) barn.set(t, jpeg);
  fake.stills.set('barn', barn);
  fake.previews.set('cam1', previews);
  const day = new Date();
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  fake.clips.push({ id: 1, cam: 'barn', start, end: start + 86_400_000 - 1, stream: 'main', events: [], body: mp4, snapshot: jpeg });
}
