// "Save clip around this" (#179 phase 3, spec 2026-10-04-still-checks-ui-design
// §5): the Save dialog anchored at a second instead of a clip.
// @vitest-environment jsdom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ComposeDialog from './ComposeDialog.svelte';
import { localClock } from '../lib/clock';

let component: Record<string, unknown> | undefined;
let target: HTMLDivElement | undefined;
afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  component = target = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const AGO = 120_000;
function render(at = Math.floor(Date.now() / 1000) * 1000 - AGO, onclose = vi.fn(), noStill = false) {
  const stillSrc = noStill ? undefined : `/api/cameras/den/proxy/stills/${at}.jpg`;
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(ComposeDialog, { target, props: { camera: 'den', at, stillSrc, onclose } });
  flushSync();
  return at;
}
const q = (id: string) => target!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const set = (id: string, v: string) => {
  const el = q(id) as HTMLInputElement;
  el.value = v;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
};
const size = (v: string) => {
  const el = q('compose-size') as HTMLSelectElement;
  el.value = v;
  el.dispatchEvent(new Event('change', { bubbles: true }));
  flushSync();
};
type Call = { url: string; method: string; body: Record<string, unknown> | null };
// The proxy through cams: the dry run's plan (or a 409), the job, its polls.
function server(plan: object | 'nothing' = { start: 0, end: 0, durationS: 21, seconds: { clip: 0, still: 21, card: 0 }, clips: [] }) {
  const calls: Call[] = [];
  let polls = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ url, method: init?.method ?? 'GET', body });
    if (init?.method === 'POST' && body?.dryRun) return plan === 'nothing' ? new Response('{"error":"nothing_to_compose","detail":"no clip or still covers any second of this window"}', { status: 409 }) : new Response(JSON.stringify(plan), { status: 200 });
    if (init?.method === 'POST') return new Response(JSON.stringify({ id: 'b'.repeat(22), state: 'running', progress: 0, durationS: 21, name: 'den-2026-10-04_14-03-22-around.mp4' }), { status: 201 });
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    polls++;
    return new Response(JSON.stringify({ id: 'b'.repeat(22), state: polls > 1 ? 'done' : 'running', progress: polls > 1 ? 1 : 0.5, durationS: 21 }), { status: 200 });
  }));
  return calls;
}

describe('ComposeDialog around a second', () => {
  it('opens at -10/+10 (21s) with the second\'s still, every composed size and no 4K', () => {
    server();
    const at = render();
    expect(q('compose-dialog')!.getAttribute('aria-label')).toBe(`Save clip around ${localClock(at)}`);
    expect(target!.querySelector('h2')!.textContent).toBe(`Save clip around ${localClock(at)}`);
    expect(q('compose-thumb')!.getAttribute('src')).toBe(`/api/cameras/den/proxy/stills/${at}.jpg`);
    expect((q('compose-pre') as HTMLInputElement).value).toBe('10');
    expect((q('compose-post') as HTMLInputElement).value).toBe('10');
    expect(q('compose-length')!.textContent).toBe('Result: 21s · at most 5m');
    const sizes = [...(q('compose-size') as HTMLSelectElement).options].map((o) => o.value);
    expect(sizes).toEqual(['sd', '360p', '720p', '1080p']);
    expect(q('compose-badge')).not.toBeNull();
    expect(q('compose-save')!.getAttribute('aria-disabled')).toBe('true'); // nothing to save as it is
    expect(q('compose-generate')).not.toBeNull();
  });

  it('keeps the rolls at every size, with the size\'s limit', () => {
    server();
    render();
    size('720p');
    expect((q('compose-pre') as HTMLInputElement).disabled).toBe(false);
    expect(q('compose-roll-note')).toBeNull();
    size('1080p');
    expect(q('compose-length')!.textContent).toBe('Result: 21s · at most 2m');
    expect(q('compose-post-slider')!.getAttribute('max')).toBe('119');
    set('compose-pre', '110');
    expect(q('compose-error')!.textContent).toBe('At most 2m');
    expect(q('compose-generate')).toBeNull();
    set('compose-pre', '-3');
    expect(q('compose-error')!.textContent).toBe('Whole seconds from 0 to 3600');
  });

  it('stops the post-roll at the seconds already past', () => {
    server();
    render(Math.floor(Date.now() / 1000) * 1000 - 5000);
    expect((q('compose-post') as HTMLInputElement).value).toBe('4');
    expect(q('compose-post-slider')!.getAttribute('max')).toBe('4');
    expect(q('compose-pre-slider')!.getAttribute('max')).toBe('299');
    expect(q('compose-length')!.textContent).toBe('Result: 15s · at most 5m');
  });

  // Review of #190: the cap grows while the dialog is open, and Generate
  // checks it again.
  it('lets the post-roll grow as seconds pass, and checks it again on Generate', async () => {
    vi.useFakeTimers();
    const calls = server();
    const at = Math.floor(Date.now() / 1000) * 1000 - 3000;
    render(at);
    expect((q('compose-post') as HTMLInputElement).value).toBe('2');
    expect(q('compose-post-slider')!.getAttribute('max')).toBe('2');
    await vi.advanceTimersByTimeAsync(20_000);
    flushSync();
    expect(Number(q('compose-post-slider')!.getAttribute('max'))).toBeGreaterThanOrEqual(21);
    set('compose-post', '15');
    expect(q('compose-length')!.textContent).toBe('Result: 26s · at most 5m');
    q('compose-generate')!.click();
    await vi.advanceTimersByTimeAsync(10);
    flushSync();
    expect(calls.find((c) => c.method === 'POST' && !c.body?.dryRun)!.body).toMatchObject({ at, preS: 10, postS: 15 });
  });

  it('refuses on Generate a post-roll past the seconds already past', async () => {
    vi.useFakeTimers();
    const calls = server();
    render(Math.floor(Date.now() / 1000) * 1000 - 3000);
    set('compose-post', '9'); // typed past the cap of 2
    expect(q('compose-error')!.textContent).toBe('At most 2 s after: the clip can only end at a second already past');
    expect(q('compose-generate')).toBeNull();
    expect(calls.filter((c) => c.method === 'POST' && !c.body?.dryRun)).toHaveLength(0);
  });

  it('hides the picture when the second has no still', () => {
    server();
    render(undefined, vi.fn(), true);
    expect(q('compose-thumb')).toBeNull();
    if (component) unmount(component);
    target?.remove();
    render();
    q('compose-thumb')!.dispatchEvent(new Event('error'));
    flushSync();
    expect(q('compose-thumb')).toBeNull();
  });

  it('says what the clip will be made of, from a dry run after the last change', async () => {
    vi.useFakeTimers();
    const at = Math.floor(Date.now() / 1000) * 1000 - AGO;
    const calls = server({ start: at - 10_000, end: at + 11_000, durationS: 21, seconds: { clip: 14, still: 7, card: 0 }, clips: [{ start: at - 3000, end: at + 40_000 }] });
    render(at);
    set('compose-post', '12');
    set('compose-post', '11');
    await vi.advanceTimersByTimeAsync(400);
    flushSync();
    const dry = calls.filter((c) => c.body?.dryRun);
    expect(dry).toHaveLength(1);
    expect(dry[0].body).toEqual({ at, preS: 10, postS: 11, size: 'sd', badge: true, dryRun: true });
    expect(q('compose-made-of')!.textContent).toBe(`Made of: FTP clip ${localClock(at - 3000)}–${localClock(at + 40_000)} and stills (1 per second)`);
  });

  it('turns Generate off when nothing is kept around the second', async () => {
    vi.useFakeTimers();
    server('nothing');
    render();
    await vi.advanceTimersByTimeAsync(400);
    flushSync();
    expect(q('compose-nothing')!.textContent).toBe('Nothing is kept around this second (stills and clips are kept 7 days).');
    expect(q('compose-generate')).toBeNull();
    expect(q('compose-made-of')).toBeNull();
  });

  it('generates around the second and saves it under the server\'s name', async () => {
    vi.useFakeTimers();
    const calls = server();
    const at = render();
    size('720p');
    await vi.advanceTimersByTimeAsync(400);
    flushSync();
    q('compose-generate')!.click();
    await vi.advanceTimersByTimeAsync(10);
    flushSync();
    const start = calls.find((c) => c.method === 'POST' && !c.body?.dryRun)!;
    expect(start.body).toEqual({ at, preS: 10, postS: 10, size: '720p', badge: true, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    await vi.advanceTimersByTimeAsync(2000);
    flushSync();
    expect(q('compose-player')!.getAttribute('src')).toBe(`/api/cameras/den/compositions/${'b'.repeat(22)}/video?inline=1`);
    expect(q('compose-save')!.getAttribute('aria-disabled')).toBe('false');
    expect(q('compose-save')!.getAttribute('href')).toContain('name=den-2026-10-04_14-03-22-around.mp4');
  });

  it('shows the proxy\'s refusal of the real request', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      if (body?.dryRun) return new Response('{"error":"proxy_unavailable"}', { status: 502 });
      return new Response('{"error":"rate_limited"}', { status: 429 });
    }));
    render();
    q('compose-generate')!.click();
    await vi.waitFor(() => expect(target!.querySelector('[role="alert"]')?.textContent).toBe('Too many clips this minute; try again shortly.'));
    expect(q('compose-made-of')).toBeNull(); // a failed dry run shows no line
  });
});
