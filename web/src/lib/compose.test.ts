// web/src/lib/compose.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aroundPreset, aroundRanges, composedName, isAvailable, madeOf, planAround, presetRolls, rollKeyStep, rollRange, rollValueText, secondsPast, sliderBounds, snapRoll, startJob } from './compose';

describe('compose helpers', () => {
  it('formats file names', () => {
    // The camera's local time, from the event id, like the original download (issue #72).
    expect(composedName('den', '20260928-140000-140020', 'sd')).toBe('den-2026-09-28_14-00-00-composed-sd.mp4');
  });
});

// The sliders (Klaus, 2026-10-04): their ranges never allow a result past the
// limit, and at least 1 s of the clip stays.
describe('rollRange and snapRoll', () => {
  it('for a 114 s clip at SD: pre up to 186 with no post-roll, down to -113', () => {
    expect(rollRange(114, 0, 'sd')).toEqual({ min: -113, max: 186 });
    expect(rollRange(114, 30, 'sd')).toEqual({ min: -113, max: 156 }); // image 16's post-roll
    expect(rollRange(114, -100, 'sd')).toEqual({ min: -13, max: 286 }); // 1 s must stay
    expect(rollRange(114, 0, '1080p')).toEqual({ min: -113, max: 6 });
  });
  it('a clip between the generated and the plain limit: 0 (the plain save) or at most the generated limit', () => {
    const r = rollRange(400, 0, 'sd');
    expect(r).toEqual({ min: -399, max: 0, gapFrom: -100 });
    expect(snapRoll(-30, r)).toBe(0);
    expect(snapRoll(-70, r)).toBe(-100);
    expect(snapRoll(-150, r)).toBe(-150);
    expect(snapRoll(5, r)).toBe(0);
    expect(rollRange(400, -50, 'sd')).toEqual({ min: -349, max: -50 }); // already generated: no gap
  });
  // Review of #176: each slider's own track is fixed by the clip and the
  // limit (not by the other roll), so 0 stays where it is; the value is
  // clamped to rollRange instead.
  it('fixes the slider track to the clip and the limit', () => {
    expect(sliderBounds(114, 'sd')).toEqual({ min: -113, max: 186 });
    expect(sliderBounds(114, '1080p')).toEqual({ min: -113, max: 6 });
    expect(sliderBounds(400, 'sd')).toEqual({ min: -399, max: 0 });
    expect(sliderBounds(700, 'sd')).toEqual({ min: -699, max: 0 });
    expect(snapRoll(186, rollRange(114, 30, 'sd'))).toBe(156); // dragged past what the other roll leaves
  });

  it('clamps and rounds', () => {
    expect(snapRoll(500, { min: -10, max: 186 })).toBe(186);
    expect(snapRoll(-20.4, { min: -10, max: 186 })).toBe(-10);
    expect(snapRoll(3.6, { min: -10, max: 186 })).toBe(4);
  });
  it('presets a cut at the end only for a clip longer than a plain save', () => {
    expect(presetRolls(114)).toEqual({ preS: 0, postS: 0, note: '' });
    expect(presetRolls(600)).toEqual({ preS: 0, postS: 0, note: '' });
    expect(presetRolls(700)).toEqual({ preS: 0, postS: -400, note: 'This recording is 11m 40s, longer than a save can be: the post-roll cuts it to 5m at its end.' });
  });
});

describe('isAvailable', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is true when cams could not ask the proxy (502), false only when it says so (issue #76)', async () => {
    vi.stubGlobal('fetch', async () => new Response('{"error":"proxy_unavailable"}', { status: 502 }));
    expect(await isAvailable('den', '20260928-140000-140020')).toBe(true);
    vi.stubGlobal('fetch', async () => new Response('{"available":false}', { status: 200 }));
    expect(await isAvailable('den', '20260928-140000-140020')).toBe(false);
  });
});

// Klaus, 2026-10-04: the pre-roll slider runs right to left, so the two read
// as the window around the clip: left adds pre-roll (an earlier start), right
// cuts; the post-roll slider stays left to right.
describe('the roll sliders’ keys and spoken values', () => {
  it('← is an earlier start on the pre-roll, a shorter end on the post-roll', () => {
    expect(rollKeyStep('pre', 'ArrowLeft')).toBe(1);
    expect(rollKeyStep('pre', 'ArrowRight')).toBe(-1);
    expect(rollKeyStep('post', 'ArrowLeft')).toBe(-1);
    expect(rollKeyStep('post', 'ArrowRight')).toBe(1);
    expect(rollKeyStep('pre', 'ArrowUp')).toBeNull(); // the browser's own: up adds
    expect(rollKeyStep('pre', 'Home')).toBeNull();
  });
  it('says what a value does', () => {
    expect(rollValueText('pre', 30)).toBe('starts 30 s earlier');
    expect(rollValueText('pre', -20)).toBe('cuts 20 s');
    expect(rollValueText('pre', 0)).toBe('no pre-roll');
    expect(rollValueText('post', 45)).toBe('ends 45 s later');
    expect(rollValueText('post', -1)).toBe('cuts 1 s');
    expect(rollValueText('post', 0)).toBe('no post-roll');
  });
});

// "Save clip around this" (#179 phase 3): the dialog's at-mode.
describe('around a second', () => {
  afterEach(() => vi.unstubAllGlobals());
  const AT = Date.UTC(2026, 9, 4, 19, 3, 22);

  it('counts the seconds already past (the window must have ended)', () => {
    expect(secondsPast(AT, AT + 60_000)).toBe(59);
    expect(secondsPast(AT, AT + 11_000)).toBe(10);
    expect(secondsPast(AT, AT + 11_999)).toBe(10);
    expect(secondsPast(AT, AT + 500)).toBe(0);
  });

  it('opens at -10/+10, the post-roll capped at the seconds past', () => {
    expect(aroundPreset(600)).toEqual({ preS: 10, postS: 10 });
    expect(aroundPreset(4)).toEqual({ preS: 10, postS: 4 });
    expect(aroundPreset(0)).toEqual({ preS: 10, postS: 0 });
  });

  it('keeps both rolls at 0 or more and the result within the size limit', () => {
    expect(aroundRanges(10, 10, 'sd', 600)).toEqual({ pre: { min: 0, max: 289 }, post: { min: 0, max: 289 }, preTrack: { min: 0, max: 299 }, postTrack: { min: 0, max: 299 } });
    expect(aroundRanges(10, 10, '1080p', 600)).toEqual({ pre: { min: 0, max: 109 }, post: { min: 0, max: 109 }, preTrack: { min: 0, max: 119 }, postTrack: { min: 0, max: 119 } });
    // A second 5 s ago: the post-roll stops at 4.
    expect(aroundRanges(10, 0, 'sd', 4)).toEqual({ pre: { min: 0, max: 299 }, post: { min: 0, max: 4 }, preTrack: { min: 0, max: 299 }, postTrack: { min: 0, max: 4 } });
    // Over the limit after a size change: the range never goes below 0.
    expect(aroundRanges(200, 10, '1080p', 600).pre).toEqual({ min: 0, max: 109 });
    expect(aroundRanges(200, 10, '1080p', 600).post).toEqual({ min: 0, max: 0 });
  });

  it('says what the clip is made of', () => {
    const clock = (t: number) => new Date(t).toISOString().slice(11, 19);
    expect(madeOf({ seconds: { clip: 0, still: 21, card: 0 }, clips: [] }, clock)).toBe('Stills only (1 per second)');
    expect(madeOf({ seconds: { clip: 21, still: 0, card: 0 }, clips: [{ start: AT - 30_000, end: AT + 20_000 }] }, clock)).toBe('FTP clip 19:02:52–19:03:42');
    expect(madeOf({ seconds: { clip: 14, still: 7, card: 0 }, clips: [{ start: AT - 3000, end: AT + 40_000 }] }, clock)).toBe('FTP clip 19:03:19–19:04:02 and stills (1 per second)');
    expect(madeOf({ seconds: { clip: 0, still: 18, card: 3 }, clips: [] }, clock)).toBe('Stills only (1 per second) · 3s without a recording');
    expect(madeOf({ seconds: { clip: 5, still: 0, card: 70 }, clips: [{ start: AT, end: AT + 5000 }, { start: AT + 9000, end: AT + 10_000 }] }, clock)).toBe('FTP clips 19:03:22–19:03:27, 19:03:31–19:03:32 · 1m 10s without a recording');
  });

  it('asks for the plan with a dry run: the plan, nothing, or unknown', async () => {
    let body: unknown;
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ start: AT - 10_000, end: AT + 11_000, durationS: 21, seconds: { clip: 0, still: 21, card: 0 }, clips: [] }), { status: 200 });
    });
    expect(await planAround('den', { at: AT, preS: 10, postS: 10, size: 'sd' })).toEqual({ kind: 'plan', plan: { seconds: { clip: 0, still: 21, card: 0 }, clips: [] } });
    expect(body).toEqual({ at: AT, preS: 10, postS: 10, size: 'sd', badge: true, dryRun: true });
    vi.stubGlobal('fetch', async () => new Response('{"error":"nothing_to_compose","detail":"no clip or still covers any second of this window"}', { status: 409 }));
    expect(await planAround('den', { at: AT, preS: 10, postS: 10, size: 'sd' })).toEqual({ kind: 'nothing' });
    vi.stubGlobal('fetch', async () => new Response('{"error":"proxy_unavailable"}', { status: 502 }));
    expect(await planAround('den', { at: AT, preS: 10, postS: 10, size: 'sd' })).toEqual({ kind: 'unknown' });
  });

  it('starts a job around a second and words the refusals', async () => {
    let body: unknown;
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ id: 'x'.repeat(22), state: 'running', progress: 0, durationS: 21, name: 'den-2026-10-04_14-03-22-around.mp4' }), { status: 201 });
    });
    expect(await startJob('den', { at: AT, preS: 10, postS: 10, size: '720p', badge: true })).toMatchObject({ durationS: 21, name: 'den-2026-10-04_14-03-22-around.mp4' });
    expect(body).toEqual({ at: AT, preS: 10, postS: 10, size: '720p', badge: true });
    vi.stubGlobal('fetch', async () => new Response('{"error":"nothing_to_compose","detail":"no clip or still covers any second of this window"}', { status: 409 }));
    await expect(startJob('den', { at: AT, preS: 10, postS: 10, size: 'sd', badge: true })).rejects.toThrow('Nothing is kept around this second (stills and clips are kept 7 days).');
    vi.stubGlobal('fetch', async () => new Response('{"error":"rate_limited"}', { status: 429 }));
    await expect(startJob('den', { at: AT, preS: 10, postS: 10, size: 'sd', badge: true })).rejects.toThrow('Too many clips this minute; try again shortly.');
  });
});
