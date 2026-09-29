// @vitest-environment jsdom
//
// Klaus, 2026-09-29: History and Downloads are one list. Each History card has
// a download button; it opens the save dialog (SD, 4K, or with a cam-proxy a
// pre-/post-roll) and never plays the clip or downloads on its own.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EventList from './EventList.svelte';
import { makeEvents } from './testing/eventFixtures';
import { ALL_KINDS } from '../lib/recordings';
import { cameras } from '../lib/stores';
import type { CameraSummary } from '../lib/stores';

const DATE = '2026-09-26';
let target: HTMLDivElement | undefined;
let component: Record<string, unknown> | undefined;

afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  target = component = undefined;
  cameras.set([]);
  vi.unstubAllGlobals();
});

function render(withProxy: boolean) {
  cameras.set([{ id: 'cam1', name: 'Den', webUiUrl: null, proxy: withProxy } satisfies CameraSummary]);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"available":true}', { status: 200 })));
  const onselect = vi.fn();
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(EventList, {
    target,
    props: { cameraId: 'cam1', events: makeEvents(DATE, 9, 2), filter: ALL_KINDS, date: DATE, selectedId: null, onfilter: () => {}, onselect },
  }) as unknown as Record<string, unknown>;
  flushSync();
  return onselect;
}
const all = (id: string) => [...target!.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];

describe('History card download button', () => {
  it('is on every card, labelled for screen readers, and is not a link', () => {
    render(true);
    const buttons = all('event-download');
    expect(buttons).toHaveLength(all('event-card').length);
    expect(buttons.length).toBe(2);
    for (const b of buttons) {
      expect(b.tagName).toBe('BUTTON');
      expect(b.getAttribute('aria-label')).toMatch(/^Download the clip from /);
    }
    // Not inside the card's play button (a button can't hold a button).
    expect(buttons[0].closest('[data-testid="event-card"]')).toBeNull();
  });

  it('opens the save dialog without playing the clip', () => {
    const onselect = render(true);
    expect(target!.querySelector('[data-testid="compose-dialog"]')).toBeNull();
    all('event-download')[1].click();
    flushSync();
    expect(document.querySelector('[data-testid="compose-dialog"]')).not.toBeNull();
    expect(onselect).not.toHaveBeenCalled();
    // A click on the card itself still plays it.
    all('event-card')[0].click();
    expect(onselect).toHaveBeenCalledTimes(1);
  });

  it('opens the simple dialog (SD or 4K) for a camera without a cam-proxy', () => {
    render(false);
    all('event-download')[0].click();
    flushSync();
    expect(document.querySelector('[data-testid="compose-pre"]')).toBeNull();
    const sizes = [...document.querySelectorAll<HTMLOptionElement>('[data-testid="compose-size"] option')].map((o) => o.value);
    expect(sizes).toEqual(['sd', '4k']);
  });
});
