// @vitest-environment jsdom
//
// Live events (Klaus, 2026-09-28): an event that just started shows at once,
// at the top of the list and on the strip, until its recording is listed.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import EventList from './EventList.svelte';
import Strip from './Strip.svelte';
import { preferences } from '../lib/preferences';
import { makeEvents } from './testing/eventFixtures';

const DATE = '2026-09-27';
const T = Date.parse('2026-09-27T12:00:00-05:00');
let component: Record<string, unknown> | undefined;
let target: HTMLDivElement | undefined;
afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  component = target = undefined;
  preferences.set(null);
});
function mountIt(C: typeof EventList | typeof Strip, props: Record<string, unknown>) {
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(C as never, { target, props } as never) as unknown as Record<string, unknown>;
  flushSync();
}

describe('pending live events', () => {
  it('put a "recording…" card at the top of the list', () => {
    mountIt(EventList, { cameraId: 'cam1', events: makeEvents(DATE, 8, 2), filter: 'all', date: DATE, selectedId: null, onfilter: () => {}, onselect: () => {}, pending: [{ kind: 'person', ts: T }] });
    const first = target!.querySelector('[data-testid="event-pending"]') as HTMLElement;
    expect(first).not.toBeNull();
    expect(first.textContent).toMatch(/Person/);
    expect(first.textContent).toMatch(/recording/i);
    // it comes before the first hour group
    expect(first.compareDocumentPosition(target!.querySelector('[data-testid="hour-group"]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // Klaus, 2026-09-30: events of one recording are one card.
  it('show events close together as one card, from the first event, each kind once', () => {
    mountIt(EventList, { cameraId: 'cam1', events: [], filter: 'all', date: DATE, selectedId: null, onfilter: () => {}, onselect: () => {},
      pending: [{ kind: 'motion', ts: T }, { kind: 'person', ts: T + 5_000 }, { kind: 'motion', ts: T + 12_000 }, { kind: 'pet', ts: T + 60_000 }] });
    const cards = [...target!.querySelectorAll('[data-testid="event-pending"]')] as HTMLElement[];
    expect(cards).toHaveLength(2);
    expect([...cards[0].querySelectorAll('.tag')].map((x) => x.textContent)).toEqual(['Pet']);
    expect([...cards[1].querySelectorAll('.tag')].map((x) => x.textContent)).toEqual(['Motion', 'Person']); // Motion first (Klaus, 2026-10-01)
    expect(cards[1].querySelector('strong')!.textContent).toBe(new Date(T).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  });

  it('mark the strip where they started', () => {
    preferences.set({ defaultCamera: null, liveQuality: 'sub', eventFilter: ['person', 'vehicle', 'pet', 'motion'], timelineZoom: 1, liveKeepAlive: 60 });
    mountIt(Strip, { coverage: { clips: [], stills: [], previews: [] }, events: [], visibleIds: new Set(), failedIds: new Set(), at: T, now: T + 600_000, currentId: null, previews: [], onseek: () => {}, pending: [{ kind: 'motion', ts: T + 60_000 }] });
    const m = target!.querySelector('[data-testid="strip-pending"]') as HTMLElement;
    expect(m).not.toBeNull();
    expect(parseFloat(m.style.left)).toBeCloseTo(50 + (60_000 / 3_600_000) * 100, 1);
  });
});
