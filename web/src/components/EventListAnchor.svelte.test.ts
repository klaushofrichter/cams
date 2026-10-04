// @vitest-environment jsdom
//
// Review of #173: new events arrive at the top of today's list. A reader
// scrolled down the list must not see it jump: the list keeps the card they
// were reading where it was (explicitly, not through the browser's
// overflow-anchor, which only Chrome and Firefox do).
import { flushSync, mount, unmount, tick } from 'svelte';
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
  vi.restoreAllMocks();
});

// No layout in jsdom: every anchored row is 100 px tall, stacked in DOM order,
// inside a scroller whose top is 0.
function render(events: ReturnType<typeof makeEvents>) {
  target = document.createElement('div');
  let top = 0;
  Object.defineProperty(target, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => (top = v) });
  document.body.appendChild(target);
  const scroller = target;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const rows = [...scroller.querySelectorAll('[data-anchor]')];
    const i = rows.indexOf(this);
    const y = this === scroller ? 0 : i * 100 - scroller.scrollTop;
    return { top: y, bottom: y + (this === scroller ? 500 : 100), left: 0, right: 300, width: 300, height: this === scroller ? 500 : 100, x: 0, y, toJSON: () => ({}) } as DOMRect;
  });
  const props = $state({ cameraId: 'cam1', events, filter: ALL_KINDS, date: DATE, selectedId: null as string | null, pending: [] as { kind: string; ts: number }[], onfilter: () => {}, onselect: () => {} });
  component = mount(EventList, { target, props }) as unknown as Record<string, unknown>;
  flushSync();
  return { props, scroller };
}
const settle = async () => {
  flushSync();
  await tick();
  await new Promise((r) => setTimeout(r, 0));
};

describe('EventList keeps the reading position when events arrive at the top', () => {
  it('scrolled down: the card being read stays put', async () => {
    const old = makeEvents(DATE, 9, 3);
    const { props, scroller } = render(old);
    scroller.scrollTop = 150;
    const reading = () => [...scroller.querySelectorAll('[data-anchor]')].find((r) => r.getBoundingClientRect().bottom > 0)!;
    const before = reading();
    const beforeTop = before.getBoundingClientRect().top;
    props.events = [...makeEvents(DATE, 10, 1), ...old]; // a new hour and its card, above
    await settle();
    expect(scroller.scrollTop).toBe(350);
    expect(before.getBoundingClientRect().top).toBe(beforeTop);
  });

  it('a "recording…" card at the top keeps the position too', async () => {
    const { props, scroller } = render(makeEvents(DATE, 9, 3));
    scroller.scrollTop = 120;
    props.pending = [{ kind: 'person', ts: Date.parse(`${DATE}T10:00:00`) }];
    await settle();
    expect(scroller.scrollTop).toBe(220);
  });

  it('at the top: the new event shows, nothing is compensated', async () => {
    const old = makeEvents(DATE, 9, 3);
    const { props, scroller } = render(old);
    props.events = [...makeEvents(DATE, 10, 1), ...old];
    await settle();
    expect(scroller.scrollTop).toBe(0);
  });

  it('another day is no insertion: nothing is compensated', async () => {
    const { props, scroller } = render(makeEvents(DATE, 9, 3));
    scroller.scrollTop = 150;
    props.date = '2026-09-25';
    props.events = makeEvents('2026-09-25', 8, 5);
    await settle();
    expect(scroller.scrollTop).toBe(150);
  });
});
