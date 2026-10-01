// @vitest-environment jsdom
// A Vision badge sits on History's card, beside its <button> (issue #113):
// clicking it opens the Vision dialog and does not select (play) the clip;
// the rest of the card still does.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EventList from './EventList.svelte';
import { makeEvents } from './testing/eventFixtures';
import { ALL_KINDS, type EventClip } from '../lib/recordings';
import type { CardAnalysis } from '../lib/vision';

const DATE = '2026-09-26';
let target: HTMLDivElement | undefined;
let component: Record<string, unknown> | undefined;
afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  target = component = undefined;
});

function mountList(events: (EventClip & { analysis?: CardAnalysis })[], extra: Record<string, unknown> = {}) {
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(EventList, { target, props: { cameraId: 'camA', events, filter: ALL_KINDS, date: DATE, selectedId: null, onfilter: () => {}, onselect: vi.fn(), ...extra } }) as unknown as Record<string, unknown>;
  flushSync();
  return target;
}

// Klaus, 2026-10-01: Motion, then Person, Vehicle, Pet, Scheduled, then Vision's badges.
describe('EventList: the order of a card’s tags', () => {
  it('lists Motion first, then the AI kinds, then the Vision badges', () => {
    const box = { x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.5 };
    const analysis: CardAnalysis = { best: { person: { score: 0.84, subtype: 'person' }, pet: { score: 0.7, subtype: 'dog' } }, notConfirmed: [], stills: [{ eventId: 7, stillTs: 1000, summary: [{ category: 'person', subtype: 'person', score: 0.84, box }] }] };
    const [first] = makeEvents(DATE, 14, 1);
    const t = mountList([{ ...first, triggers: ['timer', 'person', 'motion'], analysis }]);
    const tags = [...t.querySelectorAll('[data-testid="hour-group"] .tag, [data-testid="hour-group"] [data-testid="vision-badge"]')].map((x) => x.textContent);
    expect(tags).toEqual(['Motion', 'Person', 'Scheduled', '✦ Vision 84%', '+ Pet 70%']);
  });

  it('orders a recording in progress the same way', () => {
    const t = mountList([], { pending: [{ kind: 'person', ts: Date.now() - 2000 }, { kind: 'motion', ts: Date.now() - 1000 }] });
    expect([...t.querySelectorAll('[data-testid="event-pending"] .tag')].map((x) => x.textContent)).toEqual(['Motion', 'Person']);
  });
});

describe('EventList: Vision badges', () => {
  it('a badge click opens the dialog without selecting the card', () => {
    const box = { x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.5 };
    const analysis: CardAnalysis = { best: { person: { score: 0.84, subtype: 'person' } }, notConfirmed: [], stills: [{ eventId: 7, stillTs: 1000, summary: [{ category: 'person', subtype: 'person', score: 0.84, box }] }] };
    const [first] = makeEvents(DATE, 14, 1);
    const events: (EventClip & { analysis?: CardAnalysis })[] = [{ ...first, triggers: ['person'], analysis }];
    const onselect = vi.fn();
    target = document.createElement('div');
    document.body.appendChild(target);
    component = mount(EventList, { target, props: { cameraId: 'camA', events, filter: ALL_KINDS, date: DATE, selectedId: null, onfilter: () => {}, onselect } }) as unknown as Record<string, unknown>;
    flushSync();

    const badge = target.querySelector<HTMLElement>('[data-testid="vision-badge"]')!;
    expect(badge.getAttribute('data-level')).toBe('high');
    badge.click();
    flushSync();
    expect(onselect).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="vision-dialog"]')!.closest('[data-testid="event-card"]')).toBeNull();
    expect(document.querySelector('[data-testid="timeline-still"]')!.getAttribute('src')).toBe('/api/cameras/camA/stills/1000.jpg');

    document.querySelector<HTMLElement>('[data-testid="vision-dialog-close"]')!.click();
    flushSync();
    target.querySelector<HTMLElement>('[data-testid="event-card"]')!.click();
    expect(onselect).toHaveBeenCalledTimes(1);
  });

  // Issue #113: no button in a button; the card's button names the clip.
  it('puts the badges beside the card’s button, in keyboard order card, badges, download', () => {
    const box = { x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.5 };
    const analysis: CardAnalysis = { best: { person: { score: 0.84, subtype: 'person' }, pet: { score: 0.7, subtype: 'dog' } }, notConfirmed: [], stills: [{ eventId: 7, stillTs: 1000, summary: [{ category: 'person', subtype: 'person', score: 0.84, box }] }] };
    const [first] = makeEvents(DATE, 14, 1);
    const t = mountList([{ ...first, triggers: ['person', 'motion'], analysis }]);
    const card = t.querySelector<HTMLElement>('[data-testid="event-card"]')!;
    expect(card.querySelector('button, [role="button"]')).toBeNull();
    expect(card.textContent!.replace(/\s+/g, ' ').trim()).toBe('14:00:00, 5 s, Motion, Person');
    const li = card.closest('li')!;
    expect([...li.querySelectorAll('button, [tabindex]')].map((b) => b.getAttribute('data-testid'))).toEqual(['event-card', 'vision-badge', 'vision-badge', 'event-download']);
  });
});
