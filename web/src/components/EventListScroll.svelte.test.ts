// @vitest-environment jsdom
//
// Fix round 1, item 3: a deep link or a cross-day prev/next can set the
// selection before the matching events have even loaded (or before the
// group holding it has opened), so scrolling had to be retried until the
// card actually exists rather than attempted once and given up on.
// `pendingScroll` now covers that: set on an external selection change,
// retried via `tick()` as groups/groupOpen change, and cleared only once
// the card is actually found and scrolled to.
import { flushSync, mount, unmount, tick as svelteTick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EventList from './EventList.svelte';
import { makeEvents } from './testing/eventFixtures';

const DATE = '2026-09-26';

let target: HTMLDivElement | undefined;
let component: Record<string, unknown> | undefined;

afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  target = undefined;
  component = undefined;
});

describe('EventList scrolls to a selection set before its events arrive', () => {
  it('calls scrollIntoView exactly once once the 20 events (including the selection) load', async () => {
    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
    target = document.createElement('div');
    document.body.appendChild(target);

    const events = makeEvents(DATE, 9, 20);
    const wanted = events[5].id; // set as the selection before events load below

    const props = $state({
      cameraId: 'cam1',
      events: [] as typeof events,
      filter: 'all' as const,
      date: DATE,
      selectedId: wanted as string | null,
      onfilter: () => {},
      onselect: () => {},
    });
    component = mount(EventList, { target, props }) as unknown as Record<string, unknown>;

    // No events yet: nothing to scroll to. Let any scroll attempt the
    // initial mount scheduled fully settle (find nothing, since there's no
    // card yet) before the events arrive below -- a real deep link's events
    // response is many event-loop turns away, not one microtask.
    await svelteTick();
    await svelteTick();
    await new Promise((r) => setTimeout(r, 0));
    expect(scrollSpy).not.toHaveBeenCalled();

    // The 20 events (including the selection) load a moment later.
    flushSync(() => {
      props.events = events;
    });

    // Let the retry effect's tick() settle.
    await svelteTick();
    await svelteTick();
    await Promise.resolve();

    expect(scrollSpy).toHaveBeenCalledTimes(1);
    scrollSpy.mockRestore();
  });
});
