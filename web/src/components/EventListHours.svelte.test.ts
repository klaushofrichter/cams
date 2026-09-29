// @vitest-environment jsdom
//
// Klaus, 2026-09-29: a tap on a card's thumbnail also brings the player into
// view (onreveal); a tap elsewhere on the card only selects. And a
// "Collapse hours" / "Expand hours" for the hour groups: the list reports whether
// any hour is open (onhours), and setAllHours(open) sets them all.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EventList from './EventList.svelte';
import { makeEvents } from './testing/eventFixtures';
import { ALL_KINDS } from '../lib/recordings';

const DATE = '2026-09-26';
let target: HTMLDivElement | undefined;
let component: Record<string, unknown> | undefined;
afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  target = component = undefined;
});

function render() {
  const onselect = vi.fn();
  const onreveal = vi.fn();
  const onhours = vi.fn();
  target = document.createElement('div');
  document.body.appendChild(target);
  const events = [...makeEvents(DATE, 9, 2), ...makeEvents(DATE, 14, 3)];
  component = mount(EventList, {
    target,
    props: { cameraId: 'cam1', events, filter: ALL_KINDS, date: DATE, selectedId: null, onfilter: () => {}, onselect, onreveal, onhours },
  }) as unknown as Record<string, unknown>;
  flushSync();
  return { onselect, onreveal, onhours };
}
const all = (id: string) => [...target!.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];

describe('EventList: thumbnail tap and hour groups', () => {
  it('reveals the player for a tap on the thumbnail, not for a tap elsewhere on the card', () => {
    const { onselect, onreveal } = render();
    (all('event-card')[0].querySelector('[data-testid="event-thumb"]') as HTMLElement).click();
    expect(onselect).toHaveBeenCalledTimes(1);
    expect(onreveal).toHaveBeenCalledTimes(1);
    (all('event-card')[1].querySelector('.meta') as HTMLElement).click();
    expect(onselect).toHaveBeenCalledTimes(2);
    expect(onreveal).toHaveBeenCalledTimes(1);
  });

  it('collapses and expands all hours, and reports whether any hour is open', () => {
    const { onhours } = render();
    const open = () => all('hour-toggle').map((b) => b.getAttribute('aria-expanded'));
    expect(open()).toEqual(['true', 'true']);
    expect(onhours).toHaveBeenLastCalledWith(true);
    (component!.setAllHours as (o: boolean) => void)(false);
    flushSync();
    expect(open()).toEqual(['false', 'false']);
    expect(onhours).toHaveBeenLastCalledWith(false);
    all('hour-toggle')[1].click(); // one opened by hand: the button offers "Collapse hours" again
    flushSync();
    expect(onhours).toHaveBeenLastCalledWith(true);
    (component!.setAllHours as (o: boolean) => void)(true);
    flushSync();
    expect(open()).toEqual(['true', 'true']);
  });
});
