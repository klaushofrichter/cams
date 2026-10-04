// @vitest-environment jsdom
//
// Stage 2 of the Video page (spec 2026-10-04): hours more than 6 h from the
// viewed time collapse when the viewer lands on a new spot, never while
// scrubbing or playing; hours toggled by hand keep their state until the day
// changes; the viewed hour is always open. Collapsed hours load no
// thumbnails, and the open ones only as they come near the screen.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EventList from './EventList.svelte';
import { ALL_KINDS, type EventClip } from '../lib/recordings';
import { resetLazyThumbs } from '../lib/lazyThumbs';

const DATE = '2026-10-04';
const at = (hh: number, mm = 0) => new Date(2026, 9, 4, hh, mm).getTime();
// One event an hour, 00:10 to 23:10 (TZ=America/Chicago).
const day = (date = DATE): EventClip[] =>
  Array.from({ length: 24 }, (_, h) => {
    const hh = String(h).padStart(2, '0');
    const start = `${date}T${hh}:10:00`;
    return { id: `${date.replace(/-/g, '')}-${hh}1000-${hh}1020`, start, end: start, durationSec: 20, triggers: ['motion'], sizeSub: 1, sizeMain: 1 };
  });

let target: HTMLDivElement | undefined;
let component: Record<string, unknown> | undefined;
beforeEach(() => resetLazyThumbs());
afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  target = component = undefined;
  vi.unstubAllGlobals();
  resetLazyThumbs();
});
function render(extra: Record<string, unknown> = {}) {
  target = document.createElement('div');
  document.body.appendChild(target);
  const props = $state({ cameraId: 'cam1', events: day(), filter: ALL_KINDS, date: DATE, selectedId: null as string | null, onfilter: () => {}, onselect: () => {}, landing: undefined as { at: number | null } | undefined, ...extra });
  component = mount(EventList, { target, props }) as unknown as Record<string, unknown>;
  flushSync();
  return props;
}
const openHours = () =>
  [...target!.querySelectorAll<HTMLElement>('[data-testid="hour-group"]')]
    .filter((g) => g.querySelector('[data-testid="hour-toggle"]')!.getAttribute('aria-expanded') === 'true')
    .map((g) => Number(g.dataset.hour))
    .sort((a, b) => a - b);
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const toggle = (hour: number) => (target!.querySelector(`[data-testid="hour-group"][data-hour="${hour}"] [data-testid="hour-toggle"]`) as HTMLElement).click();

describe('auto-collapse on landing', () => {
  it('a landing collapses the hours more than 6 h away', () => {
    render({ landing: { at: at(12, 30) } });
    expect(openHours()).toEqual(range(6, 18));
  });

  it('scrubbing and playing (the selection moving) change nothing', () => {
    const p = render({ landing: { at: at(12, 30) } });
    for (const h of [11, 3, 22, 1]) {
      p.selectedId = day()[h].id; // the playhead crossing clips, collapsed hours too
      flushSync();
      expect(openHours()).toEqual(range(6, 18));
    }
    // and the collapsed hour holding the clip is marked
    expect(target!.querySelector('[data-hour="1"] [data-testid="hour-toggle"]')!.classList.contains('holds')).toBe(true);
  });

  it('a new landing (a card, a link, a day) applies again', () => {
    const p = render({ landing: { at: at(12, 30) } });
    p.landing = { at: at(2, 10) };
    flushSync();
    expect(openHours()).toEqual(range(0, 8)); // 02:10: up to 08:00, 6 h after the hour's end
  });

  it('hours toggled by hand keep their state through a later landing; the viewed hour opens', () => {
    const p = render({ landing: { at: at(12, 30) } });
    toggle(22); // opened by hand
    toggle(13); // closed by hand
    flushSync();
    p.landing = { at: at(13, 5) }; // lands in the hour closed by hand
    flushSync();
    expect(openHours()).toEqual([...range(7, 19), 22]);
    p.landing = { at: at(10, 0) };
    flushSync();
    // 04:00–16:00 are within 6 h (03:00 and 16:00 exactly 6 h); 13 stays closed by hand
    expect(openHours()).toEqual([...range(3, 12), 14, 15, 16, 22]);
  });

  it('another day forgets the hand toggles', () => {
    const p = render({ landing: { at: at(12, 30) } });
    toggle(22);
    flushSync();
    p.date = '2026-10-03';
    p.events = day('2026-10-03');
    p.landing = { at: new Date(2026, 9, 3, 12, 30).getTime() };
    flushSync();
    expect(openHours()).toEqual(range(6, 18));
  });

  // Review of #175: a landing belongs to its day.
  it('another day without a landing of its own uses no old landing', () => {
    const p = render({ landing: { at: at(12, 30) } });
    p.date = '2026-10-03';
    p.events = day('2026-10-03'); // no landing for it (yet)
    flushSync();
    expect(openHours()).toEqual(range(0, 23));
  });

  it('a landing on an empty day is not applied to events of a later day', () => {
    const p = render({ events: [], landing: { at: at(12, 30) } });
    p.date = '2026-10-05';
    flushSync();
    p.events = day('2026-10-05'); // much later, no new landing
    flushSync();
    expect(openHours()).toEqual(range(0, 23));
  });

  // Review of #175: the collapsed hour holding the playing clip says so.
  it('marks the collapsed hour holding the playing clip, for eyes and screen readers', () => {
    const p = render({ landing: { at: at(12, 30) } });
    p.selectedId = day()[22].id;
    flushSync();
    const head = target!.querySelector('[data-hour="22"] [data-testid="hour-toggle"]') as HTMLElement;
    expect(head.querySelector('[data-testid="hour-playing"]')).not.toBeNull();
    expect(head.getAttribute('aria-label')).toMatch(/^22:00–23:00, 1 event, playing$/);
    const other = target!.querySelector('[data-hour="21"] [data-testid="hour-toggle"]') as HTMLElement;
    expect(other.querySelector('[data-testid="hour-playing"]')).toBeNull();
    expect(other.hasAttribute('aria-label')).toBe(false);
    // open: the card itself is marked, the header isn't
    expect(target!.querySelector('[data-hour="12"] [data-testid="hour-playing"]')).toBeNull();
  });

  it('live (at null) is now, and a new hour arriving later is open', () => {
    vi.useFakeTimers({ now: at(23, 30), toFake: ['Date'] });
    try {
      const p = render({ events: day().slice(0, 23), landing: { at: null } });
      expect(openHours()).toEqual(range(17, 22));
      p.events = day(); // 23:10 arrives, no landing
      flushSync();
      expect(openHours()).toEqual(range(17, 23));
    } finally {
      vi.useRealTimers();
    }
  });

  it('"Collapse hours" works as before, and counts as the user’s choice', () => {
    const p = render({ landing: { at: at(12, 30) } });
    (component as unknown as { setAllHours: (o: boolean) => void }).setAllHours(false);
    flushSync();
    expect(openHours()).toEqual([]);
    p.landing = { at: at(15, 0) };
    flushSync();
    expect(openHours()).toEqual([15]); // only the viewed hour
  });
});

// A stand-in IntersectionObserver the test drives.
class FakeIO {
  static last: FakeIO | undefined;
  nodes: Element[] = [];
  constructor(public cb: IntersectionObserverCallback) { FakeIO.last = this; }
  observe(n: Element) { this.nodes.push(n); }
  unobserve(n: Element) { this.nodes = this.nodes.filter((x) => x !== n); }
  disconnect() { this.nodes = []; }
  show(ns: Element[]) { this.cb(ns.map((n) => ({ target: n, isIntersecting: true }) as unknown as IntersectionObserverEntry), this as unknown as IntersectionObserver); }
}

describe('lazy thumbnails', () => {
  const thumbs = () => [...target!.querySelectorAll<HTMLImageElement>('img[data-testid="event-thumb"]')];
  it('load only for cards near the screen, more as the list scrolls; collapsed hours none', () => {
    vi.stubGlobal('IntersectionObserver', FakeIO);
    render({ landing: { at: at(12, 30) } });
    expect(thumbs()).toHaveLength(13); // the 13 open hours' cards; collapsed hours render none
    expect(thumbs().filter((i) => i.hasAttribute('src'))).toHaveLength(0);
    FakeIO.last!.show(thumbs().slice(0, 3)); // on screen
    expect(thumbs().filter((i) => i.hasAttribute('src')).map((i) => i.getAttribute('src'))).toEqual([
      `/api/cameras/cam1/clips/${day()[18].id}/thumb.jpg`, `/api/cameras/cam1/clips/${day()[17].id}/thumb.jpg`, `/api/cameras/cam1/clips/${day()[16].id}/thumb.jpg`,
    ]);
    for (const i of thumbs().slice(0, 3)) i.dispatchEvent(new Event('load'));
    FakeIO.last!.show(thumbs().slice(3, 5)); // scrolled further
    expect(thumbs().filter((i) => i.hasAttribute('src'))).toHaveLength(5);
  });

  it('load at once where IntersectionObserver is missing', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    render({ landing: { at: at(12, 30) } });
    expect(thumbs().every((i) => i.hasAttribute('src'))).toBe(true);
  });
});
