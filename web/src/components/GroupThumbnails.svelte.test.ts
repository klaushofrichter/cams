// @vitest-environment jsdom
//
// Fix round 1, item 4: a busy hour's default open/closed state used to be
// decided only inside an effect, so the very first render fell back to
// `groupOpen[key] ?? true` -- meaning every clip's thumbnail <img> was built
// (and immediately requested) on first paint, even for a busy hour that was
// about to collapse. `defaultGroupOpen` is now computed during render too
// (shared with the effect), so a busy hour never opens on first paint.
import { mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
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

describe('EventList does not build thumbnails for a busy hour on first render', () => {
  it('mounting 15 clips in one hour creates 0 <img> elements', () => {
    target = document.createElement('div');
    document.body.appendChild(target);

    const props = {
      cameraId: 'cam1',
      events: makeEvents(DATE, 11, 15), // 15 > COLLAPSE_OVER (10), no selection
      filter: 'all' as const,
      date: DATE,
      selectedId: null as string | null,
      onfilter: () => {},
      onselect: () => {},
    };
    component = mount(EventList, { target, props }) as unknown as Record<string, unknown>;

    expect(target.querySelectorAll('img[data-testid="event-thumb"]').length).toBe(0);
    // The group itself is there, just collapsed.
    const toggle = target.querySelector<HTMLElement>('[data-testid="hour-toggle"]');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(toggle?.querySelector('[data-testid="hour-count"]')?.textContent).toContain('15');
  });
});
