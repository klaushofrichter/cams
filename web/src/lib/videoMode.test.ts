// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { LIVE_ONLY, NOTHING_TO_SAVE, currentPlayer, frameBlob, liveBadge, modeBadge, modeOf, registerPlayer, saveRecordingSnapshot, snapshotName, type PlayerFrame } from './videoMode';
import { liveUi } from './liveUi';
import { localClock } from './clock';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  liveUi.update((u) => ({ ...u, snapshotBusy: false, snapshotError: '' }));
});

describe('mode', () => {
  it('is live while glued to now, a recording otherwise', () => {
    expect(modeOf(true)).toBe('live');
    expect(modeOf(false)).toBe('rec');
  });

  it('badges live as ● LIVE and a recording with its time, the day only when not today', () => {
    const now = new Date(2026, 9, 4, 15, 0, 0).getTime();
    expect(modeBadge('live', now - 5000, now)).toBe('● LIVE');
    // The clock as the player's info line shows it (12 or 24 h, Settings).
    const today = new Date(2026, 9, 4, 14, 3, 22).getTime();
    expect(modeBadge('rec', today, now)).toBe(`REC ${localClock(today)}`);
    const yesterday = new Date(2026, 9, 3, 9, 5, 7).getTime();
    expect(modeBadge('rec', yesterday, now)).toBe(`REC Oct 3, ${localClock(yesterday)}`);
  });

  // Klaus, 2026-10-04: REC says what it shows: a clip's quality, or the stills.
  it('adds what a recording shows: SD, 4K or Still', () => {
    const now = new Date(2026, 9, 4, 15, 0, 0).getTime();
    const today = new Date(2026, 9, 4, 7, 18, 32).getTime();
    expect(modeBadge('rec', today, now, 'SD')).toBe(`REC ${localClock(today)} · SD`);
    expect(modeBadge('rec', today, now, '4K')).toBe(`REC ${localClock(today)} · 4K`);
    expect(modeBadge('rec', today, now, 'Still')).toBe(`REC ${localClock(today)} · Still`);
    const yesterday = new Date(2026, 9, 3, 9, 5, 7).getTime();
    expect(modeBadge('rec', yesterday, now, 'SD')).toBe(`REC Oct 3, ${localClock(yesterday)} · SD`);
    expect(modeBadge('rec', today, now, null)).toBe(`REC ${localClock(today)}`);
    expect(modeBadge('live', now, now, 'SD')).toBe('● LIVE');
  });

  // Review of #173: the badge says LIVE only while live video plays.
  it('badges live by what the stream does: LIVE, STILLS, Connecting…, Offline', () => {
    expect(liveBadge({ playerState: 'playing', stillsShowing: false, status: { id: 'c', online: true } })).toBe('● LIVE');
    expect(liveBadge({ playerState: 'connecting', stillsShowing: false, status: { id: 'c', online: true } })).toBe('Connecting…');
    expect(liveBadge({ playerState: 'reconnecting', stillsShowing: false, status: null })).toBe('Connecting…');
    expect(liveBadge({ playerState: 'connecting', stillsShowing: true, status: { id: 'c', online: true } })).toBe('● STILLS');
    expect(liveBadge({ playerState: 'connecting', stillsShowing: true, status: { id: 'c', online: false } })).toBe('Offline');
  });

  it('explains disabled live-only controls', () => {
    expect(LIVE_ONLY).toBe('Only in live mode');
  });
});

describe('snapshot names', () => {
  it('say live, rec or still, with the moment in UTC', () => {
    const t = Date.UTC(2026, 9, 4, 14, 3, 22);
    expect(snapshotName('cam1', 'live', t)).toBe('cam1-live-2026-10-04-14-03-22.jpg');
    expect(snapshotName('cam1', 'rec', t)).toBe('cam1-rec-2026-10-04-14-03-22.jpg');
    expect(snapshotName('den', 'still', t)).toBe('den-still-2026-10-04-14-03-22.jpg');
  });
});

// jsdom has no canvas: a fake one records what was drawn.
function fakeCanvas() {
  const drawn: unknown[][] = [];
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: (...a: unknown[]) => drawn.push(a) }), toBlob: (cb: (b: Blob | null) => void, type: string) => cb(new Blob(['jpg'], { type })) };
  const orig = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => (tag === 'canvas' ? canvas : orig(tag))) as typeof document.createElement);
  return { canvas, drawn };
}

describe('frameBlob', () => {
  it('draws a clip frame at the clip’s own resolution', async () => {
    const { canvas, drawn } = fakeCanvas();
    const video = { videoWidth: 896, videoHeight: 512, readyState: 4 } as unknown as HTMLVideoElement;
    const blob = await frameBlob({ kind: 'clip', video, at: 1 });
    expect(blob.type).toBe('image/jpeg');
    expect([canvas.width, canvas.height]).toEqual([896, 512]);
    expect(drawn[0]).toEqual([video, 0, 0]);
  });

  it('refuses a clip without a frame yet', async () => {
    fakeCanvas();
    const video = { videoWidth: 0, videoHeight: 0, readyState: 0 } as unknown as HTMLVideoElement;
    await expect(frameBlob({ kind: 'clip', video, at: 1 })).rejects.toThrow();
  });

  it('cuts a preview tile from its sprite', async () => {
    const { canvas, drawn } = fakeCanvas();
    const img = { onload: null as null | (() => void), onerror: null, set src(_v: string) { queueMicrotask(() => this.onload?.()); } };
    vi.stubGlobal('Image', function () { return img; } as unknown as typeof Image);
    const blob = await frameBlob({ kind: 'tile', url: '/api/cameras/den/previews/1.jpg', sx: 320, sy: 90, w: 160, h: 90, at: 1 });
    expect(blob.type).toBe('image/jpeg');
    expect([canvas.width, canvas.height]).toEqual([160, 90]);
    expect(drawn[0]).toEqual([img, 320, 90, 160, 90, 0, 0, 160, 90]);
  });

  it('fetches a still as it is, and refuses an error page', async () => {
    vi.stubGlobal('fetch', async () => new Response(new Blob(['x'], { type: 'image/jpeg' }), { status: 200, headers: { 'content-type': 'image/jpeg' } }));
    expect((await frameBlob({ kind: 'still', url: '/api/cameras/den/stills/1000.jpg', at: 1000 })).type).toBe('image/jpeg');
    vi.stubGlobal('fetch', async () => new Response('{"error":"x"}', { status: 404, headers: { 'content-type': 'application/json' } }));
    await expect(frameBlob({ kind: 'still', url: '/x.jpg', at: 1000 })).rejects.toThrow();
  });
});

describe('saveRecordingSnapshot', () => {
  it('saves what the player shows, named rec for a clip and still for a still', async () => {
    fakeCanvas();
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    });
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }));
    const t = Date.UTC(2026, 9, 4, 14, 3, 22);
    let frame: PlayerFrame = { kind: 'clip', video: { videoWidth: 2, videoHeight: 2, readyState: 4 } as unknown as HTMLVideoElement, at: t };
    const stop = registerPlayer({ frame: () => frame, fullscreen: () => {} });
    await saveRecordingSnapshot('cam1');
    vi.stubGlobal('fetch', async () => new Response(new Blob(['x']), { status: 200, headers: { 'content-type': 'image/jpeg' } }));
    frame = { kind: 'still', url: '/s.jpg', at: t };
    await saveRecordingSnapshot('cam1');
    const img = { onload: null as null | (() => void), onerror: null, set src(_v: string) { queueMicrotask(() => this.onload?.()); } };
    vi.stubGlobal('Image', function () { return img; } as unknown as typeof Image);
    frame = { kind: 'tile', url: '/p.jpg', sx: 0, sy: 0, w: 160, h: 90, at: t + 1000 };
    await saveRecordingSnapshot('cam1');
    expect(names).toEqual(['cam1-rec-2026-10-04-14-03-22.jpg', 'cam1-still-2026-10-04-14-03-22.jpg', 'cam1-still-2026-10-04-14-03-23.jpg']);
    expect(get(liveUi).snapshotError).toBe('');
    stop();
    expect(currentPlayer()).toBeNull();
  });

  // Review of #173: a gap ("No recording") has nothing to save; say that.
  it('says "Nothing to save here" where nothing is shown', async () => {
    const stop = registerPlayer({ frame: () => null, fullscreen: () => {} });
    await saveRecordingSnapshot('cam1');
    expect(get(liveUi).snapshotError).toBe(NOTHING_TO_SAVE);
    expect(NOTHING_TO_SAVE).toBe('Nothing to save here.');
    expect(get(liveUi).snapshotBusy).toBe(false);
    stop();
  });
});
