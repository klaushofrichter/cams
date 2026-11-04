// @vitest-environment jsdom
//
// The events at the playhead are highlighted in the list (Klaus, 2026-11-04):
// on every rendered card, wherever it is scrolled to, and at once on a card
// that appears later. Nothing scrolls or opens for it.
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../lib/scroll', () => ({ scrollIntoContainer: vi.fn(() => true) }));
import EventList from './EventList.svelte';
import { scrollIntoContainer } from '../lib/scroll';
import { makeEvents } from './testing/eventFixtures';
import { ALL_KINDS } from '../lib/recordings';

const DATE = '2026-09-26';

let target: HTMLDivElement | undefined;
let component: Record<string, unknown> | undefined;
afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  target = undefined;
  component = undefined;
});

function render(events = makeEvents(DATE, 9, 3)) {
  const props = $state({
    cameraId: 'cam1', events, filter: ALL_KINDS, date: DATE, selectedId: null as string | null,
    atPlayhead: new Set<string>() as ReadonlySet<string>, onfilter: () => {}, onselect: () => {},
  });
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(EventList, { target, props }) as unknown as Record<string, unknown>;
  flushSync();
  return { props, events };
}
const marked = () => [...target!.querySelectorAll<HTMLElement>('[data-testid="event-card"][data-at-playhead="true"]')].map((c) => c.dataset.clipId);
const item = (id: string) => target!.querySelector(`[data-testid="event-card"][data-clip-id="${id}"]`)!.closest('li')!;

describe('EventList: the events at the playhead', () => {
  it('marks nothing by default', () => {
    render();
    expect(marked()).toEqual([]);
    expect(target!.querySelector('.at-playhead')).toBeNull();
  });

  it('marks every card in the set, and follows it', () => {
    const { props, events } = render();
    props.atPlayhead = new Set([events[0].id, events[2].id]);
    flushSync();
    expect(marked().sort()).toEqual([events[0].id, events[2].id].sort());
    expect(item(events[0].id).classList.contains('at-playhead')).toBe(true);
    expect(item(events[1].id).classList.contains('at-playhead')).toBe(false);
    props.atPlayhead = new Set([events[1].id]);
    flushSync();
    expect(marked()).toEqual([events[1].id]);
    props.atPlayhead = new Set();
    flushSync();
    expect(marked()).toEqual([]);
  });

  it('says so to a screen reader, on that card only', () => {
    const { props, events } = render();
    props.atPlayhead = new Set([events[0].id]);
    flushSync();
    const text = (id: string) => target!.querySelector(`[data-clip-id="${id}"] .sr-only`)!.textContent;
    expect(text(events[0].id)).toMatch(/at the playhead$/);
    expect(text(events[1].id)).not.toMatch(/at the playhead/);
  });

  it('is a look of its own: the selected card stays selected, and aria-current stays the selection’s', () => {
    const { props, events } = render();
    props.selectedId = events[0].id;
    props.atPlayhead = new Set([events[0].id, events[1].id]);
    flushSync();
    expect(item(events[0].id).classList.contains('current')).toBe(true);
    expect(item(events[1].id).classList.contains('current')).toBe(false);
    expect(target!.querySelectorAll('[aria-current="true"]')).toHaveLength(1);
    expect(marked()).toHaveLength(2);
  });

  it('never scrolls or opens anything for it', async () => {
    vi.mocked(scrollIntoContainer).mockClear();
    const pageSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
    const { props, events } = render();
    const toggle = target!.querySelector<HTMLButtonElement>('[data-testid="hour-toggle"]')!;
    if (toggle.getAttribute('aria-expanded') === 'true') toggle.click();
    flushSync();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    props.atPlayhead = new Set([events[0].id]);
    flushSync();
    await tick();
    expect(toggle.getAttribute('aria-expanded')).toBe('false'); // a collapsed hour stays so
    expect(target!.querySelector('[data-testid="event-card"]')).toBeNull();
    expect(target!.querySelector('[data-testid="hour-playing"]')).toBeNull(); // the title marks the selection only

    toggle.click();
    flushSync();
    props.atPlayhead = new Set([events[1].id]);
    flushSync();
    await tick();
    expect(marked()).toEqual([events[1].id]);
    expect(scrollIntoContainer).not.toHaveBeenCalled();
    expect(pageSpy).not.toHaveBeenCalled();
    pageSpy.mockRestore();
  });

  it('shows at once on a card that appears later: an hour opened, a filter changed', () => {
    const { props, events } = render();
    props.atPlayhead = new Set([events[0].id]);
    flushSync();
    const toggle = target!.querySelector<HTMLButtonElement>('[data-testid="hour-toggle"]')!;
    toggle.click();
    flushSync();
    expect(marked()).toEqual([]);
    toggle.click();
    flushSync();
    expect(marked()).toEqual([events[0].id]);

    props.events = [events[1]]; // the filter hides it
    flushSync();
    expect(marked()).toEqual([]);
    props.events = events; // and shows it again
    flushSync();
    expect(marked()).toEqual([events[0].id]);
  });

  it('touches nothing for an event the list doesn’t hold', () => {
    const { props } = render();
    props.atPlayhead = new Set(['20260926-120000-120005']);
    flushSync();
    expect(marked()).toEqual([]);
    expect(target!.querySelector('.at-playhead')).toBeNull();
  });
});
