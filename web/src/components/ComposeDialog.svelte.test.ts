// web/src/components/ComposeDialog.svelte.test.ts
// @vitest-environment jsdom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ComposeDialog from './ComposeDialog.svelte';

const clip = { id: '20260928-140000-140020', start: '2026-09-28T14:00:00-05:00', end: '2026-09-28T14:00:20-05:00', durationSec: 20, triggers: ['person' as const], sizeSub: 1, sizeMain: 1 };
let component: Record<string, unknown> | undefined;
let target: HTMLDivElement | undefined;
afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  component = target = undefined;
  vi.unstubAllGlobals();
});
function render(onclose = vi.fn(), composable = true, c: typeof clip | (Omit<typeof clip, 'triggers'> & { triggers: ('person' | 'motion')[] }) = clip) {
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(ComposeDialog, { target, props: { camera: 'den', clip: c, onclose, composable } });
  flushSync();
  return onclose;
}
// The page's visibility, with its event; null puts jsdom's own back.
function visibility(v: 'visible' | 'hidden' | null) {
  if (v === null) return void delete (document as { visibilityState?: unknown }).visibilityState;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v });
  document.dispatchEvent(new Event('visibilitychange'));
}
const q = (id: string) => target!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const set = (id: string, v: string) => {
  const el = q(id) as HTMLInputElement;
  el.value = v;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
};

const fq = (f: { mock: { calls: unknown[][] } }) => f.mock.calls.filter(([u]) => String(u).endsWith('/full-quality')).length;
const set4k = () => {
  const el = q('compose-size') as HTMLSelectElement;
  el.value = '4k';
  el.dispatchEvent(new Event('change', { bubbles: true }));
  flushSync();
};

describe('ComposeDialog', () => {
  // Klaus, 2026-10-02: no silent quality downgrade.
  it('says when the full-resolution file isn’t available, disables 4K’s Save, and offers the standard quality', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('/full-quality') ? { available: false } : { available: true }), { status: 200 })));
    render();
    set4k();
    await vi.waitFor(() => expect(q('compose-4k-unavailable')).not.toBeNull());
    expect(q('compose-use-sd')!.textContent).toBe('Use the standard quality');
    expect(q('compose-4k-unavailable')!.textContent).toBe("The full-resolution file isn't available right now; download the standard quality instead.");
    expect(q('compose-save')!.getAttribute('aria-disabled')).toBe('true');
    expect(q('compose-save')!.hasAttribute('href')).toBe(false);
    q('compose-use-sd')!.click();
    flushSync();
    expect((q('compose-size') as HTMLSelectElement).value).toBe('sd');
    expect(q('compose-4k-unavailable')).toBeNull();
    expect(q('compose-save')!.getAttribute('href')).toMatch(/download\?quality=sub/);
  });

  it('re-checks on Save: a file that went away since 4K was chosen shows the message and starts no download', async () => {
    let avail = true;
    const fetch = vi.fn(async (_url: string) => new Response(JSON.stringify({ available: avail }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render();
    set4k();
    await vi.waitFor(() => expect(fq(fetch)).toBe(1));
    avail = false;
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    q('compose-save')!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(q('compose-4k-unavailable')).not.toBeNull());
    expect(fq(fetch)).toBe(2);
    expect(q('compose-4k-unavailable')!.getAttribute('role')).toBe('alert');
    expect(click).not.toHaveBeenCalled();
    click.mockRestore();
  });

  it('starts the 4K download itself after a Save re-check that says available, without buffering it', async () => {
    const fetch = vi.fn(async (_url: string) => new Response(JSON.stringify({ available: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const hrefs: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { hrefs.push(this.getAttribute('href') ?? ''); });
    render();
    set4k();
    await vi.waitFor(() => expect(fq(fetch)).toBe(1));
    q('compose-save')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(hrefs.length).toBe(1));
    expect(hrefs[0]).toMatch(/download\?quality=main/);
    expect(fetch.mock.calls.some(([u]) => String(u).includes('/download'))).toBe(false); // the file itself is never fetched by script
    click.mockRestore();
  });

  it('asks again when 4K is chosen again', async () => {
    let avail = false;
    const fetch = vi.fn(async (_url: string) => new Response(JSON.stringify({ available: avail }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    render();
    set4k();
    await vi.waitFor(() => expect(q('compose-4k-unavailable')).not.toBeNull());
    q('compose-use-sd')!.click();
    flushSync();
    avail = true;
    set4k();
    await vi.waitFor(() => expect(q('compose-4k-unavailable')).toBeNull());
    expect(fq(fetch)).toBe(2);
    expect(q('compose-save')!.getAttribute('href')).toMatch(/quality=main/);
  });

  it('keeps 4K’s Save when the full-resolution file is available', async () => {
    const fetch = vi.fn(async (_url: string) => new Response(JSON.stringify({ available: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    render();
    set4k();
    await vi.waitFor(() => expect(fetch.mock.calls.some(([u]) => String(u).endsWith('/api/cameras/den/clips/20260928-140000-140020/full-quality'))).toBe(true));
    flushSync();
    expect(q('compose-4k-unavailable')).toBeNull();
    expect(q('compose-save')!.getAttribute('href')).toMatch(/download\?quality=main/);
  });

  it('names the clip’s kinds Motion first, as the list does (Klaus, 2026-10-01)', () => {
    render(vi.fn(), true, { ...clip, triggers: ['person', 'motion'] });
    expect(target!.querySelector('.clip span')!.textContent).toMatch(/· Motion, Person$/);
  });

  it('saves the original clip when nothing changes', () => {
    render();
    expect(q('compose-generate')).toBeNull();
    expect(q('compose-save')!.getAttribute('href')).toBe('/api/cameras/den/clips/20260928-140000-140020/download?quality=sub');
    expect(q('compose-length')!.textContent).toBe('Result: 20 s · at most 600 s (10:00)');
  });

  it('offers Generate for a post-roll, and disables Save until the result is ready', async () => {
    const calls: [string, RequestInit | undefined][] = [];
    let polls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      if (init?.method === 'POST') return new Response(JSON.stringify({ id: 'a'.repeat(22), state: 'running', progress: 0, durationS: 50 }), { status: 201 });
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      if (url.includes('/available')) return new Response('{"available":true}', { status: 200 });
      polls++;
      return new Response(JSON.stringify({ id: 'a'.repeat(22), state: polls > 1 ? 'done' : 'running', progress: polls > 1 ? 1 : 0.5, durationS: 50 }), { status: 200 });
    }));
    vi.useFakeTimers();
    try {
      render();
      set('compose-post', '30');
      expect(q('compose-length')!.textContent).toBe('Result: 50 s · at most 300 s (5:00)');
      expect(q('compose-save')!.getAttribute('aria-disabled')).toBe('true');
      q('compose-generate')!.click();
      await vi.advanceTimersByTimeAsync(10);
      flushSync();
      expect(JSON.parse(String(calls.find((c) => c[1]?.method === 'POST')![1]!.body))).toEqual({ eventId: clip.id, preS: 0, postS: 30, size: 'sd', badge: true, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      await vi.advanceTimersByTimeAsync(1000);
      flushSync();
      expect((q('compose-progress') as HTMLProgressElement).value).toBe(0.5);
      await vi.advanceTimersByTimeAsync(1000);
      flushSync();
      expect(q('compose-player')!.getAttribute('src')).toBe(`/api/cameras/den/compositions/${'a'.repeat(22)}/video?inline=1`);
      expect(q('compose-save')!.getAttribute('aria-disabled')).toBe('false');
      expect(q('compose-save')!.getAttribute('href')).toContain('name=den-2026-09-28_14-00-00-composed-sd.mp4');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the limit instead of Generate when the result would be too long', () => {
    render();
    set('compose-pre', '270');
    set('compose-post', '11');
    expect(q('compose-error')!.textContent).toBe('At most 300 s (5:00)');
    expect(q('compose-generate')).toBeNull();
  });

  // Klaus, 2026-10-04 (images 15 and 16): a 114 s motion clip.
  const long = { ...clip, id: '20261004-071650-071844', start: '2026-10-04T07:16:50-05:00', end: '2026-10-04T07:18:44-05:00', durationSec: 114, triggers: ['motion' as const] };
  it('saves a 114 s clip as it is (image 15), in seconds everywhere', () => {
    render(vi.fn(), true, long);
    expect(target!.querySelector('.clip span')!.textContent).toMatch(/ · 114 s \(1:54\) · Motion$/);
    expect(q('compose-error')).toBeNull();
    expect(q('compose-length')!.textContent).toBe('Result: 114 s (1:54) · at most 600 s (10:00)');
    expect(q('compose-save')!.getAttribute('aria-disabled')).toBe('false');
    expect(q('compose-save')!.getAttribute('href')).toBe('/api/cameras/den/clips/20261004-071650-071844/download?quality=sub');
  });

  it('generates pre-roll -100, post-roll 30 of it as 44 s (image 16)', () => {
    render(vi.fn(), true, long);
    set('compose-pre', '-100');
    set('compose-post', '30');
    expect(q('compose-length')!.textContent).toBe('Result: 44 s · at most 300 s (5:00)');
    expect(q('compose-generate')).not.toBeNull();
    expect((q('compose-pre-slider') as HTMLInputElement).value).toBe('-100');
    expect((q('compose-post-slider') as HTMLInputElement).value).toBe('30');
  });

  it('keeps slider and field in step, and the sliders never past the limit', () => {
    render(vi.fn(), true, long);
    const pre = q('compose-pre-slider') as HTMLInputElement;
    const post = q('compose-post-slider') as HTMLInputElement;
    expect([pre.min, pre.max, post.min, post.max]).toEqual(['-113', '186', '-113', '186']);
    set('compose-post-slider', '30');
    expect((q('compose-post') as HTMLInputElement).value).toBe('30');
    expect(pre.max).toBe('156'); // 114 + 156 + 30 = 300
    set('compose-pre-slider', '156');
    expect((q('compose-pre') as HTMLInputElement).value).toBe('156');
    expect(q('compose-length')!.textContent).toBe('Result: 300 s (5:00) · at most 300 s (5:00)');
    expect(post.max).toBe('30');
    set('compose-pre', '-100');
    expect(pre.value).toBe('-100');
    expect(post.min).toBe('-13'); // 1 s of the clip stays
  });

  it('lowers the sliders’ limit at 1080p', () => {
    render(vi.fn(), true, long);
    const sel = q('compose-size') as HTMLSelectElement;
    sel.value = '1080p';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    flushSync();
    expect((q('compose-pre-slider') as HTMLInputElement).disabled).toBe(true); // no rolls but at SD
    expect(q('compose-length')!.textContent).toBe('Result: 114 s (1:54) · at most 120 s (2:00)');
  });

  it('opens a clip longer than a plain save cut at its end to 300 s, and says so', () => {
    render(vi.fn(), true, { ...long, id: '20261004-070000-071140', end: '2026-10-04T07:11:40-05:00', durationSec: 700 });
    expect((q('compose-post') as HTMLInputElement).value).toBe('-400');
    expect((q('compose-post-slider') as HTMLInputElement).value).toBe('-400');
    expect(q('compose-preset-note')!.textContent).toBe('This recording is 700 s (11:40), longer than a save can be: the post-roll cuts it to 300 s (5:00) at its end.');
    expect(q('compose-length')!.textContent).toBe('Result: 300 s (5:00) · at most 300 s (5:00)');
    expect(q('compose-generate')).not.toBeNull();
  });

  it('refuses a 4K save longer than 600 s', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"available":true}', { status: 200 })));
    render(vi.fn(), true, { ...long, id: '20261004-070000-071140', end: '2026-10-04T07:11:40-05:00', durationSec: 700 });
    set4k();
    expect(q('compose-error')!.textContent).toBe('At most 600 s (10:00)');
    expect(q('compose-save')!.getAttribute('aria-disabled')).toBe('true');
    expect(q('compose-preset-note')).toBeNull();
  });

  it('Close cancels a running job and closes', async () => {
    const methods: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      methods.push(init?.method ?? 'GET');
      return new Response(JSON.stringify({ id: 'b'.repeat(22), state: 'running', progress: 0.1, durationS: 30 }), { status: init?.method === 'POST' ? 201 : 200 });
    }));
    const onclose = render();
    set('compose-post', '10');
    q('compose-generate')!.click();
    await new Promise((r) => setTimeout(r, 10));
    q('compose-close')!.click();
    expect(methods).toContain('DELETE');
    expect(onclose).toHaveBeenCalled();
  });

  // Final review I2–I6: races around Generate, stale polls, bad polls.
  const job = (id: string, state = 'running', progress = 0.2) => ({ id: id.repeat(22), state, progress, durationS: 30 });
  function server(o: { post?: () => Promise<Response>; poll?: () => Promise<Response> } = {}) {
    const calls: { method: string; url: string; body?: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ method, url, body: init?.body as string | undefined });
      if (method === 'POST') return o.post ? o.post() : new Response(JSON.stringify(job('c')), { status: 201 });
      if (method === 'DELETE') return new Response(null, { status: 204 });
      return o.poll ? o.poll() : new Response(JSON.stringify(job('c')), { status: 200 });
    }));
    return calls;
  }
  const settle = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    flushSync();
  };

  it('starts one job on a double click, and sends the time zone of the viewer', async () => {
    const calls = server();
    render();
    set('compose-post', '10');
    q('compose-generate')!.click();
    q('compose-generate')?.click();
    await settle();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(JSON.parse(calls.find((c) => c.method === 'POST')!.body!).timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it('cancels a job whose start answer arrives after Close', async () => {
    let answer!: (r: Response) => void;
    const calls = server({ post: () => new Promise((r) => (answer = r)) });
    const onclose = render();
    set('compose-post', '10');
    q('compose-generate')!.click();
    q('compose-close')!.click();
    answer(new Response(JSON.stringify(job('d')), { status: 201 }));
    await settle();
    expect(onclose).toHaveBeenCalled();
    expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('d'.repeat(22)))).toBe(true);
  });

  it('drops a job whose start answer arrives after an edit', async () => {
    let answer!: (r: Response) => void;
    const calls = server({ post: () => new Promise((r) => (answer = r)) });
    render();
    set('compose-post', '10');
    q('compose-generate')!.click();
    set('compose-post', '12');
    answer(new Response(JSON.stringify(job('e')), { status: 201 }));
    await settle();
    expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('e'.repeat(22)))).toBe(true);
    expect(q('compose-progress')).toBeNull();
    expect(q('compose-generate')).not.toBeNull();
  });

  it('ignores a poll answer that arrives after Cancel', async () => {
    vi.useFakeTimers();
    try {
      let answer!: (r: Response) => void;
      server({ poll: () => new Promise((r) => (answer = r)) });
      render();
      set('compose-post', '10');
      q('compose-generate')!.click();
      await vi.advanceTimersByTimeAsync(1000); // a poll is in flight
      q('compose-cancel')!.click();
      answer(new Response(JSON.stringify(job('c', 'running', 0.6)), { status: 200 }));
      await vi.advanceTimersByTimeAsync(10);
      flushSync();
      expect(q('compose-progress')).toBeNull();
      expect(q('compose-generate')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rides out a bad poll or two, then finishes', async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      server({
        poll: async () => {
          n++;
          if (n === 1) throw new TypeError('network error'); // a dropped connection
          if (n === 2) return new Response('{"error":"proxy_unavailable"}', { status: 502 });
          return new Response(JSON.stringify(job('c', 'done', 1)), { status: 200 });
        },
      });
      render();
      set('compose-post', '10');
      q('compose-generate')!.click();
      await vi.advanceTimersByTimeAsync(3500);
      flushSync();
      expect(q('compose-player')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the reason the proxy refused', async () => {
    server({ post: async () => new Response(JSON.stringify({ error: 'invalid', detail: 'at least 1 s of the clip must remain' }), { status: 400 }) });
    render();
    set('compose-post', '10');
    q('compose-generate')!.click();
    await settle();
    expect(target!.textContent).toContain('At least 1 s of the clip must remain');
  });

  // Issue #72 items.
  it('moves focus into the dialog, keeps Tab inside it, and gives it back on close', async () => {
    server();
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const onclose = render();
    await settle(); // focus moves in after the first render
    const dialog = q('compose-dialog')!;
    expect(dialog.contains(document.activeElement)).toBe(true);
    const focusable = [...dialog.querySelectorAll<HTMLElement>('button, input, select, a[href]')].filter((e) => !e.hasAttribute('disabled'));
    focusable.at(-1)!.focus();
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(focusable[0]);
    q('compose-close')!.click();
    expect(onclose).toHaveBeenCalled();
    component && unmount(component);
    component = undefined;
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('labels the progress and announces the length politely', async () => {
    server();
    render();
    set('compose-post', '10');
    expect(q('compose-length')!.getAttribute('role')).toBe('status');
    set('compose-post', '281');
    expect(q('compose-error')!.getAttribute('role')).toBe('status');
    set('compose-post', '10');
    q('compose-generate')!.click();
    await settle();
    expect(q('compose-progress')!.getAttribute('aria-label')).toBe('Composing');
  });

  it('says when the proxy has no copy of the clip, and offers only the plain save', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('/available') ? { available: false } : {}), { status: 200 })));
    render();
    await settle();
    expect(q('compose-unavailable')!.textContent).toContain('no copy of this clip');
    expect(q('compose-post')).toBeNull();
    expect(q('compose-save')!.getAttribute('href')).toContain('quality=sub');
  });

  it('drops a pre-/post-roll typed before the proxy said it has no copy (issue #76)', async () => {
    let answer: (r: Response) => void = () => {};
    vi.stubGlobal('fetch', vi.fn((url: string) => (url.includes('/available') ? new Promise<Response>((r) => (answer = r)) : Promise.resolve(new Response('{}', { status: 200 })))));
    render();
    set('compose-post', '30');
    expect(q('compose-generate')).not.toBeNull();
    answer(new Response('{"available":false}', { status: 200 }));
    await settle();
    expect(q('compose-unavailable')).not.toBeNull();
    expect(q('compose-generate')).toBeNull();
    expect(q('compose-save')!.getAttribute('href')).toContain('quality=sub');
    expect(q('compose-length')!.textContent).toContain('Result: 20 s');
  });

  it('keeps a finished result alive while the dialog is open', async () => {
    vi.useFakeTimers();
    try {
      const calls = server({ poll: async () => new Response(JSON.stringify(job('c', 'done', 1)), { status: 200 }) });
      render();
      set('compose-post', '10');
      q('compose-generate')!.click();
      await vi.advanceTimersByTimeAsync(1000);
      const before = calls.filter((c) => c.method === 'GET' && !c.url.includes('/available')).length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls.filter((c) => c.method === 'GET' && !c.url.includes('/available')).length).toBeGreaterThan(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says a composition stopped while the page was in the background', async () => {
    vi.useFakeTimers();
    try {
      let gone = false;
      server({ poll: async () => (gone ? new Response('{"error":"not_found"}', { status: 404 }) : new Response(JSON.stringify(job('c')), { status: 200 })) });
      render();
      set('compose-post', '10');
      q('compose-generate')!.click();
      await vi.advanceTimersByTimeAsync(1000);
      visibility('hidden');
      gone = true; // the proxy swept it while the phone was elsewhere
      visibility('visible');
      await vi.advanceTimersByTimeAsync(10);
      flushSync();
      expect(target!.textContent).toContain('stopped while the page was in the background');
    } finally {
      vi.useRealTimers();
      visibility(null);
    }
  });

  // Issue #76: the interval poll may answer before the visibility poll.
  it('says "in the background" even when the interval poll finds it gone first', async () => {
    vi.useFakeTimers();
    try {
      let gone = false;
      server({ poll: async () => (gone ? new Response('{"error":"not_found"}', { status: 404 }) : new Response(JSON.stringify(job('c')), { status: 200 })) });
      render();
      set('compose-post', '10');
      q('compose-generate')!.click();
      await vi.advanceTimersByTimeAsync(1000);
      visibility('hidden');
      gone = true;
      await vi.advanceTimersByTimeAsync(1000); // the interval poll, still hidden
      visibility('visible');
      await vi.advanceTimersByTimeAsync(10);
      flushSync();
      expect(target!.textContent).toContain('stopped while the page was in the background');
      expect(target!.textContent).not.toContain('was lost');
    } finally {
      vi.useRealTimers();
      visibility(null);
    }
  });

  // Review of #76: a hide before the job started does not count.
  it('calls a job lost on its first poll "lost", even after the page was hidden before Generate', async () => {
    vi.useFakeTimers();
    try {
      server({ poll: async () => new Response('{"error":"not_found"}', { status: 404 }) });
      render();
      visibility('hidden');
      visibility('visible');
      set('compose-post', '10');
      q('compose-generate')!.click();
      await vi.advanceTimersByTimeAsync(1000);
      flushSync();
      expect(target!.textContent).toContain('was lost');
      expect(target!.textContent).not.toContain('in the background');
    } finally {
      vi.useRealTimers();
      visibility(null);
    }
  });

  // Review: after Generate again, the new result must be kept alive too.
  it('keeps a regenerated result alive as well', async () => {
    vi.useFakeTimers();
    try {
      const calls = server({ poll: async () => new Response(JSON.stringify(job('c', 'done', 1)), { status: 200 }) });
      render();
      set('compose-post', '10');
      q('compose-generate')!.click();
      await vi.advanceTimersByTimeAsync(1000);
      q('compose-generate')!.click(); // Generate again
      await vi.advanceTimersByTimeAsync(1000);
      const polls = () => calls.filter((c) => c.method === 'GET' && !c.url.includes('/available')).length;
      const before = polls();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(polls()).toBeGreaterThan(before);
    } finally {
      vi.useRealTimers();
    }
  });

  // Klaus, 2026-09-29: every download goes through this dialog; 4K (the
  // camera's original main stream, formerly "Full") is one of its sizes.
  describe('as the only way to download (History cards)', () => {
    const SUB = '/api/cameras/den/clips/20260928-140000-140020/download?quality=sub';
    const MAIN = '/api/cameras/den/clips/20260928-140000-140020/download?quality=main';
    const choose = (v: string) => {
      const el = q('compose-size') as HTMLSelectElement;
      el.value = v;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      flushSync();
    };

    it('is titled for any save, not only SD', () => {
      render();
      expect(target!.querySelector('h2')!.textContent).toBe('Save clip');
    });

    it('offers 4K, which saves the original with no pre- or post-roll', () => {
      render();
      expect([...(q('compose-size') as HTMLSelectElement).options].map((o) => o.value)).toContain('4k');
      set('compose-post', '10');
      choose('4k');
      expect((q('compose-pre') as HTMLInputElement).disabled).toBe(true);
      expect((q('compose-post') as HTMLInputElement).disabled).toBe(true);
      expect(q('compose-4k-note')).not.toBeNull();
      expect(q('compose-generate')).toBeNull();
      expect(q('compose-save')!.getAttribute('href')).toBe(MAIN);
      expect(q('compose-save')!.getAttribute('aria-disabled')).toBe('false');
      expect(q('compose-length')!.textContent).toContain('Result: 20 s');
    });

    // Klaus, 2026-09-29: pre- and post-roll are for SD only.
    it('dims pre- and post-roll for every size but SD, with a note, and resizes without them', async () => {
      const calls: RequestInit[] = [];
      vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          calls.push(init);
          return new Response(JSON.stringify({ id: 'b'.repeat(22), state: 'running', progress: 0, durationS: 20 }), { status: 201 });
        }
        if (init?.method === 'DELETE') return new Response(null, { status: 204 });
        return new Response('{"available":true}', { status: 200 });
      }));
      render();
      expect((q('compose-pre') as HTMLInputElement).disabled).toBe(false);
      expect(q('compose-roll-note')).toBeNull();
      set('compose-post', '10');
      for (const size of ['360p', '720p', '1080p', '4k']) {
        choose(size);
        expect((q('compose-pre') as HTMLInputElement).disabled).toBe(true);
        expect((q('compose-post') as HTMLInputElement).disabled).toBe(true);
        expect(q('compose-roll-note')!.textContent).toMatch(/only for SD/i);
        expect(q('compose-length')!.textContent).toContain('Result: 20 s'); // the roll doesn't count
      }
      choose('720p');
      q('compose-generate')!.click(); // a resized copy of the clip alone
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      expect(JSON.parse(String(calls[0].body))).toMatchObject({ preS: 0, postS: 0, size: '720p' });
      choose('sd');
      expect((q('compose-pre') as HTMLInputElement).disabled).toBe(false);
      expect(q('compose-roll-note')).toBeNull();
      expect(q('compose-length')!.textContent).toContain('Result: 30 s'); // the post-roll counts again
    });

    // Final review, minor 4: a camera without a cam-proxy saves exactly as on
    // main: no /full-quality question, and Save is the plain <a download>
    // (no script click after an await, which iOS Safari may not allow).
    it('without a cam-proxy offers only SD and 4K, saved as they are, with no question asked', async () => {
      const fetchSpy = vi.fn(async (_url: string) => new Response('{}', { status: 200 }));
      vi.stubGlobal('fetch', fetchSpy);
      const scripted = vi.spyOn(HTMLAnchorElement.prototype, 'click');
      render(vi.fn(), false);
      expect(q('compose-pre')).toBeNull();
      expect(q('compose-post')).toBeNull();
      expect([...(q('compose-size') as HTMLSelectElement).options].map((o) => o.value)).toEqual(['sd', '4k']);
      expect(q('compose-save')!.getAttribute('href')).toBe(SUB);
      choose('4k');
      expect(q('compose-save')!.getAttribute('href')).toBe(MAIN);
      const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
      // Last in the bubble path (after the dialog's own handler): records
      // whether the dialog prevented the browser's download, then stops jsdom's navigation.
      const prevented: boolean[] = [];
      const last = (e: Event) => {
        prevented.push(e.defaultPrevented);
        e.preventDefault();
      };
      document.addEventListener('click', last, { once: true });
      q('compose-save')!.dispatchEvent(ev);
      await new Promise((r) => setTimeout(r, 20));
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(scripted).not.toHaveBeenCalled();
      expect(prevented).toEqual([false]); // the browser's own download
      scripted.mockRestore();
    });

    it('when the proxy has no copy, still lets you pick SD or 4K', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{"available":false}', { status: 200 })));
      render();
      await vi.waitFor(() => expect(q('compose-unavailable')).not.toBeNull());
      flushSync();
      expect([...(q('compose-size') as HTMLSelectElement).options].map((o) => o.value)).toEqual(['sd', '4k']);
      choose('4k');
      expect(q('compose-save')!.getAttribute('href')).toBe(MAIN);
    });
  });
});
