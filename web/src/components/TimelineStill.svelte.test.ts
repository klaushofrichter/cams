// @vitest-environment jsdom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TimelineStill from './TimelineStill.svelte';
import type { StillObject, SummaryEntry } from '../lib/vision';

let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement | undefined;
afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  component = target = undefined;
});
const tick = () => new Promise((r) => setTimeout(r, 0));
const box = { x0: 0.1, y0: 0.2, x1: 0.3, y1: 0.9 };

function render(props: { summary: SummaryEntry[] | null; loadAll?: () => Promise<StillObject[]>; objectList?: boolean }) {
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(TimelineStill, { target, props: { src: '/s.jpg', alt: 'still', ...props } });
  flushSync();
  return target;
}
const labels = () => [...target!.querySelectorAll('[data-testid="timeline-box-label"]')].map((l) => l.textContent);

describe('TimelineStill', () => {
  it('draws a box and a label per summary entry, skipping zero-area boxes', () => {
    const t = render({ summary: [{ category: 'person', subtype: 'person', score: 0.84, box }, { category: 'pet', subtype: 'dog', score: 0.5, box: { x0: 0.5, y0: 0.5, x1: 0.5, y1: 0.5 } }] });
    expect(t.querySelectorAll('[data-testid="timeline-boxes"] rect')).toHaveLength(1);
    expect(labels()).toEqual(['Person 84%']);
  });

  // Klaus, 2026-10-01: "Clothing 56%" -- a capital first letter only, the rounded percent.
  it('labels a box with the name capitalised and the rounded percent', async () => {
    const loadAll = vi.fn(async () => [{ name: 'clothing', score: 0.556, box }, { name: 'ceiling fan', score: 0.904, box }, { name: 'Lamp', score: 0.5, box }]);
    const t = render({ summary: [{ category: 'pet', subtype: 'dog', score: 0.704, box }], loadAll });
    expect(labels()).toEqual(['Dog 70%']);
    (t.querySelector('[data-testid="timeline-show-all"]') as HTMLInputElement).click();
    await tick();
    flushSync();
    expect(labels()).toEqual(['Clothing 56%', 'Ceiling fan 90%', 'Lamp 50%']);
  });

  it('"Show all objects" loads them once and draws them; off again shows the summary', async () => {
    const loadAll = vi.fn(async () => [{ name: 'Person', score: 0.84, box }, { name: 'Ceiling fan', score: 0.7, box: { x0: 0.5, y0: 0, x1: 0.8, y1: 0.2 } }, { name: 'Clothing', score: 0.6, box: null }]);
    const t = render({ summary: [{ category: 'person', subtype: 'person', score: 0.84, box }], loadAll });
    const all = t.querySelector('[data-testid="timeline-show-all"]') as HTMLInputElement;
    all.click();
    await tick();
    flushSync();
    expect(labels()).toEqual(['Person 84%', 'Ceiling fan 70%']);
    all.click();
    flushSync();
    expect(labels()).toEqual(['Person 84%']);
    all.click();
    await tick();
    flushSync();
    expect(loadAll).toHaveBeenCalledTimes(1);
  });

  it('is a plain still for a second that was not analysed', () => {
    const t = render({ summary: null });
    expect(t.querySelector('[data-testid="timeline-still"]')?.getAttribute('src')).toBe('/s.jpg');
    expect(t.querySelector('[data-testid="timeline-boxes"]')).toBeNull();
    expect(t.querySelector('[data-testid="timeline-show-all"]')).toBeNull();
  });

  it('drops a stale loadAll result after src changes, and does not fetch twice for on/off/on', async () => {
    let resolveOld!: (o: StillObject[]) => void;
    const loadOld = vi.fn(() => new Promise<StillObject[]>((r) => (resolveOld = r)));
    const loadNew = vi.fn(async () => [{ name: 'Fresh', score: 0.9, box }]);
    const props = $state<{ src: string; alt: string; summary: SummaryEntry[] | null; loadAll: () => Promise<StillObject[]> }>({
      src: '/a.jpg',
      alt: 'still',
      summary: [{ category: 'person', subtype: 'person', score: 0.84, box }],
      loadAll: loadOld,
    });
    target = document.createElement('div');
    document.body.appendChild(target);
    component = mount(TimelineStill, { target, props });
    flushSync();
    const all = target.querySelector('[data-testid="timeline-show-all"]') as HTMLInputElement;
    all.click(); // on: pending
    all.click(); // off
    all.click(); // on again: reuses the in-flight request
    expect(loadOld).toHaveBeenCalledTimes(1);
    props.src = '/b.jpg';
    props.loadAll = loadNew;
    flushSync();
    resolveOld([{ name: 'Stale', score: 0.5, box }]);
    await tick();
    flushSync();
    expect(labels()).toEqual(['Person 84%']);
    all.click();
    await tick();
    flushSync();
    expect(loadNew).toHaveBeenCalledTimes(1);
    expect(labels()).toEqual(['Fresh 90%']);
  });

  // Issue #109 items.
  it('switches "Show all objects" back off and says so when they could not load, and tries again on the next click', async () => {
    let fail = true;
    const loadAll = vi.fn(async () => {
      if (fail) throw new Error('502');
      return [{ name: 'Lamp', score: 0.5, box }];
    });
    const t = render({ summary: [{ category: 'person', subtype: 'person', score: 0.84, box }], loadAll });
    const all = t.querySelector('[data-testid="timeline-show-all"]') as HTMLInputElement;
    all.click();
    await tick();
    flushSync();
    expect(all.checked).toBe(false);
    const msg = t.querySelector('[data-testid="timeline-show-all-failed"]');
    expect(msg?.textContent).toBe('Could not load all objects.');
    expect(msg?.getAttribute('role')).toBe('status');
    fail = false;
    all.click();
    await tick();
    flushSync();
    expect(loadAll).toHaveBeenCalledTimes(2);
    expect(labels()).toEqual(['Lamp 50%']);
    expect(t.querySelector('[data-testid="timeline-show-all-failed"]')?.textContent ?? '').toBe('');
  });

  it('starts another still on its summary: "Show all objects" off, no failure left', async () => {
    const props = $state<{ src: string; alt: string; summary: SummaryEntry[] | null; loadAll: () => Promise<StillObject[]> }>({
      src: '/a.jpg', alt: 'still', summary: [{ category: 'person', subtype: 'person', score: 0.84, box }], loadAll: async () => { throw new Error('502'); },
    });
    target = document.createElement('div');
    document.body.appendChild(target);
    component = mount(TimelineStill, { target, props });
    flushSync();
    (target.querySelector('[data-testid="timeline-show-all"]') as HTMLInputElement).click();
    await tick();
    flushSync();
    expect(target.querySelector('[data-testid="timeline-show-all-failed"]')?.textContent).toBe('Could not load all objects.');
    props.src = '/b.jpg';
    props.loadAll = async () => [{ name: 'Lamp', score: 0.5, box }];
    flushSync();
    expect(target.querySelector('[data-testid="timeline-show-all-failed"]')?.textContent ?? '').toBe('');
    expect((target.querySelector('[data-testid="timeline-show-all"]') as HTMLInputElement).checked).toBe(false);
    expect(labels()).toEqual(['Person 84%']);
  });

  it('keeps a label inside the picture at the top and right edges', () => {
    render({ summary: [
      { category: 'person', subtype: 'person', score: 0.84, box: { x0: 0.1, y0: 0.01, x1: 0.3, y1: 0.5 } },
      { category: 'pet', subtype: 'dog', score: 0.6, box: { x0: 0.8, y0: 0.5, x1: 0.99, y1: 0.9 } },
    ] });
    const [top, right] = [...target!.querySelectorAll('[data-testid="timeline-box-label"]')] as HTMLElement[];
    expect(top.classList.contains('inside')).toBe(true); // drawn inside the box, under its top edge
    expect(right.style.right).toBe('1%'); // ends at the box's right edge
    expect(right.style.left).toBe('');
  });
  // Issue #158: the analysis modal's object list, as cam-proxy's Timeline detail has it.
  describe('object list', () => {
    const objects = [{ name: 'person', score: 0.84, box }, { name: 'ceiling fan', score: 0.704, box: { x0: 0.5, y0: 0.05, x1: 0.8, y1: 0.2 } }, { name: 'Clothing', score: 0.6, box: null }];
    const rows = () => [...target!.querySelectorAll<HTMLButtonElement>('[data-testid="still-object"]')];
    const rects = () => target!.querySelectorAll('[data-testid="timeline-boxes"] rect').length;
    async function allOn() {
      const t = render({ summary: [{ category: 'person', subtype: 'person', score: 0.84, box }], loadAll: async () => objects, objectList: true });
      (t.querySelector('[data-testid="timeline-show-all"]') as HTMLInputElement).click();
      await tick();
      flushSync();
      return t;
    }
    const click = (el: HTMLElement) => {
      el.click();
      flushSync();
    };

    it('lists every object with its label and confidence in percent', async () => {
      await allOn();
      expect(rows().map((r) => [r.querySelector('.name')?.textContent, r.querySelector('.score')?.textContent])).toEqual([['Person', '84%'], ['Ceiling fan', '70%'], ['Clothing', '60%']]);
      // Buttons: Tab reaches them, Enter and Space press them.
      expect(rows().every((r) => r.tagName === 'BUTTON' && r.getAttribute('aria-pressed') === 'false')).toBe(true);
      expect(rows()[2].textContent).toContain('no box');
    });

    it('a click shows only that object’s box; the same click again shows them all', async () => {
      await allOn();
      expect(rects()).toBe(2);
      click(rows()[1]);
      expect(rects()).toBe(1);
      expect(labels()).toEqual(['Ceiling fan 70%']);
      expect(rows()[1].getAttribute('aria-pressed')).toBe('true');
      expect(rows()[1].classList.contains('sel')).toBe(true);
      click(rows()[0]); // another one: that one instead
      expect(labels()).toEqual(['Person 84%']);
      expect(rows()[1].getAttribute('aria-pressed')).toBe('false');
      click(rows()[0]);
      expect(labels()).toEqual(['Person 84%', 'Ceiling fan 70%']);
      expect(rows().every((r) => r.getAttribute('aria-pressed') === 'false')).toBe(true);
    });

    it('Plain still hides every box, with or without a selection; Boxes brings the selection back', async () => {
      const t = await allOn();
      const plain = t.querySelector('[data-testid="still-view-plain"]') as HTMLInputElement;
      const boxes = t.querySelector('[data-testid="still-view-boxes"]') as HTMLInputElement;
      expect(boxes.checked).toBe(true);
      click(plain);
      expect(rects()).toBe(0);
      expect(labels()).toEqual([]);
      click(boxes);
      expect(rects()).toBe(2);
      click(rows()[0]);
      click(plain);
      expect(rects()).toBe(0);
      expect(labels()).toEqual([]);
      click(rows()[1]); // the list still works in Plain: it picks for Boxes
      expect(rects()).toBe(0);
      click(boxes);
      expect(labels()).toEqual(['Ceiling fan 70%']);
    });

    it('Plain still also hides the summary’s boxes', () => {
      const t = render({ summary: [{ category: 'person', subtype: 'person', score: 0.84, box }], loadAll: async () => objects, objectList: true });
      expect(rects()).toBe(1);
      click(t.querySelector('[data-testid="still-view-plain"]') as HTMLInputElement);
      expect(rects()).toBe(0);
    });

    it('without "Show all objects" there is no list, and switching it off clears the selection', async () => {
      const t = render({ summary: [{ category: 'person', subtype: 'person', score: 0.84, box }], loadAll: async () => objects, objectList: true });
      expect(t.querySelector('[data-testid="still-objects"]')).toBeNull();
      expect(labels()).toEqual(['Person 84%']);
      const all = t.querySelector('[data-testid="timeline-show-all"]') as HTMLInputElement;
      all.click();
      await tick();
      flushSync();
      click(rows()[1]);
      all.click();
      flushSync();
      expect(t.querySelector('[data-testid="still-objects"]')).toBeNull();
      expect(labels()).toEqual(['Person 84%']);
      all.click();
      await tick();
      flushSync();
      expect(rows().every((r) => r.getAttribute('aria-pressed') === 'false')).toBe(true);
      expect(rects()).toBe(2);
    });

    it('is off by default: the Timeline page keeps its still as it was', async () => {
      const t = render({ summary: [{ category: 'person', subtype: 'person', score: 0.84, box }], loadAll: async () => objects });
      expect(t.querySelector('[data-testid="still-view-plain"]')).toBeNull();
      (t.querySelector('[data-testid="timeline-show-all"]') as HTMLInputElement).click();
      await tick();
      flushSync();
      expect(t.querySelector('[data-testid="still-objects"]')).toBeNull();
      expect(rects()).toBe(2);
    });
  });
});
