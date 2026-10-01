// @vitest-environment jsdom
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import VisionBadges from './VisionBadges.svelte';
import Harness from './testing/VisionBadgesHarness.svelte';
import { localDate } from '../lib/recordings';
import type { CardAnalysis } from '../lib/vision';

let component: Record<string, unknown> | undefined;
let target: HTMLDivElement | undefined;
afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  component = target = undefined;
  vi.unstubAllGlobals();
  history.replaceState({}, '', '/');
});

const box = { x0: 0.1, y0: 0.2, x1: 0.3, y1: 0.9 };
// Two analysed stills: the second has the better person and the dog.
const T1 = new Date(2026, 8, 30, 8, 15, 11).getTime();
const T2 = new Date(2026, 8, 30, 8, 15, 14).getTime();
const analysis: CardAnalysis = {
  best: { person: { score: 0.84, subtype: 'person' }, pet: { score: 0.42, subtype: 'dog' } },
  notConfirmed: [],
  stills: [
    { eventId: 11, stillTs: T1, summary: [{ category: 'person', subtype: 'person', score: 0.6, box }] },
    { eventId: 12, stillTs: T2, summary: [{ category: 'person', subtype: 'person', score: 0.84, box }, { category: 'pet', subtype: 'dog', score: 0.42, box }] },
  ],
};

function render(props: { triggers: string[]; analysis?: CardAnalysis }) {
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(VisionBadges, { target, props: { cameraId: 'cam1', ...props } });
  flushSync();
  return [...target.querySelectorAll('[data-testid="vision-badge"]')].map((b) => ({ kind: b.getAttribute('data-kind'), level: b.getAttribute('data-level'), text: b.textContent, title: b.getAttribute('title') }));
}

function inCard(a: CardAnalysis = analysis, triggers = ['person']) {
  const oncard = vi.fn();
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(Harness, { target, props: { cameraId: 'cam1', triggers, analysis: a, oncard } });
  flushSync();
  return oncard;
}

const byId = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const badge = (kind: string) => document.querySelector(`[data-testid="vision-badge"][data-kind="${kind}"]`) as HTMLElement;
const key = (el: Element, k: string, shiftKey = false, type: 'keydown' | 'keyup' = 'keydown') => {
  const e = new KeyboardEvent(type, { key: k, bubbles: true, cancelable: true, shiftKey });
  el.dispatchEvent(e);
  flushSync();
  return e;
};
const open = async (kind = 'agree') => {
  badge(kind).focus();
  badge(kind).click();
  flushSync();
  await tick();
  return byId('vision-dialog')!;
};

describe('VisionBadges', () => {
  it('renders the agreement and the extra finding, coloured by confidence', () => {
    const got = render({ triggers: ['person'], analysis });
    expect(got).toEqual([
      { kind: 'agree', level: 'high', text: '✦ Vision 84%', title: 'Vision: person 0.84 · high confidence' },
      { kind: 'extra', level: 'low', text: '+ Pet 42%', title: 'Vision: dog 0.42 · low confidence' },
    ]);
  });

  it('gives "not confirmed" no level', () => {
    expect(render({ triggers: ['person'], analysis: { best: {}, notConfirmed: ['person'], stills: [] } })).toEqual([
      { kind: 'not-confirmed', level: null, text: '✦ Vision: not confirmed', title: 'Vision found no person in the analysed still' },
    ]);
  });

  it('renders nothing without an analysis', () => {
    expect(render({ triggers: ['person'] })).toEqual([]);
  });

  it('names each badge for screen readers', () => {
    render({ triggers: ['person'], analysis });
    expect([...document.querySelectorAll('[data-testid="vision-badge"]')].map((b) => b.getAttribute('aria-label'))).toEqual([
      'Vision 84%, high confidence. Show the analysed still',
      'Vision also found Pet 42%, low confidence. Show the analysed still',
    ]);
  });

  it('makes each badge a keyboard-reachable button', () => {
    render({ triggers: ['person'], analysis });
    for (const b of document.querySelectorAll('[data-testid="vision-badge"]')) {
      expect(b.getAttribute('role')).toBe('button');
      expect(b.getAttribute('tabindex')).toBe('0');
    }
  });
});

describe('the Vision dialog', () => {
  it('opens on a badge click with the best still for that category and its boxes, outside the card, and the card does not see the click', async () => {
    const oncard = inCard();
    const dialog = await open();
    expect(oncard).not.toHaveBeenCalled();
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toBeTruthy();
    expect(dialog.closest('button')).toBeNull();
    expect(dialog.textContent).toContain('✦ Vision · Person');
    expect(dialog.textContent).toContain('08:15:14');
    expect(byId('timeline-still')!.getAttribute('src')).toBe(`/api/cameras/cam1/stills/${T2}.jpg`);
    // The person and the dog.
    expect(document.querySelectorAll('[data-testid="timeline-boxes"] rect')).toHaveLength(2);
    expect(dialog.textContent).toContain('2 of 2');
    expect(dialog.textContent).toContain('person 0.84');
    expect(dialog.textContent).toContain('dog 0.42');
  });

  it('steps between the analysed stills', async () => {
    inCard();
    await open();
    byId('vision-dialog-prev')!.click();
    flushSync();
    expect(byId('vision-dialog')!.textContent).toContain('1 of 2');
    expect(byId('timeline-still')!.getAttribute('src')).toBe(`/api/cameras/cam1/stills/${T1}.jpg`);
    expect(document.querySelectorAll('[data-testid="timeline-boxes"] rect')).toHaveLength(1);
    expect(byId('vision-dialog')!.textContent).toContain('08:15:11');
    byId('vision-dialog-next')!.click();
    flushSync();
    expect(byId('timeline-still')!.getAttribute('src')).toBe(`/api/cameras/cam1/stills/${T2}.jpg`);    // Wraps around, so focus never lands on a disabled button.
    byId('vision-dialog-next')!.click();
    flushSync();
    expect(byId('vision-dialog')!.textContent).toContain('1 of 2');
  });

  it('has no stepping with one still', async () => {
    inCard({ ...analysis, best: { person: analysis.best.person }, stills: [analysis.stills[0]] });
    await open();
    expect(byId('vision-dialog-prev')).toBeNull();
    expect(byId('vision-dialog-next')).toBeNull();
    expect(document.querySelectorAll('[data-testid="timeline-boxes"] rect')).toHaveLength(1);
  });

  it('opens with Enter or Space on a focused badge, and the card does not see the key', async () => {
    const oncard = inCard();
    const e = key(badge('agree'), 'Enter');
    await tick();
    expect(e.defaultPrevented).toBe(true);
    expect(byId('vision-dialog')).not.toBeNull();
    key(byId('vision-dialog')!, 'Escape');
    expect(byId('vision-dialog')).toBeNull();
    // Space opens on keyup (a keydown open would let the keyup click ✕ in
    // Firefox/WebKit); its keydown is only kept from scrolling the page.
    const down = key(badge('extra'), ' ');
    await tick();
    expect(down.defaultPrevented).toBe(true);
    expect(byId('vision-dialog')).toBeNull();
    const up = key(badge('extra'), ' ', false, 'keyup');
    await tick();
    expect(up.defaultPrevented).toBe(true);
    expect(byId('vision-dialog')!.textContent).toContain('✦ Vision · Pet');
    expect(oncard).not.toHaveBeenCalled();
  });

  it('closes with Esc, ✕ and the backdrop, and gives focus back to the badge', async () => {
    inCard();
    const dialog = await open();
    expect(dialog.contains(document.activeElement)).toBe(true);
    key(document.activeElement!, 'Escape');
    expect(byId('vision-dialog')).toBeNull();
    expect(document.activeElement).toBe(badge('agree'));

    await open();
    byId('vision-dialog-close')!.click();
    flushSync();
    expect(byId('vision-dialog')).toBeNull();
    expect(document.activeElement).toBe(badge('agree'));

    await open();
    (document.querySelector('[data-testid="vision-dialog-backdrop"]') as HTMLElement).click();
    flushSync();
    expect(byId('vision-dialog')).toBeNull();
  });

  it('keeps Tab inside the dialog', async () => {
    inCard();
    const dialog = await open();
    const focusables = [...dialog.querySelectorAll<HTMLElement>('button, input, a[href]')];
    focusables[focusables.length - 1].focus();
    key(document.activeElement!, 'Tab');
    expect(document.activeElement).toBe(focusables[0]);
    key(document.activeElement!, 'Tab', true);
    expect(document.activeElement).toBe(focusables[focusables.length - 1]);
  });

  it('shows all objects from the full analysis', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ eventId: 12, status: 'ok', stillTs: T2, summary: [], objects: [{ name: 'Person', score: 0.84, box }, { name: 'Ceiling fan', score: 0.7, box }, { name: 'Lamp', score: 0.5, box: null }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    inCard();
    await open();
    byId('timeline-show-all')!.click();
    await vi.waitFor(() => expect(document.querySelectorAll('[data-testid="timeline-boxes"] rect')).toHaveLength(2));
    expect(fetch).toHaveBeenCalledWith('/api/cameras/cam1/analyses/12', expect.anything());
  });

  it('says so when the still has nothing relevant, and still offers all objects', async () => {
    inCard({ best: {}, notConfirmed: ['person'], stills: [{ eventId: 13, stillTs: T1, summary: [] }] });
    const dialog = await open('not-confirmed');
    expect(dialog.textContent).toContain('Vision found nothing relevant in this still.');
    expect(byId('timeline-still')!.getAttribute('src')).toBe(`/api/cameras/cam1/stills/${T1}.jpg`);
    expect(byId('timeline-show-all')).not.toBeNull();
  });

  it('"Open in Timeline" goes to that still in-app and closes', async () => {
    inCard();
    await open();
    const link = byId('vision-dialog-timeline') as HTMLAnchorElement;
    const href = `/app/timeline?cam=cam1&date=${localDate(new Date(T2))}&t=${T2}`;
    expect(link.getAttribute('href')).toBe(href);
    link.click();
    flushSync();
    expect(location.pathname + location.search).toBe(href);
    expect(byId('vision-dialog')).toBeNull();
  });

  it('closes when the analysis goes away or the opened badge disappears, and does not reopen by itself', async () => {
    const props = $state<{ cameraId: string; triggers: string[]; analysis?: CardAnalysis }>({ cameraId: 'cam1', triggers: ['person'], analysis });
    target = document.createElement('div');
    document.body.appendChild(target);
    component = mount(VisionBadges, { target, props });
    flushSync();
    await open('extra');
    // A live update without the pet: its badge goes, and so does the dialog.
    props.analysis = { ...analysis, best: { person: analysis.best.person } };
    flushSync();
    expect(byId('vision-dialog')).toBeNull();
    props.analysis = analysis;
    flushSync();
    expect(byId('vision-dialog')).toBeNull();

    await open('agree');
    props.analysis = undefined;
    flushSync();
    expect(byId('vision-dialog')).toBeNull();
    props.analysis = analysis;
    flushSync();
    expect(byId('vision-dialog')).toBeNull();
  });

  it('takes the dialog out of the page when the badges unmount while it is open', async () => {
    inCard();
    await open();
    expect(byId('vision-dialog')).not.toBeNull();
    unmount(component!);
    component = undefined;
    flushSync();
    expect(byId('vision-dialog')).toBeNull();
    expect(byId('vision-dialog-backdrop')).toBeNull();
  });
});
