// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createThumbQueue, lazySrc, resetLazyThumbs, THUMB_CONCURRENCY } from './lazyThumbs';

describe('createThumbQueue', () => {
  it('runs at most max at once, the next when one finishes', () => {
    const q = createThumbQueue(2);
    const done: (() => void)[] = [];
    const started: number[] = [];
    for (let i = 0; i < 5; i++) q.add({ start: (d) => { started.push(i); done.push(d); } });
    expect(started).toEqual([0, 1]);
    done[0]();
    done[0](); // twice is once
    expect(started).toEqual([0, 1, 2]);
    expect(q.active).toBe(2);
    expect(q.waiting).toBe(2);
  });

  it('drops a job cancelled before its turn', () => {
    const q = createThumbQueue(1);
    const started: string[] = [];
    let first!: () => void;
    q.add({ start: (d) => { started.push('a'); first = d; } });
    const cancel = q.add({ start: () => started.push('b') });
    q.add({ start: () => started.push('c') });
    cancel();
    first();
    expect(started).toEqual(['a', 'c']);
  });
});

// A stand-in IntersectionObserver the test drives.
class FakeIO {
  static all: FakeIO[] = [];
  nodes = new Set<Element>();
  constructor(public cb: IntersectionObserverCallback, public opts?: IntersectionObserverInit) { FakeIO.all.push(this); }
  observe(n: Element) { this.nodes.add(n); }
  unobserve(n: Element) { this.nodes.delete(n); }
  disconnect() { this.nodes.clear(); }
  show(n: Element, visible = true) { this.cb([{ target: n, isIntersecting: visible } as unknown as IntersectionObserverEntry], this as unknown as IntersectionObserver); }
}

describe('lazySrc', () => {
  afterEach(() => {
    resetLazyThumbs();
    FakeIO.all = [];
    vi.unstubAllGlobals();
  });

  it('loads eagerly without IntersectionObserver', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const img = document.createElement('img');
    lazySrc(img, '/a.jpg');
    expect(img.getAttribute('src')).toBe('/a.jpg');
  });

  it('sets src only once near the screen, with a margin, a few at a time', () => {
    vi.stubGlobal('IntersectionObserver', FakeIO);
    const imgs = Array.from({ length: 10 }, () => document.createElement('img'));
    imgs.forEach((img, i) => lazySrc(img, `/t${i}.jpg`));
    const io = FakeIO.all[0];
    expect(io.opts?.rootMargin).toMatch(/px/);
    expect(imgs.filter((i) => i.hasAttribute('src'))).toHaveLength(0);
    imgs.forEach((img) => io.show(img));
    expect(imgs.filter((i) => i.hasAttribute('src'))).toHaveLength(THUMB_CONCURRENCY);
    imgs[0].dispatchEvent(new Event('load'));
    expect(imgs.filter((i) => i.hasAttribute('src'))).toHaveLength(THUMB_CONCURRENCY + 1);
  });

  it('drops a card scrolled past before its turn (no storm on a fast scroll)', () => {
    vi.stubGlobal('IntersectionObserver', FakeIO);
    const imgs = Array.from({ length: THUMB_CONCURRENCY + 3 }, () => document.createElement('img'));
    imgs.forEach((img, i) => lazySrc(img, `/t${i}.jpg`));
    const io = FakeIO.all[0];
    imgs.forEach((img) => io.show(img));
    for (const img of imgs.slice(THUMB_CONCURRENCY)) io.show(img, false); // gone before their turn
    for (const img of imgs.slice(0, THUMB_CONCURRENCY)) img.dispatchEvent(new Event('load'));
    expect(imgs.filter((i) => i.hasAttribute('src'))).toHaveLength(THUMB_CONCURRENCY);
  });

  it('frees its slot when the card goes away while loading', () => {
    vi.stubGlobal('IntersectionObserver', FakeIO);
    const imgs = Array.from({ length: THUMB_CONCURRENCY + 1 }, () => document.createElement('img'));
    const actions = imgs.map((img, i) => lazySrc(img, `/t${i}.jpg`));
    imgs.forEach((img) => FakeIO.all[0].show(img));
    expect(imgs.at(-1)!.hasAttribute('src')).toBe(false);
    actions[0].destroy();
    expect(imgs.at(-1)!.getAttribute('src')).toBe(`/t${THUMB_CONCURRENCY}.jpg`);
  });
});
