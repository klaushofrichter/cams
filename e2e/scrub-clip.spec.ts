import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { type Page, type Route } from '@playwright/test';
import { expect, test } from './clock';
import { signIn } from './session';
import { outsideDemoClips } from './fakeProxyData';

// Klaus, 2026-10-09: dragging the timeline into a clip turned the player
// black while the clip's video loaded. The still (or preview tile) stays
// until the video has the frame under the cursor; a clip that can't load
// keeps the still. A 20 s clip is put among Den's last minutes of stills
// and preview tiles (the fake cam-proxy's); its video is answered here,
// late or not at all.
test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL!);
});

const CLIP_S = 20;
let mp4: Buffer;
test.beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'cams-e2e-scrub-'));
  execFileSync(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=320x180:rate=10`, '-t', String(CLIP_S),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '10', '-movflags', '+faststart', join(dir, 'clip.mp4')]);
  mp4 = readFileSync(join(dir, 'clip.mp4'));
});

const chicago = (ms: number, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', ...o }).format(new Date(ms));
const dayOf = (ms: number) => chicago(ms, {});
const hms = (ms: number) => chicago(ms, { hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' }).replaceAll(':', '');

// The clip: whole seconds, a few minutes ago, clear of cam-sim's demo clips.
function makeClip() {
  let end = Math.floor((Date.now() - 3 * 60_000) / 1000) * 1000;
  const clear = (e: number) => Array.from({ length: CLIP_S + 1 }, (_, i) => e - i * 1000).every((t) => outsideDemoClips(t) === t);
  while (!clear(end)) end -= 1000;
  const start = end - CLIP_S * 1000;
  const date = dayOf(start);
  const id = `${date.replaceAll('-', '')}-${hms(start)}-${hms(end)}`;
  return { id, start, end, date };
}
type Clip = ReturnType<typeof makeClip>;

// The clip's bytes with Range support, as cams serves them (a video without
// it can't seek in Chrome).
function serveMp4(route: Route) {
  const m = /bytes=(\d+)-(\d*)/.exec(route.request().headers()['range'] ?? '');
  if (!m) return route.fulfill({ status: 200, contentType: 'video/mp4', headers: { 'Accept-Ranges': 'bytes' }, body: mp4 });
  const from = Number(m[1]);
  const to = m[2] ? Math.min(Number(m[2]), mp4.length - 1) : mp4.length - 1;
  return route.fulfill({
    status: 206, contentType: 'video/mp4', body: mp4.subarray(from, to + 1),
    headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${from}-${to}/${mp4.length}` },
  });
}

async function setUp(page: Page, clip: Clip, video: (route: Route) => Promise<void>) {
  // A 1 minute window, never saved for the shared user.
  await page.route('**/api/preferences', async (route) => {
    if (route.request().method() !== 'GET') return route.fulfill({ json: { ...route.request().postDataJSON(), timelineZoom: 1 / 60 } });
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), timelineZoom: 1 / 60 } });
  });
  await page.route(/\/api\/cameras\/cam1\/events\?date=/, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    if (new URL(route.request().url()).searchParams.get('date') === clip.date) {
      const iso = (ms: number) => new Date(ms).toISOString();
      body.events = [...body.events, { id: clip.id, start: iso(clip.start), end: iso(clip.end), durationSec: CLIP_S, triggers: ['motion'], sizeSub: mp4.length, sizeMain: mp4.length }]
        .sort((a: { start: string }, b: { start: string }) => Date.parse(a.start) - Date.parse(b.start));
    }
    await route.fulfill({ response: res, json: body });
  });
  await page.route(`**/api/cameras/cam1/clips/${clip.id}/**`, video);
}

// Every animation frame: what the player box shows. A violation is a frame
// where nothing covers a video that isn't ready, a video on screen without a
// decoded frame, or one whose position is more than 1.5 s from the cursor
// (the bar's aria-valuenow).
async function startSampling(page: Page, clipStartMs: number) {
  await page.evaluate((clipStart) => {
    const w = window as unknown as { samples: { showing: string; bad: string | null }[]; stopSampling: boolean };
    w.samples = [];
    w.stopSampling = false;
    const tick = () => {
      if (w.stopSampling) return;
      const box = document.querySelector('[data-testid="strip-player"] .box') as HTMLElement;
      const showing = box.dataset.showing ?? '';
      let bad: string | null = null;
      const picture = box.querySelector('[data-testid="strip-still"], [data-testid="strip-preview"]');
      const v = box.querySelector('[data-testid="clip-video"]') as HTMLVideoElement;
      const cursorS = Number(document.querySelector('[data-testid="timeline"]')!.getAttribute('aria-valuenow'));
      if (showing === 'cover' || showing === 'pictures') {
        if (!picture) bad = `${showing} without a picture (${document.querySelector('[data-testid="source-badge"]')?.textContent}, ${box.querySelector('[data-testid="strip-empty"]') ? 'empty' : '-'}, t=${cursorS - clipStart / 1000})`;
        else if (showing === 'cover' && getComputedStyle(v).opacity !== '0') bad = 'video not transparent under the cover';
      } else if (showing === 'video') {
        // While it seeks, a video keeps rendering its last frame (HTML spec);
        // otherwise it needs the current one decoded.
        if (v.readyState < 2 && !v.seeking) bad = `video shown at readyState ${v.readyState}`;
        else if (getComputedStyle(v).opacity === '0' || getComputedStyle(v).visibility === 'hidden') bad = 'video shown but invisible';
        else if (Math.abs(clipStart / 1000 + v.currentTime - cursorS) > 1.5) bad = `video frame ${v.currentTime.toFixed(2)} s, cursor ${cursorS - clipStart / 1000} s`;
      }
      w.samples.push({ showing, bad });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, clipStartMs);
}
const samples = (page: Page) => page.evaluate(() => {
  const w = window as unknown as { samples: { showing: string; bad: string | null }[]; stopSampling: boolean };
  w.stopSampling = true;
  return w.samples;
});
const showing = (page: Page) => page.getByTestId('strip-player').locator('.box').getAttribute('data-showing');

// Drag the bar from its centre by `seconds` (positive: later), in steps.
async function drag(page: Page, seconds: number[], hold = false) {
  const bar = (await page.getByTestId('timeline').boundingBox())!;
  const y = bar.y + bar.height / 2;
  const x0 = bar.x + bar.width / 2;
  const pxPerS = bar.width / 60; // the 1 minute window
  await page.mouse.move(x0, y);
  await page.mouse.down();
  for (const s of seconds) {
    await page.mouse.move(x0 - s * pxPerS, y, { steps: 4 });
    await page.waitForTimeout(40);
  }
  if (!hold) await page.mouse.up();
}
const range = (from: number, to: number, step: number) => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step);

test('dragging across a loading clip keeps the still, and the video shows once it has the frame where the drag stops', async ({ page }) => {
  const clip = makeClip();
  let release: () => void = () => {};
  const served = new Promise<void>((r) => (release = r));
  let asked = 0;
  await setUp(page, clip, async (route) => {
    asked++;
    await served; // a slow proxy: nothing until the drag is over
    await serveMp4(route);
  });
  const startAt = clip.start - 15_000;
  await page.goto(`/app/video?cam=cam1&date=${dayOf(startAt)}&at=${startAt}`);
  await expect(page.getByTestId('zoom-1m')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('strip-still').or(page.getByTestId('strip-preview'))).toBeVisible();
  await startSampling(page, clip.start);

  // Across the whole clip and out, then back in: stills throughout.
  await drag(page, [...range(1, 40, 3), ...range(38, 25, -3)]);
  // Stopped 10 s into the clip (cursor at clip.start + ~10 s): the video
  // was asked for, isn't there yet, and the still covers it.
  await expect.poll(() => asked).toBeGreaterThan(0);
  await page.waitForTimeout(500);
  expect(await showing(page)).toBe('cover');
  await expect(page.getByTestId('strip-still').or(page.getByTestId('strip-preview'))).toBeVisible();
  release();
  await expect.poll(() => showing(page), { timeout: 15_000 }).toBe('video');
  const v = page.getByTestId('clip-video');
  const at = Number(await page.getByTestId('timeline').getAttribute('aria-valuenow')) * 1000;
  const t = await v.evaluate((el: HTMLVideoElement) => ({ ready: el.readyState, time: el.currentTime }));
  expect(t.ready).toBeGreaterThanOrEqual(2);
  expect(Math.abs(t.time - (at - clip.start) / 1000)).toBeLessThanOrEqual(1);
  await expect(page.getByTestId('strip-still')).toHaveCount(0);

  const s = await samples(page);
  expect(s.filter((x) => x.bad).map((x) => x.bad)).toEqual([]);
  expect(s.some((x) => x.showing === 'cover')).toBe(true); // it was inside the clip, covered
  expect(s.some((x) => x.showing === 'video')).toBe(true);
});

test('dragging inside a loaded clip: never black, the video back once it caught up', async ({ page }) => {
  const clip = makeClip();
  await setUp(page, clip, serveMp4);
  const startAt = clip.start + 3000;
  await page.goto(`/app/video?cam=cam1&date=${dayOf(startAt)}&at=${startAt}`);
  await expect.poll(() => showing(page), { timeout: 15_000 }).toBe('video');
  await startSampling(page, clip.start);
  await drag(page, [...range(1, 12, 1), ...range(11, 4, -1)], true); // held at +4 s: 7 s into the clip
  await expect.poll(() => showing(page), { timeout: 10_000 }).toBe('video'); // still holding: caught up after the dwell
  await page.mouse.up();
  const s = await samples(page);
  expect(s.filter((x) => x.bad).map((x) => x.bad)).toEqual([]);
});

test('a clip that fails to load keeps the still, during the drag and where it stops', async ({ page }) => {
  const clip = makeClip();
  let asked = 0;
  await setUp(page, clip, async (route) => {
    asked++;
    await route.fulfill({ status: 503, json: { error: 'proxy_busy' } });
  });
  const startAt = clip.start - 15_000;
  await page.goto(`/app/video?cam=cam1&date=${dayOf(startAt)}&at=${startAt}`);
  await expect(page.getByTestId('strip-still').or(page.getByTestId('strip-preview'))).toBeVisible();
  await startSampling(page, clip.start);
  await drag(page, range(1, 25, 3)); // stops 10 s into the clip
  await expect.poll(() => asked).toBeGreaterThan(0);
  await page.waitForTimeout(1500);
  // The still stays; the failed clip is dropped (the player shows the stills there).
  expect(['cover', 'pictures']).toContain(await showing(page));
  await expect(page.getByTestId('strip-still').or(page.getByTestId('strip-preview'))).toBeVisible();
  const s = await samples(page);
  expect(s.filter((x) => x.bad).map((x) => x.bad)).toEqual([]);
  expect(s.some((x) => x.showing === 'video')).toBe(false);
});
