// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetSessionState } from './api';
import { get } from 'svelte/store';
import { createEventStream, groupPending, prunePending, type EventSourceLike } from './eventStream';
import { cameras } from './stores';

afterEach(() => vi.useRealTimers());

// A stand-in for the browser's EventSource.
class FakeSource implements EventSourceLike {
  static last: FakeSource;
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, ((e: { data: string }) => void)[]>();
  closed = false;
  constructor(readonly url: string) {
    FakeSource.last = this;
  }
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  fail() {
    this.readyState = 0;
    this.onerror?.();
  }
  refuse() {
    // A non-200 answer on reconnect (401, 429, 503): EventSource gives up.
    this.readyState = 2;
    this.onerror?.();
  }
  emit(type: string, data: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(data) });
  }
}

describe('createEventStream', () => {
  const make = () => createEventStream({ url: '/api/events/stream', factory: (url) => new FakeSource(url) });

  it('streams a camera only while connected and its proxy is up', () => {
    const s = make();
    expect(FakeSource.last.url).toBe('/api/events/stream');
    expect(s.streaming('den')).toBe(false);
    FakeSource.last.open();
    FakeSource.last.emit('proxy', { cam: 'den', up: true });
    expect(s.streaming('den')).toBe(true);
    expect(s.streaming('shed')).toBe(false);
    FakeSource.last.emit('proxy', { cam: 'den', up: false });
    expect(s.streaming('den')).toBe(false);
    FakeSource.last.emit('proxy', { cam: 'den', up: true });
    FakeSource.last.fail(); // cams restarting, or Knative's 600 s cut: polling until it's back
    expect(s.streaming('den')).toBe(false);
    s.close();
    expect(FakeSource.last.closed).toBe(true);
  });

  // cam-proxy's archive contract §7: the Archive page reloads on it.
  it('tells archive listeners what changed, and drops a malformed message', () => {
    const s = make();
    FakeSource.last.open();
    const got = vi.fn();
    const stop = s.onArchive(got);
    FakeSource.last.emit('archive', { cam: 'den', action: 'add', ids: [12] });
    FakeSource.last.emit('archive', { cam: 'den', action: 'add' });
    expect(got.mock.calls).toEqual([[{ cam: 'den', action: 'add', ids: [12] }]]);
    stop();
    FakeSource.last.emit('archive', { cam: 'den', action: 'delete', ids: [12] });
    expect(got).toHaveBeenCalledTimes(1);
    s.close();
  });

  it('tells watchers about changes for their camera, debounced', () => {
    vi.useFakeTimers();
    const s = make();
    FakeSource.last.open();
    const den = vi.fn();
    const stop = s.watch(() => 'den', den, 1000);
    FakeSource.last.emit('change', { cam: 'den', type: 'camera-event', ts: 1 });
    FakeSource.last.emit('change', { cam: 'den', type: 'clip', ts: 2 });
    FakeSource.last.emit('change', { cam: 'shed', type: 'clip', ts: 3 });
    expect(den).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(den).toHaveBeenCalledTimes(1);
    stop();
    FakeSource.last.emit('change', { cam: 'den', type: 'clip', ts: 4 });
    vi.advanceTimersByTime(2000);
    expect(den).toHaveBeenCalledTimes(1);
    s.close();
  });

  // Final review I4: an HTTP error closes an EventSource for good; the
  // stream is opened again after a backoff, and pages reload what they missed.
  it('opens a new source after a refused reconnect, and tells watchers to reload', () => {
    vi.useFakeTimers();
    const s = make();
    const first = FakeSource.last;
    first.open();
    const den = vi.fn();
    s.watch(() => 'den', den, 1000);
    first.refuse();
    expect(first.closed).toBe(true);
    vi.advanceTimersByTime(5000);
    const second = FakeSource.last;
    expect(second).not.toBe(first);
    second.open();
    vi.advanceTimersByTime(1000);
    expect(den).toHaveBeenCalledTimes(1); // the reload after the gap
    // A transient network error: EventSource reconnects by itself, and the
    // reload follows once it is back.
    second.fail();
    second.open();
    vi.advanceTimersByTime(1000);
    expect(den).toHaveBeenCalledTimes(2);
    expect(FakeSource.last).toBe(second);
    s.close();
  });

  // Final review (Minor 9, re-graded): a recording still being written when
  // its event ends isn't listed yet; a second reload a minute later finds it.
  // Issue #153, R2: a refused stream may be an expired session, which the
  // stream itself can't tell; /api/me can.
  it('asks whether the session is still there when the stream is refused', async () => {
    resetSessionState();
    const fetch = vi.fn(async () => new Response(JSON.stringify({ email: 'a@b.c' }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    try {
      const s = make();
      FakeSource.last.refuse();
      expect(fetch).toHaveBeenCalledWith('/api/me', expect.anything());
      s.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reloads again a minute after an event ends', () => {
    vi.useFakeTimers();
    const s = make();
    FakeSource.last.open();
    const den = vi.fn();
    s.watch(() => 'den', den, 1000);
    FakeSource.last.emit('change', { cam: 'den', type: 'camera-event', ts: 1 });
    vi.advanceTimersByTime(1000);
    expect(den).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(den).toHaveBeenCalledTimes(2);
    s.close();
  });

  it('ignores malformed frames', () => {
    const s = make();
    FakeSource.last.open();
    for (const fn of [() => FakeSource.last.emit('proxy', 'nope')]) expect(fn).not.toThrow();
    expect(s.streaming('den')).toBe(false);
    s.close();
  });

  it('re-reads the camera list when a proxy is switched on or off', () => {
    const onCameras = vi.fn();
    const s = createEventStream({ url: '/api/events/stream', factory: (url) => new FakeSource(url), onCameras });
    FakeSource.last.open();
    FakeSource.last.emit('cameras', {});
    expect(onCameras).toHaveBeenCalledTimes(1);
    s.close();
  });

  // The camera's name (design camera-name-design.md): the picker, titles and
  // cards switch at once, without a reload.
  it("switches a camera's shown name on a `camera` message", () => {
    cameras.set([
      { id: 'den', name: 'Den', webUiUrl: null, proxy: true },
      { id: 'shed', name: 'Shed', webUiUrl: null },
    ]);
    const s = make();
    FakeSource.last.open();
    FakeSource.last.emit('camera', { cam: 'den', name: 'Backyard Left' });
    expect(get(cameras).map((c) => c.name)).toEqual(['Backyard Left', 'Shed']);
    expect(get(cameras)[0]).toMatchObject({ id: 'den', proxy: true }); // the id and the rest stay
    for (const bad of [{ cam: 'den' }, { cam: 'den', name: '' }, { name: 'X' }, 'nope']) FakeSource.last.emit('camera', bad);
    FakeSource.last.emit('camera', { cam: 'unknown', name: 'X' });
    expect(get(cameras).map((c) => c.name)).toEqual(['Backyard Left', 'Shed']);
    s.close();
    cameras.set([]);
  });

  it('re-reads the camera list after a reconnect (a rename may have been missed)', () => {
    const onCameras = vi.fn();
    const s = createEventStream({ url: '/api/events/stream', factory: (url) => new FakeSource(url), onCameras });
    FakeSource.last.open();
    expect(onCameras).not.toHaveBeenCalled();
    FakeSource.last.fail();
    FakeSource.last.open();
    expect(onCameras).toHaveBeenCalledTimes(1);
    s.close();
  });

  it('reports a started camera event with its kind (Klaus, 2026-09-28)', () => {
    const s = make();
    FakeSource.last.open();
    const seen: unknown[] = [];
    const stop = s.onCameraEvent((e) => seen.push(e));
    FakeSource.last.emit('change', { cam: 'den', type: 'camera-event', ts: 5, kind: 'person', phase: 'start' });
    FakeSource.last.emit('change', { cam: 'den', type: 'camera-event', ts: 9, kind: 'person', phase: 'end' });
    FakeSource.last.emit('change', { cam: 'den', type: 'clip', ts: 5 });
    stop();
    FakeSource.last.emit('change', { cam: 'den', type: 'camera-event', ts: 12, kind: 'motion', phase: 'start' });
    expect(seen).toEqual([{ cam: 'den', kind: 'person', ts: 5 }]);
    s.close();
  });

  it('hands every change to onChange listeners at once, a still check included (cams #179)', () => {
    const s = make();
    FakeSource.last.open();
    const seen: unknown[] = [];
    const stop = s.onChange((c) => seen.push(c));
    FakeSource.last.emit('change', { cam: 'den', type: 'still-check', ts: 7000 });
    stop();
    FakeSource.last.emit('change', { cam: 'den', type: 'still-check', ts: 8000 });
    expect(seen).toEqual([{ cam: 'den', type: 'still-check', ts: 7000 }]);
    s.close();
  });
});


describe('prunePending (live events waiting for their recording)', () => {
  it('drops an event that happened inside a listed recording, not only near its start (review #4)', () => {
    const now = 10_000_000;
    const long = { id: 'y', start: new Date(now - 400_000).toISOString(), end: new Date(now - 100_000).toISOString(), durationSec: 300, triggers: ['motion' as const], sizeSub: 1, sizeMain: 1 };
    expect(prunePending([{ kind: 'person', ts: now - 250_000 }], [long], now)).toEqual([]);
  });

  const ev = (startMs: number) => ({ id: 'x', start: new Date(startMs).toISOString(), end: new Date(startMs + 20_000).toISOString(), durationSec: 20, triggers: ['motion' as const], sizeSub: 1, sizeMain: 1 });
  it('drops an event once its recording is listed (the camera starts a few seconds early), or after 15 minutes', () => {
    const now = 10_000_000;
    const pending = [{ kind: 'person', ts: now - 200_000 }, { kind: 'motion', ts: now - 16 * 60_000 }, { kind: 'pet', ts: now - 30_000 }];
    // person: its recording starts 4 s earlier; motion: too old; pet: still waiting
    expect(prunePending(pending, [ev(now - 204_000)], now)).toEqual([{ kind: 'pet', ts: now - 30_000 }]);
  });
});

describe('a closed stream (review #2)', () => {
  it('no longer claims to stream, so pages go back to polling', () => {
    const s = createEventStream({ url: '/x', factory: (u) => new FakeSource(u) });
    FakeSource.last.open();
    FakeSource.last.emit('proxy', { cam: 'den', up: true });
    expect(s.streaming('den')).toBe(true);
    s.close();
    expect(s.streaming('den')).toBe(false);
  });
});


// Klaus, 2026-09-30: one row per recording. The camera extends a recording
// while events keep coming; on cam1 (24 h, 96 events) events of one clip were
// at most 25 s apart and events of consecutive clips at least 22 s.
describe('groupPending (one row per recording in progress)', () => {
  const t0 = 1_790_000_000_000;
  it('groups events at most 20 s after the previous one, newest group first', () => {
    const groups = groupPending([
      { kind: 'motion', ts: t0 },
      { kind: 'person', ts: t0 + 3_000 },
      { kind: 'motion', ts: t0 + 23_000 }, // 20 s after the previous: same recording
      { kind: 'motion', ts: t0 + 44_000 }, // 21 s: a new one
      { kind: 'pet', ts: t0 + 50_000 },
    ]);
    expect(groups).toEqual([
      { start: t0 + 44_000, ts: t0 + 50_000, kinds: ['pet', 'motion'] },
      { start: t0, ts: t0 + 23_000, kinds: ['person', 'motion'] },
    ]);
  });

  it('takes events in any order and lists each kind once, AI kinds first', () => {
    expect(groupPending([
      { kind: 'motion', ts: t0 + 5_000 },
      { kind: 'vehicle', ts: t0 + 9_000 },
      { kind: 'motion', ts: t0 },
      { kind: 'person', ts: t0 + 2_000 },
    ])).toEqual([{ start: t0, ts: t0 + 9_000, kinds: ['person', 'vehicle', 'motion'] }]);
  });

  it('is empty for no events', () => {
    expect(groupPending([])).toEqual([]);
  });
});
