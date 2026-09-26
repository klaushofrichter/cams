// A concurrency gate whose queue serves high-priority work first. Recording
// transfers use it so a clip someone is waiting to watch isn't stuck behind a
// page's worth of thumbnail fetches (the camera sends ~150 KB/s, one transfer
// at a time). A queued entry can be promoted by key when someone starts
// waiting on it directly.
interface Waiter {
  start: () => void;
  high: boolean;
  key?: string;
}

export class PriorityGate {
  private active = 0;
  private readonly queue: Waiter[] = [];

  constructor(private readonly max: number) {}

  run<T>(fn: () => Promise<T>, opts: { high?: boolean; key?: string } = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        fn()
          .then(resolve, reject)
          .finally(() => this.handOff());
      };
      if (this.active < this.max) {
        this.active++;
        start();
      } else {
        this.queue.push({ start, high: !!opts.high, key: opts.key });
      }
    });
  }

  // Moves a queued entry with this key ahead of all low-priority work.
  promote(key: string): void {
    const w = this.queue.find((q) => q.key === key);
    if (w) w.high = true;
  }

  // Hands the slot straight to the next waiter (high priority first, then
  // FIFO) without freeing it in between, so no newcomer can jump the queue.
  private handOff(): void {
    const i = this.queue.findIndex((q) => q.high);
    const [next] = this.queue.splice(i >= 0 ? i : 0, 1);
    if (next) next.start();
    else this.active--;
  }
}
