// @vitest-environment jsdom
//
// A thumbnail that fails (e.g. 503 while the camera refuses downloads) swaps
// its <img> for a placeholder. The error handler must not read reactive
// values from the list item's render block, which is being destroyed:
// production showed "derived_inert" twice per failed thumbnail.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EventList from './EventList.svelte';
import { makeEvents } from './testing/eventFixtures';

const DATE = '2026-09-26';
let target: HTMLDivElement | undefined;
let component: Record<string, unknown> | undefined;

afterEach(() => {
  if (component) unmount(component);
  target?.remove();
});

describe('EventList thumbnail errors', () => {
  it('marks the thumbnail broken without reading destroyed reactive state', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    target = document.createElement('div');
    document.body.appendChild(target);
    const events = makeEvents(DATE, 9, 3);
    const props = $state({ cameraId: 'cam1', events, filter: 'all' as const, date: DATE, selectedId: null as string | null, onfilter: () => {}, onselect: () => {} });
    component = mount(EventList, { target, props }) as unknown as Record<string, unknown>;
    flushSync();
    const imgs = target.querySelectorAll('img[data-testid="event-thumb"]');
    expect(imgs.length).toBe(3);
    flushSync(() => imgs[1].dispatchEvent(new Event('error')));
    expect(target.querySelectorAll('img[data-testid="event-thumb"]').length).toBe(2);
    expect(target.querySelectorAll('[data-testid="event-thumb"]').length).toBe(3); // placeholder kept
    const inert = warn.mock.calls.filter((c) => String(c.join(' ')).includes('derived_inert'));
    expect(inert).toEqual([]);
    warn.mockRestore();
  });
});
