import { describe, expect, it } from 'vitest';
import { PriorityGate } from '../server/recordings/priorityGate';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe('PriorityGate', () => {
  it('runs high-priority work before queued low-priority work', async () => {
    const gate = new PriorityGate(1);
    const order: string[] = [];
    const first = deferred();
    const running = gate.run(async () => { order.push('first'); await first.promise; });
    const lows = ['a', 'b'].map((k) => gate.run(async () => { order.push(k); }, { key: k }));
    const high = gate.run(async () => { order.push('video'); }, { high: true });
    first.resolve();
    await Promise.all([running, high, ...lows]);
    expect(order).toEqual(['first', 'video', 'a', 'b']);
  });

  it('promotes a queued entry by key', async () => {
    const gate = new PriorityGate(1);
    const order: string[] = [];
    const first = deferred();
    const running = gate.run(async () => { order.push('first'); await first.promise; });
    const queued = ['a', 'b', 'c'].map((k) => gate.run(async () => { order.push(k); }, { key: k }));
    gate.promote('c');
    first.resolve();
    await Promise.all([running, ...queued]);
    expect(order).toEqual(['first', 'c', 'a', 'b']);
  });

  it('never exceeds its limit and frees the slot after a failure', async () => {
    const gate = new PriorityGate(2);
    let active = 0;
    let peak = 0;
    const job = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    };
    await Promise.allSettled([gate.run(job), gate.run(async () => { throw new Error('x'); }), gate.run(job), gate.run(job, { high: true }), gate.run(job)]);
    expect(peak).toBeLessThanOrEqual(2);
    expect(await gate.run(async () => 'ok')).toBe('ok');
  });
});
