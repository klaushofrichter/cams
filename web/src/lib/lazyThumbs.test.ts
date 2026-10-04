// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createThumbQueue, lazySrc, resetLazyThumbs, THUMB_CONCURRENCY, THUMB_ROOT_MARGIN } from './lazyThumbs';

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

  // Review of #175: the margin must apply to the box the cards scroll in
  // (the desktop sidebar's list), not the window.
  it('observes within the nearest scroll container, with the margin, one observer per box', () => {
    vi.stubGlobal('IntersectionObserver', FakeIO);
    const box = document.createElement('div');
    box.style.overflowY = 'auto';
    const inner = document.createElement('div');
    box.append(inner);
    document.body.append(box);
    const a = document.createElement('img');
    const b = document.createElement('img');
    inner.append(a, b);
    lazySrc(a, '/a.jpg');
    lazySrc(b, '/b.jpg');
    expect(FakeIO.all).toHaveLength(1);
    expect(FakeIO.all[0].opts?.root).toBe(box);
    expect(FakeIO.all[0].opts?.rootMargin).toBe(THUMB_ROOT_MARGIN);
    expect(THUMB_ROOT_MARGIN).toBe('300px 0px');
    // Where the page itself scrolls (a phone): the viewport.
    const loose = document.createElement('img');
    document.body.append(loose);
    lazySrc(loose, '/c.jpg');
    expect(FakeIO.all).toHaveLength(2);
    expect(FakeIO.all[1].opts?.root ?? null).toBeNull();
    box.remove();
    loose.remove();
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
