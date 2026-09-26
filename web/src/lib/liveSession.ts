import { retryDelayMs, STANDBY_RETRY_MS, SWAP_AFTER_MS } from './live';

export type PlayerState = 'connecting' | 'playing' | 'reconnecting';

export interface Player {
  attach(video: HTMLVideoElement): void;
  load(): void;
  play(): void;
  destroy(): void;
  onFailure(cb: () => void): void;
}

export type PlayerFactory = (url: string) => Player;

interface Slot {
  player: Player;
  onPlaying: () => void;
}

// Owns the two <video> elements of one live view. One is "active" (visible);
// every SWAP_AFTER_MS a fresh connection starts on the other one and takes
// over once it is actually playing, so the server-side response limit never
// shows. A failure of the active stream reconnects with backoff; a failure
// of the standby just retries the swap later. Framework-free for testing.
export class LiveSession {
  private slots: [Slot | null, Slot | null] = [null, null];
  private active: 0 | 1 = 0;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private reconnecting = false;

  constructor(
    private readonly videos: [HTMLVideoElement, HTMLVideoElement],
    private readonly url: string,
    private readonly factory: PlayerFactory,
    private readonly onState: (s: 'connecting' | 'playing' | 'reconnecting') => void,
    private readonly onActive: (index: 0 | 1) => void,
  ) {}

  start(): void {
    this.onState('connecting');
    this.launch(0);
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
    this.slots.forEach((_, i) => this.drop(i as 0 | 1));
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number, fn: () => void): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.stopped) fn();
    }, ms);
  }

  private drop(i: 0 | 1): void {
    const slot = this.slots[i];
    if (!slot) return;
    this.slots[i] = null;
    this.videos[i].removeEventListener('playing', slot.onPlaying);
    try {
      slot.player.destroy();
    } catch {
      // player already broken; nothing to release
    }
  }

  private launch(i: 0 | 1): void {
    this.drop(i);
    if (i === this.active) this.reconnecting = false;
    const player = this.factory(this.url);
    const slot: Slot = { player, onPlaying: () => this.playing(i, slot) };
    this.slots[i] = slot;
    this.videos[i].addEventListener('playing', slot.onPlaying);
    player.onFailure(() => this.failed(i, slot));
    player.attach(this.videos[i]);
    player.load();
    player.play();
  }

  private playing(i: 0 | 1, slot: Slot): void {
    if (this.stopped || this.slots[i] !== slot) return;
    this.videos[i].removeEventListener('playing', slot.onPlaying);
    const other = (1 - i) as 0 | 1;
    this.active = i;
    this.attempt = 0;
    this.reconnecting = false;
    this.onActive(i);
    this.drop(other);
    this.onState('playing');
    this.schedule(SWAP_AFTER_MS, () => this.launch(other));
  }

  private failed(i: 0 | 1, slot: Slot): void {
    if (this.stopped || this.slots[i] !== slot) return; // stale player
    this.drop(i);
    if (i !== this.active) {
      // Standby failure. If the active stream is still alive, just retry the
      // swap later. If the active is dead, its own reconnect is already
      // pending (or about to be scheduled by its own failed() call) — don't
      // steal that timer or double-count the backoff attempt.
      const activeAlive = this.slots[this.active] !== null;
      if (activeAlive) {
        this.schedule(STANDBY_RETRY_MS, () => this.launch(i));
      }
      return;
    }
    this.onState('reconnecting');
    this.reconnecting = true;
    const delay = retryDelayMs(this.attempt++);
    this.schedule(delay, () => this.launch(i));
  }
}
