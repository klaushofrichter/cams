// web/src/lib/clipSwap.test.ts
import { describe, expect, it } from 'vitest';
import { enterClip, seekRequest, seekSettled, showClipVideo, SWAP_DWELL_MS, type SwapInput } from './clipSwap';

const URL_A = '/api/cameras/den/clips/a/video';
const URL_B = '/api/cameras/den/clips/b/video';
const base: SwapInput = {
  want: { url: URL_A, offsetS: 5 },
  slot: { url: URL_A, presentedS: 5, error: false },
  scrubbing: false,
  dwellMs: 0,
  shown: false,
};
const at = (patch: Partial<SwapInput>) => showClipVideo({ ...base, ...patch });

describe('showClipVideo: the clip video replaces the still only with a frame at the cursor', () => {
  it('shows the video once it presented a frame at the cursor, not scrubbing', () => {
    expect(at({})).toBe(true);
  });

  it('keeps the still outside a clip', () => {
    expect(at({ want: null })).toBe(false);
  });

  it('keeps the still while the video holds another clip or nothing yet', () => {
    expect(at({ slot: { url: URL_B, presentedS: 5, error: false } })).toBe(false);
    expect(at({ slot: { url: null, presentedS: null, error: false } })).toBe(false);
  });

  it('keeps the still until a frame was presented (loading, seeking)', () => {
    expect(at({ slot: { url: URL_A, presentedS: null, error: false } })).toBe(false);
  });

  it('keeps the still while the presented frame is more than 0.5 s from the cursor', () => {
    expect(at({ slot: { url: URL_A, presentedS: 4.4, error: false } })).toBe(false);
    expect(at({ slot: { url: URL_A, presentedS: 4.5, error: false } })).toBe(true);
    expect(at({ slot: { url: URL_A, presentedS: 5.6, error: false } })).toBe(false);
  });

  it('never shows a video that failed', () => {
    expect(at({ slot: { url: URL_A, presentedS: 5, error: true } })).toBe(false);
    expect(at({ slot: { url: URL_A, presentedS: 5, error: true }, shown: true })).toBe(false);
  });

  it('while scrubbing, waits for the dwell inside the clip', () => {
    expect(at({ scrubbing: true, dwellMs: 0 })).toBe(false);
    expect(at({ scrubbing: true, dwellMs: SWAP_DWELL_MS - 1 })).toBe(false);
    expect(at({ scrubbing: true, dwellMs: SWAP_DWELL_MS })).toBe(true);
  });

  it('no dwell once dragging stopped', () => {
    expect(at({ scrubbing: false, dwellMs: 0 })).toBe(true);
  });

  it('once shown and not scrubbing, stays (playback, a step: the element keeps its last frame)', () => {
    expect(at({ shown: true, slot: { url: URL_A, presentedS: null, error: false } })).toBe(true);
    expect(at({ shown: true, slot: { url: URL_A, presentedS: 9, error: false } })).toBe(true);
  });

  it('once shown, a scrub keeps it within 1 s of the cursor, then back to the still', () => {
    expect(at({ shown: true, scrubbing: true, dwellMs: 1000, slot: { url: URL_A, presentedS: 4.1, error: false } })).toBe(true);
    expect(at({ shown: true, scrubbing: true, dwellMs: 1000, slot: { url: URL_A, presentedS: 3.9, error: false } })).toBe(false);
    expect(at({ shown: true, scrubbing: true, dwellMs: 1000, slot: { url: URL_A, presentedS: null, error: false } })).toBe(false);
  });

  it('a shown video of another clip does not carry over', () => {
    expect(at({ shown: true, want: { url: URL_B, offsetS: 5 } })).toBe(false);
  });
});

describe('enterClip: when the cursor entered the clip under it', () => {
  it('starts on entering, keeps the time inside the same clip, resets on leaving or another clip', () => {
    const a = enterClip(null, 'a', 1000);
    expect(a).toEqual({ id: 'a', since: 1000 });
    expect(enterClip(a, 'a', 1500)).toBe(a);
    expect(enterClip(a, null, 1600)).toBeNull();
    expect(enterClip(a, 'b', 1700)).toEqual({ id: 'b', since: 1700 });
  });
});

describe('seekRequest / seekSettled: one seek in flight, only the newest target waits', () => {
  it('seeks at once when idle', () => {
    expect(seekRequest({ inFlight: false, pending: null }, 3)).toEqual({ next: { inFlight: true, pending: null }, seek: 3 });
  });

  it('keeps only the newest target while a seek is in flight', () => {
    let s = seekRequest({ inFlight: false, pending: null }, 1).next;
    s = seekRequest(s, 2).next;
    const r = seekRequest(s, 3);
    expect(r.seek).toBeNull();
    expect(r.next).toEqual({ inFlight: true, pending: 3 });
  });

  it('on seeked: the waiting target next, else idle', () => {
    const r = seekSettled({ inFlight: true, pending: 3 });
    expect(r).toEqual({ next: { inFlight: true, pending: null }, seek: 3 });
    expect(seekSettled(r.next)).toEqual({ next: { inFlight: false, pending: null }, seek: null });
  });
});
