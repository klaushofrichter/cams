// @vitest-environment jsdom
//
// Still checks on the Timeline (cams #179, spec 2026-10-04-still-checks-ui-design):
// the button per analytics answer, the result in place, reuse, errors, the
// marks, the day's list, ◀ ✧ ▶ and Shift+arrows, the live refresh.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cameras, selectedCameraId } from '../lib/stores';
import { saveViewPoint } from '../lib/timeline';
import type { Change } from '../lib/eventStream';

let fireChange: ((c: Change) => void) | undefined;
vi.mock('../lib/eventStream', () => ({
  eventStream: () => ({
    watch: () => () => undefined,
    onChange: (fn: (c: Change) => void) => {
      fireChange = fn;
      return () => undefined;
    },
    streaming: () => true,
  }),
}));

const Timeline = (await import('./Timeline.svelte')).default;
let component: Record<string, unknown> | undefined;
let target: HTMLDivElement | undefined;

const minute = (() => {
  const d = new Date();
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() - 5);
  return d.getTime();
})();
const AT = minute + 22_000;
const box = { x0: 0.1, y0: 0.1, x1: 0.4, y1: 0.9 };
const person = { category: 'person', subtype: 'person', score: 0.84, box };
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 10) => {
  for (let i = 0; i < n; i++) await tick();
  flushSync();
};
const q = (id: string) => target!.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const all = (id: string) => [...target!.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];

interface World {
  usage: unknown;
  usageStatus: number;
  checks: Record<string, unknown>[];
  post: (body: { at: number }) => Response | Promise<Response>;
  posts: number[];
}
let w: World;
const usage = (o: Record<string, unknown> = {}) => ({ enabled: true, paused: null, month: { calls: 14, limit: 1000 }, today: { calls: 2, cap: 30 }, checks: { today: 2, cap: 10 }, ...o });
const check = (stillTs: number, id: number, summary: unknown[] = [person], events: unknown[] = [{ id: 5, kind: 'person', confirmed: true }]) => ({ id, eventId: null, stillTs, provider: 'google-vision', summary, events, imageUrl: `/api/cameras/den/still-checks/${id}.jpg` });

beforeEach(() => {
  w = { usage: usage(), usageStatus: 200, checks: [], post: () => json({}, 500), posts: [] };
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url.includes('/previews?')) return json([{ minute, cols: 10, rows: 6, tileW: 160, tileH: 90, intervalS: 1, present: Array(60).fill(true), url: `/x/${minute}.jpg` }]);
    if (url.includes('/stills?')) return json(Array.from({ length: 60 }, (_, i) => minute + i * 1000));
    if (url.includes('/events?')) return json({ events: [] });
    if (url.endsWith('/analytics')) return w.usageStatus === 200 ? json(w.usage) : json({ error: 'too_old' }, w.usageStatus);
    if (url.includes('/still-checks?')) return json(w.checks);
    if (url.endsWith('/still-checks') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { at: number };
      w.posts.push(body.at);
      return w.post(body);
    }
    const one = /\/still-checks\/(\d+)$/.exec(url);
    if (one) return json({ ...check(AT, Number(one[1])), objects: [{ name: 'Person', score: 0.84, box }, { name: 'Ceiling fan', score: 0.6, box }] });
    return json({});
  });
  cameras.set([{ id: 'den', name: 'Den', webUiUrl: null, proxy: true }]);
  selectedCameraId.set('den');
  sessionStorage.clear();
  history.replaceState(null, '', '/app/timeline');
});
afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  component = target = undefined;
  cameras.set([]);
  vi.unstubAllGlobals();
});

// The page at a second (the shared cursor), its large still open.
async function openAt(ts: number) {
  saveViewPoint('den', ts);
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(Timeline, { target });
  await settle();
  expect(q('timeline-still')).not.toBeNull();
}
const button = () => q('still-check-button') as HTMLButtonElement;

describe('the check button', () => {
  it('is ready with the budget beside it', async () => {
    await openAt(AT);
    expect(button().disabled).toBe(false);
    expect(button().textContent).toContain('✧ Check with Vision');
    expect(q('still-check-usage')?.textContent).toBe('14 of 1000 Vision calls this month · 2 of 10 checks today');
  });

  for (const [name, u, reason] of [
    ['Vision off', usage({ enabled: false }), 'Vision is off for this camera'],
    ['paused', usage({ paused: { reason: 'bad_key', until: null } }), 'Vision is paused (invalid key)'],
    ['checks off', usage({ checks: { today: 0, cap: 0 } }), 'Checks are off for this camera'],
    ['the monthly limit', usage({ month: { calls: 1000, limit: 1000 } }), 'Monthly limit reached (1000)'],
    ['the daily cap', usage({ today: { calls: 30, cap: 30 } }), "Today's Vision cap is reached (30)"],
    ['the checks cap', usage({ checks: { today: 10, cap: 10 } }), "Today's checks are used (10)"],
  ] as const) {
    it(`is disabled with the reason for ${name}`, async () => {
      w.usage = u;
      await openAt(AT);
      expect(button().disabled).toBe(true);
      expect(button().title).toBe(reason);
      expect(q('still-check-reason')?.textContent).toBe(reason);
    });
  }

  it('says an older gateway is too old', async () => {
    w.usageStatus = 404;
    await openAt(AT);
    expect(button().disabled).toBe(true);
    expect(q('still-check-reason')?.textContent).toBe('This camera gateway is too old for checks');
  });
});

describe('a check', () => {
  it('spins, then shows the result in place: boxes, findings, the confirmed event, the mark and the list', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    w.post = async ({ at }) => {
      await held;
      return json({ reused: false, check: { ...check(at, 17), objects: [{ name: 'Person', score: 0.84, box }] } }, 201);
    };
    await openAt(AT);
    expect(q('timeline-boxes')).toBeNull();
    button().click();
    await settle(3);
    expect(q('still-check-spinner')).not.toBeNull();
    expect(button().disabled).toBe(true);
    expect(button().textContent).toContain('Checking…');
    w.usage = usage({ checks: { today: 3, cap: 10 } });
    release();
    await settle();
    expect(w.posts).toEqual([AT]);
    expect(q('still-check-spinner')).toBeNull();
    expect(q('timeline-boxes')).not.toBeNull();
    expect((q('timeline-still') as HTMLImageElement).getAttribute('src')).toBe('/api/cameras/den/still-checks/17.jpg');
    expect(q('still-check-result')?.textContent).toContain('✧ Vision: Person 84%');
    expect(q('still-check-confirms')?.textContent).toContain('Confirms the Person event');
    // Klaus 2026-10-04: a spaced dash between the parts (whitespace at an element's edge used to vanish).
    expect(q('still-check-result')?.textContent).toContain('✧ Vision: Person 84% — Confirms the Person event');
    expect(button().textContent).toMatch(/✧ Checked/);
    expect(button().disabled).toBe(true);
    expect(q('still-check-usage')?.textContent).toContain('3 of 10 checks today');
    // The marks: ✧ on the second, a dotted corner on the minute; the chip's count.
    const second = target!.querySelector(`[data-testid="timeline-second"][data-ts="${AT}"]`)!;
    expect(second.classList.contains('checked')).toBe(true);
    expect(second.querySelector('[data-testid="timeline-check-mark"]')?.textContent).toBe('✧');
    expect(target!.querySelector(`[data-testid="timeline-minute"][data-minute="${minute}"]`)!.classList.contains('checked')).toBe(true);
    expect(q('checks-chip')?.textContent).toBe('✧ Checks (1)');
    // The object list (#158): Show all objects, then a row per object.
    (q('timeline-show-all') as HTMLInputElement).click();
    await settle();
    expect(all('still-object').map((x) => x.textContent)).toEqual([expect.stringContaining('Person')]);
  });

  it('says "nothing relevant"', async () => {
    w.post = ({ at }) => json({ reused: false, check: { ...check(at, 18, [], []), objects: [] } }, 201);
    await openAt(AT);
    button().click();
    await settle();
    expect(q('still-check-result')?.textContent).toContain('✧ Vision: nothing relevant');
    expect(q('still-check-confirms')).toBeNull();
    expect(q('timeline-boxes')).toBeNull();
  });

  it('says when the answer was stored already', async () => {
    w.post = ({ at }) => json({ reused: true, source: 'check', check: check(at, 4) });
    await openAt(AT);
    button().click();
    await settle();
    expect(q('still-check-reused')?.textContent).toContain('Checked before, no new call');
  });

  it('shows an event’s answer for its second, without a check in the list', async () => {
    w.post = ({ at }) => json({ reused: true, source: 'event', check: { ...check(at, 0), id: null, eventId: 812, imageUrl: null } });
    await openAt(AT);
    button().click();
    await settle();
    expect(q('still-check-reused')?.textContent).toContain('Analysed before with its event');
    expect((q('timeline-still') as HTMLImageElement).getAttribute('src')).toBe(`/api/cameras/den/stills/${AT}.jpg`);
    expect(q('checks-chip')?.textContent).toBe('✧ Checks (0)');
  });

  for (const [status, body, text] of [
    [429, { error: 'limit', reason: 'checks' }, "Today's checks are used"],
    [502, { error: 'provider_failed', reason: 'timeout' }, 'Vision did not answer in time. Nothing was stored; try again.'],
    [502, { error: 'provider_failed', reason: 'aborted' }, 'The check was cancelled (the camera gateway is stopping). Try again.'],
    [503, { error: 'analytics_paused', reason: 'bad_key', until: null }, 'Vision is paused: the key was refused. It resumes after a settings change or a new key.'],
    [400, { error: 'invalid', detail: 'at is older than the stills kept (7 days)' }, 'Too old to check: stills are kept 7 days'],
  ] as const) {
    it(`says why it failed: ${body.error} ${'reason' in body ? body.reason : ''}`, async () => {
      w.post = () => json(body, status);
      await openAt(AT);
      button().click();
      await settle();
      expect(q('still-check-error')?.textContent).toBe(text);
      expect(button().disabled).toBe(false); // pressing again may work
      expect(q('timeline-boxes')).toBeNull();
    });
  }
});

describe('the day’s checks', () => {
  it('open a checked second with its result at once, no call', async () => {
    w.checks = [check(AT, 7)];
    await openAt(AT);
    expect(q('timeline-boxes')).not.toBeNull();
    expect(button().textContent).toMatch(/✧ Checked/);
    expect(w.posts).toEqual([]);
  });

  it('list in the chip, a row opens its second, ◀ ✧ ▶ and Shift+arrows step', async () => {
    w.checks = [check(minute + 5000, 1, []), check(AT, 2), check(minute + 40_000, 3, [], [])];
    await openAt(minute + 10_000);
    expect(q('checks-list')).toBeNull();
    q('checks-chip')!.click();
    flushSync();
    const rows = all('checks-row');
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain('nothing relevant');
    expect(rows[0].textContent).toContain('in a Person event');
    expect(rows[2].textContent).toContain('outside any event');
    rows[1].click();
    await settle();
    expect(q('timeline-large-time')?.textContent).toBe(new Date(AT).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    expect(q('timeline-boxes')).not.toBeNull();
    // ◀ ✧ / ✧ ▶
    (q('timeline-check-next') as HTMLButtonElement).click();
    await settle();
    expect(target!.querySelector('[data-testid="checks-row"][aria-current="true"]')?.getAttribute('data-ts')).toBe(String(minute + 40_000));
    expect((q('timeline-check-next') as HTMLButtonElement).disabled).toBe(true);
    // Shift+← twice: back to the first; plain ← still steps one second.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true }));
    await settle();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true }));
    await settle();
    expect(target!.querySelector('[data-testid="checks-row"][aria-current="true"]')?.getAttribute('data-ts')).toBe(String(minute + 5000));
    expect((q('timeline-check-prev') as HTMLButtonElement).disabled).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    await settle();
    expect(target!.querySelector('[data-testid="checks-row"][aria-current="true"]')).toBeNull();
  });

  it('come in live: a still-check change reloads the list and the marks', async () => {
    await openAt(AT);
    expect(q('checks-chip')?.textContent).toBe('✧ Checks (0)');
    w.checks = [check(AT, 9)];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      fireChange!({ cam: 'den', type: 'still-check', ts: AT });
      fireChange!({ cam: 'other', type: 'still-check', ts: AT });
      vi.advanceTimersByTime(400);
    } finally {
      vi.useRealTimers();
    }
    await settle();
    expect(q('checks-chip')?.textContent).toBe('✧ Checks (1)');
    expect(q('timeline-boxes')).not.toBeNull();
    expect(button().textContent).toMatch(/✧ Checked/);
  });
});

// "Save clip around this" (#179 phase 3, spec §5): next to the check button
// on every second, and in a check's result; it opens the Save dialog there.
describe('Save clip around this', () => {
  it('sits next to the check button and opens the Save dialog at that second', async () => {
    await openAt(AT);
    const around = q('still-around-button') as HTMLButtonElement;
    expect(around.textContent).toBe('Save clip around this');
    expect(around.disabled).toBe(false);
    expect(around.closest('[data-testid="still-check"]')).not.toBeNull();
    expect(q('still-check-around')).toBeNull(); // no result yet
    around.click();
    await settle();
    const dialog = q('compose-dialog')!;
    expect(dialog.getAttribute('aria-label')).toMatch(/^Save clip around /);
    expect((q('compose-thumb') as HTMLImageElement).getAttribute('src')).toBe(`/api/cameras/den/stills/${AT}.jpg`);
    expect(q('compose-length')?.textContent).toBe('Result: 21s · at most 5m');
    (q('compose-close') as HTMLButtonElement).click();
    await settle();
    expect(q('compose-dialog')).toBeNull();
  });

  it('keeps the Timeline\'s keys off while the dialog is open; Escape closes only the dialog', async () => {
    await openAt(AT);
    (q('still-around-button') as HTMLButtonElement).click();
    await settle();
    const time = q('timeline-large-time')!.textContent;
    (q('compose-close') as HTMLButtonElement).focus();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    await settle();
    expect(q('timeline-large-time')!.textContent).toBe(time);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    expect(q('compose-dialog')).toBeNull();
    expect(q('timeline-large')).not.toBeNull();
  });

  it('is offered in a check\'s result too', async () => {
    w.checks = [check(AT, 9)];
    await openAt(AT);
    const link = q('still-check-around') as HTMLButtonElement;
    expect(link.textContent).toBe('Save clip around this');
    expect(link.closest('[data-testid="still-check-result"]')).not.toBeNull();
    link.click();
    await settle();
    expect(q('compose-dialog')).not.toBeNull();
  });
});
