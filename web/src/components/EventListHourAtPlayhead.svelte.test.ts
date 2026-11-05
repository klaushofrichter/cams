// @vitest-environment jsdom
//
// The hour title of the event at the playhead is highlighted too (Klaus,
// 2026-11-05), so a collapsed hour shows where the playing event is. The same
// rules as the cards: only events the list holds (a filtered-out one doesn't
// count), open or collapsed, and never a scroll.
import { flushSync, mount, unmount } from 'svelte';
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

function render() {
  const nine = makeEvents(DATE, 9, 3);
  const ten = makeEvents(DATE, 10, 2);
  const events = [...nine, ...ten];
  const props = $state({
    cameraId: 'cam1', events, filter: ALL_KINDS, date: DATE, selectedId: null as string | null,
    atPlayhead: new Set<string>() as ReadonlySet<string>, onfilter: () => {}, onselect: () => {},
  });
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(EventList, { target, props }) as unknown as Record<string, unknown>;
  flushSync();
  return { props, nine, ten, events };
}
const head = (hour: number) => target!.querySelector<HTMLButtonElement>(`[data-testid="hour-group"][data-hour="${hour}"] [data-testid="hour-toggle"]`)!;
const markedHours = () => [...target!.querySelectorAll<HTMLElement>('[data-testid="hour-toggle"][data-at-playhead="true"]')].map((h) => h.closest<HTMLElement>('[data-testid="hour-group"]')!.dataset.hour);

describe('EventList: the hour of the event at the playhead', () => {
  it('marks no hour by default', () => {
    render();
    expect(markedHours()).toEqual([]);
  });

  it('marks the hour holding a marked event, and follows it', () => {
    const { props, nine, ten } = render();
    props.atPlayhead = new Set([nine[1].id]);
    flushSync();
    expect(markedHours()).toEqual(['9']);
    expect(head(9).classList.contains('at-playhead')).toBe(true);
    expect(head(10).classList.contains('at-playhead')).toBe(false);
    props.atPlayhead = new Set([ten[0].id]);
    flushSync();
    expect(markedHours()).toEqual(['10']);
    props.atPlayhead = new Set();
    flushSync();
    expect(markedHours()).toEqual([]);
  });

  it('marks it collapsed or open, and says so to a screen reader', () => {
    const { props, nine } = render();
    props.atPlayhead = new Set([nine[0].id]);
    flushSync();
    head(9).click();
    flushSync();
    expect(head(9).getAttribute('aria-expanded')).toBe('false');
    expect(markedHours()).toEqual(['9']);
    expect(head(9).getAttribute('aria-label')).toMatch(/^.+, 3 events, at the playhead$/);
    head(9).click();
    flushSync();
    expect(markedHours()).toEqual(['9']);
  });

  it('counts only the events the list holds: filtered out is not marked', () => {
    const { props, nine, ten } = render();
    props.atPlayhead = new Set([nine[0].id]);
    flushSync();
    props.events = ten; // the filter hides 9:00
    flushSync();
    expect(markedHours()).toEqual([]);
    props.events = [...nine, ...ten];
    flushSync();
    expect(markedHours()).toEqual(['9']);
  });

  it('never scrolls for it', () => {
    vi.mocked(scrollIntoContainer).mockClear();
    const pageSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
    const { props, ten } = render();
    props.atPlayhead = new Set([ten[1].id]);
    flushSync();
    expect(scrollIntoContainer).not.toHaveBeenCalled();
    expect(pageSpy).not.toHaveBeenCalled();
    pageSpy.mockRestore();
  });
});
