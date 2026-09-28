// @vitest-environment jsdom
// The History chips select several kinds at once (Klaus, 2026-09-28).
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EventList from './EventList.svelte';
import { makeEvents } from './testing/eventFixtures';
import { ALL_KINDS, type Filter } from '../lib/recordings';

let target: HTMLDivElement | undefined;
let component: Record<string, unknown> | undefined;
afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  target = component = undefined;
});
function render(filter: Filter) {
  target = document.createElement('div');
  document.body.appendChild(target);
  const onfilter = vi.fn();
  component = mount(EventList, { target, props: { cameraId: 'c', events: makeEvents('2026-09-26', 14, 2), filter, date: '2026-09-26', selectedId: null, onfilter, onselect: () => {} } });
  flushSync();
  const chip = (k: string) => target!.querySelector(`[data-testid="filter-${k}"]`) as HTMLElement;
  return { onfilter, chip };
}

describe('event filter chips', () => {
  it('shows All pressed for every kind, and a kind picks only it', () => {
    const { onfilter, chip } = render(ALL_KINDS);
    expect(chip('all').getAttribute('aria-pressed')).toBe('true');
    expect(chip('person').getAttribute('aria-pressed')).toBe('false');
    chip('person').click();
    expect(onfilter).toHaveBeenCalledWith(['person']);
  });

  it('adds a kind to the selection, and presses each selected chip', () => {
    const { onfilter, chip } = render(['person']);
    expect(chip('all').getAttribute('aria-pressed')).toBe('false');
    expect(chip('person').getAttribute('aria-pressed')).toBe('true');
    chip('vehicle').click();
    expect(onfilter).toHaveBeenCalledWith(['person', 'vehicle']);
  });
});
