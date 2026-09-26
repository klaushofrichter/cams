// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveSession, type Player, type PlayerState } from './liveSession';
import { SWAP_AFTER_MS } from './live';

class FakePlayer implements Player {
  video: HTMLVideoElement | null = null;
  destroyed = false;
  throwOnDestroy = false;
  failure: (() => void) | null = null;
  attach(v: HTMLVideoElement) { this.video = v; }
  load() {}
  play() {}
  destroy() {
    this.destroyed = true;
    if (this.throwOnDestroy) throw new Error('destroy failed');
  }
  onFailure(cb: () => void) { this.failure = cb; }
  // Test helpers
  startPlaying() { this.video!.dispatchEvent(new Event('playing')); }
  fail() { this.failure!(); }
}

let players: FakePlayer[];
let states: PlayerState[];
let active: number[];
let videos: [HTMLVideoElement, HTMLVideoElement];

function session() {
  return new LiveSession(
    videos,
    '/api/cameras/cam1/live?quality=sub',
    () => {
      const p = new FakePlayer();
      players.push(p);
      return p;
    },
    (s) => states.push(s),
    (i) => active.push(i),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  players = [];
  states = [];
  active = [];
  videos = [document.createElement('video'), document.createElement('video')];
});
afterEach(() => vi.useRealTimers());

describe('LiveSession', () => {
  it('connects on the first video and reports playing', () => {
    const s = session();
    s.start();
    expect(states).toEqual(['connecting']);
    expect(players[0].video).toBe(videos[0]);
    players[0].startPlaying();
    expect(states.at(-1)).toBe('playing');
    expect(active).toEqual([0]);
    s.stop();
  });

  it('swaps to a fresh connection on the other video after 9 minutes, then drops the old one', () => {
    const s = session();
    s.start();
    players[0].startPlaying();
    vi.advanceTimersByTime(SWAP_AFTER_MS);
    expect(players).toHaveLength(2);
    expect(players[1].video).toBe(videos[1]);
    expect(players[0].destroyed).toBe(false); // old keeps playing until the new one does
    players[1].startPlaying();
    expect(active.at(-1)).toBe(1);
    expect(players[0].destroyed).toBe(true);
    expect(states.filter((x) => x === 'reconnecting')).toHaveLength(0);
    s.stop();
  });

  // Review focus 1: a failing active stream reconnects with backoff and recovers.
  it('reconnects the active stream with backoff and recovers', () => {
    const s = session();
    s.start();
    players[0].startPlaying();
    players[0].fail();
    expect(states.at(-1)).toBe('reconnecting');
    expect(players[0].destroyed).toBe(true);
    vi.advanceTimersByTime(999);
    expect(players).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(players).toHaveLength(2);
    players[1].fail();
    vi.advanceTimersByTime(1999);
    expect(players).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(players).toHaveLength(3);
    players[2].startPlaying();
    expect(states.at(-1)).toBe('playing');
    s.stop();
  });

  it('keeps the active stream when the standby fails, and retries the swap', () => {
    const s = session();
    s.start();
    players[0].startPlaying();
    vi.advanceTimersByTime(SWAP_AFTER_MS);
    players[1].fail();
    expect(players[1].destroyed).toBe(true);
    expect(players[0].destroyed).toBe(false);
    expect(states.at(-1)).toBe('playing');
    vi.advanceTimersByTime(5000);
    expect(players).toHaveLength(3);
    s.stop();
  });

  // Review focus 4: teardown leaves nothing running.
  it('stop() destroys every player and cancels timers', () => {
    const s = session();
    s.start();
    players[0].startPlaying();
    s.stop();
    expect(players.every((p) => p.destroyed)).toBe(true);
    vi.advanceTimersByTime(SWAP_AFTER_MS * 2);
    expect(players).toHaveLength(1);
  });

  it('ignores failures from players it already replaced', () => {
    const s = session();
    s.start();
    players[0].startPlaying();
    vi.advanceTimersByTime(SWAP_AFTER_MS);
    players[1].startPlaying();
    players[0].fail(); // late error from the destroyed player
    expect(states.at(-1)).toBe('playing');
    expect(players).toHaveLength(2);
    s.stop();
  });

  // Review fix 1a: drop() must not abort when destroy() throws.
  it('recovers when the active player throws from destroy()', () => {
    const s = session();
    s.start();
    players[0].startPlaying();
    players[0].throwOnDestroy = true;
    players[0].fail();
    expect(states.at(-1)).toBe('reconnecting');
    vi.advanceTimersByTime(999);
    expect(players).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(players).toHaveLength(2);
    s.stop();
  });

  // Review fix 1b: stop() must destroy every slot even if one throws.
  it('stop() destroys every player even if one destroy() throws', () => {
    const s = session();
    s.start();
    players[0].startPlaying();
    vi.advanceTimersByTime(SWAP_AFTER_MS); // both slots now populated
    players[0].throwOnDestroy = true;
    expect(() => s.stop()).not.toThrow();
    expect(players[1].destroyed).toBe(true);
  });

  // Review fix 2: a late standby failure must not steal the active's pending reconnect timer.
  it('does not lose the active reconnect when the standby fails too', () => {
    const s = session();
    s.start();
    players[0].startPlaying();
    vi.advanceTimersByTime(SWAP_AFTER_MS); // standby (players[1]) launched
    players[0].fail(); // active fails: reconnect for index 0 scheduled at 1000ms
    players[1].fail(); // standby fails late; must not overwrite the pending timer
    vi.advanceTimersByTime(1000);
    expect(players).toHaveLength(3);
    expect(players[2].video).toBe(videos[0]);
    players[2].fail();
    vi.advanceTimersByTime(1999);
    expect(players).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(players).toHaveLength(4);
    s.stop();
  });
});
