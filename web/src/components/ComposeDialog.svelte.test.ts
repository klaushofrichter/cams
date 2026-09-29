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
function render(onclose = vi.fn()) {
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(ComposeDialog, { target, props: { camera: 'den', clip, onclose } });
  flushSync();
  return onclose;
}
const q = (id: string) => target!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const set = (id: string, v: string) => {
  const el = q(id) as HTMLInputElement;
  el.value = v;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
};

describe('ComposeDialog', () => {
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
      expect(JSON.parse(String(calls[0][1]!.body))).toEqual({ eventId: clip.id, preS: 0, postS: 30, size: 'sd', badge: true });
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
});
