// web/src/lib/compose.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { composedName, isAvailable, presetRolls, rollKeyStep, rollRange, rollValueText, sliderBounds, snapRoll } from './compose';

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
