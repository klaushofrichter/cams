// @vitest-environment jsdom
// A Vision badge sits inside History's card <button>: clicking it opens the
// Vision dialog and does not select (play) the clip; the rest of the card still does.
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
    target.querySelector<HTMLElement>('[data-testid="event-card"] strong')!.click();
    expect(onselect).toHaveBeenCalledTimes(1);
  });
});
