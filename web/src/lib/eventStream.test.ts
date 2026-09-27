// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEventStream, type EventSourceLike } from './eventStream';

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

  it('ignores malformed frames', () => {
    const s = make();
    FakeSource.last.open();
    for (const fn of [() => FakeSource.last.emit('proxy', 'nope')]) expect(fn).not.toThrow();
    expect(s.streaming('den')).toBe(false);
    s.close();
  });
});
