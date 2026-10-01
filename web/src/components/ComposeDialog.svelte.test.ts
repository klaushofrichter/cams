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

describe('ComposeDialog', () => {
  it('names the clip’s kinds Motion first, as the list does (Klaus, 2026-10-01)', () => {
    render(vi.fn(), true, { ...clip, triggers: ['person', 'motion'] });
    expect(target!.querySelector('.clip span')!.textContent).toMatch(/· Motion, Person$/);
  });

  it('saves the original clip when nothing changes', () => {
    render();
    expect(q('compose-generate')).toBeNull();
    expect(q('compose-save')!.getAttribute('href')).toBe('/api/cameras/den/clips/20260928-140000-140020/download?quality=sub');
    expect(q('compose-length')!.textContent).toContain('0:20');
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
      expect(q('compose-length')!.textContent).toContain('0:50');
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
    set('compose-pre', '60');
    set('compose-post', '10');
    expect(q('compose-error')!.textContent).toBe('At most 1:00');
    expect(q('compose-generate')).toBeNull();
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
    set('compose-post', '99');
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
    expect(q('compose-length')!.textContent).toContain('0:20');
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
      expect(q('compose-length')!.textContent).toContain('0:20');
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
        expect(q('compose-length')!.textContent).toContain('0:20'); // the roll doesn't count
      }
      choose('720p');
      q('compose-generate')!.click(); // a resized copy of the clip alone
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      expect(JSON.parse(String(calls[0].body))).toMatchObject({ preS: 0, postS: 0, size: '720p' });
      choose('sd');
      expect((q('compose-pre') as HTMLInputElement).disabled).toBe(false);
      expect(q('compose-roll-note')).toBeNull();
      expect(q('compose-length')!.textContent).toContain('0:30'); // the post-roll counts again
    });

    it('without a cam-proxy offers only SD and 4K, saved as they are', () => {
      const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
      vi.stubGlobal('fetch', fetchSpy);
      render(vi.fn(), false);
      expect(q('compose-pre')).toBeNull();
      expect(q('compose-post')).toBeNull();
      expect([...(q('compose-size') as HTMLSelectElement).options].map((o) => o.value)).toEqual(['sd', '4k']);
      expect(q('compose-save')!.getAttribute('href')).toBe(SUB);
      choose('4k');
      expect(q('compose-save')!.getAttribute('href')).toBe(MAIN);
      expect(fetchSpy).not.toHaveBeenCalled(); // no proxy to ask about a copy
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
