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

function render(props: { summary: SummaryEntry[] | null; loadAll?: () => Promise<StillObject[]> }) {
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
    expect(labels()).toEqual(['person 0.84']);
  });

  it('"Show all objects" loads them once and draws them; off again shows the summary', async () => {
    const loadAll = vi.fn(async () => [{ name: 'Person', score: 0.84, box }, { name: 'Ceiling fan', score: 0.7, box: { x0: 0.5, y0: 0, x1: 0.8, y1: 0.2 } }, { name: 'Clothing', score: 0.6, box: null }]);
    const t = render({ summary: [{ category: 'person', subtype: 'person', score: 0.84, box }], loadAll });
    const all = t.querySelector('[data-testid="timeline-show-all"]') as HTMLInputElement;
    all.click();
    await tick();
    flushSync();
    expect(labels()).toEqual(['Person 0.84', 'Ceiling fan 0.70']);
    all.click();
    flushSync();
    expect(labels()).toEqual(['person 0.84']);
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
    expect(labels()).toEqual(['person 0.84']);
    all.click();
    await tick();
    flushSync();
    expect(loadNew).toHaveBeenCalledTimes(1);
    expect(labels()).toEqual(['Fresh 0.90']);
  });
});
