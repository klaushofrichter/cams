// @vitest-environment jsdom
//
// Plan 7: while live video isn't playing, Live shows the camera gateway's
// newest still. It is loaded one at a time (review I2), not while Live is
// hidden (M2), drawn only once loaded (I1), and clearly marked as stills,
// with the still's time and age (Klaus, 2026-09-27).
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LiveStill from './LiveStill.svelte';

// fetch answers the test controls: resolve(ok, stillTime) or fail.
const calls: { url: string; resolve: (ok: boolean, time?: number) => void }[] = [];
let component: Record<string, unknown> | undefined;
let target: HTMLDivElement | undefined;
beforeEach(() => {
  calls.length = 0;
  vi.useFakeTimers({ now: new Date('2026-09-27T19:03:08Z'), toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.stubGlobal('fetch', (url: string) =>
    new Promise<Response>((res) => {
      calls.push({
        url,
        resolve: (ok, time) =>
          res(ok ? new Response(new Blob([new Uint8Array([0xff, 0xd8, 0xff])]), { status: 200, headers: { 'X-Still-Time': String(time), 'Content-Type': 'image/jpeg' } }) : new Response('', { status: 404 })),
      });
    }),
  );
  let n = 0;
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => `blob:still-${++n}`, revokeObjectURL: () => undefined }));
});
afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  component = target = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

type Props = { cameraId: string; active?: boolean; freshOnly?: boolean; onactive?: (on: boolean) => void };
function render(init: Props): Props {
  const props = $state(init);
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(LiveStill, { target, props });
  flushSync();
  return props;
}
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  flushSync();
};
const q = (id: string) => target!.querySelector(`[data-testid="${id}"]`);

describe('LiveStill', () => {
  it('marks the stills with their time and age, and tells Live', async () => {
    const active: boolean[] = [];
    render({ cameraId: 'den', onactive: (on) => active.push(on) });
    expect(calls[0].url).toMatch(/^\/api\/cameras\/den\/still\/latest\.jpg\?t=\d+$/);
    expect(q('live-still')).toBeNull();
    calls[0].resolve(true, Date.parse('2026-09-27T19:03:05Z'));
    await settle();
    expect((q('live-still') as HTMLElement).querySelector('img')!.getAttribute('src')).toBe('blob:still-1');
    expect(q('stills-badge')!.textContent).toMatch(/STILLS/);
    expect(q('stills-badge')!.textContent).toMatch(/3 s old/);
    expect(active).toEqual([true]);
  });

  it('asks for the next still only when the last is done', async () => {
    render({ cameraId: 'den' });
    vi.advanceTimersByTime(3000);
    expect(calls).toHaveLength(1);
    calls[0].resolve(true, Date.now());
    await settle();
    vi.advanceTimersByTime(1000);
    expect(calls).toHaveLength(2);
  });

  it('hides after a failed load, tells Live, and tries again after 5 s', async () => {
    const active: boolean[] = [];
    render({ cameraId: 'den', onactive: (on) => active.push(on) });
    calls[0].resolve(true, Date.now());
    await settle();
    vi.advanceTimersByTime(1000);
    calls[1].resolve(false);
    await settle();
    expect(q('live-still')).toBeNull();
    expect(active).toEqual([true, false]);
    vi.advanceTimersByTime(3000);
    expect(calls).toHaveLength(2);
    vi.advanceTimersByTime(3000);
    expect(calls).toHaveLength(3);
  });

  it('asks for nothing while Live is hidden', () => {
    render({ cameraId: 'den', active: false });
    vi.advanceTimersByTime(5000);
    expect(calls).toHaveLength(0);
  });

  // Klaus, 2026-10-06: while the live view connects, a still less than 60 s
  // old shows at once instead of a black player.
  describe('while connecting (freshOnly)', () => {
    const img = () => (q('live-still') as HTMLElement | null)?.querySelector('img')?.getAttribute('src') ?? null;

    it('shows a still less than 60 s old at once, marked as stills', async () => {
      const active: boolean[] = [];
      render({ cameraId: 'den', freshOnly: true, onactive: (on) => active.push(on) });
      expect(calls).toHaveLength(1);
      calls[0].resolve(true, Date.now() - 20_000);
      await settle();
      expect(img()).toBe('blob:still-1');
      expect(q('stills-badge')!.textContent).toMatch(/^STILLS · .* · 20 s old$/);
      expect(active).toEqual([true]);
    });

    it('replaces it with newer stills, one request at a time', async () => {
      render({ cameraId: 'den', freshOnly: true });
      calls[0].resolve(true, Date.now() - 3_000);
      await settle();
      vi.advanceTimersByTime(1000);
      expect(calls).toHaveLength(2);
      calls[1].resolve(true, Date.now() - 1_000);
      await settle();
      expect(img()).toBe('blob:still-2');
    });

    it('keeps the shown still when the gateway answers the same one again', async () => {
      render({ cameraId: 'den', freshOnly: true });
      const at = Date.now() - 3_000;
      calls[0].resolve(true, at);
      await settle();
      vi.advanceTimersByTime(1000);
      calls[1].resolve(true, at);
      await settle();
      expect(img()).toBe('blob:still-1');
    });

    it('shows nothing for a still 60 s old or older, and asks no more until the fallback', async () => {
      const active: boolean[] = [];
      const props = render({ cameraId: 'den', freshOnly: true, onactive: (on) => active.push(on) });
      calls[0].resolve(true, Date.now() - 60_000);
      await settle();
      expect(q('live-still')).toBeNull();
      expect(active).toEqual([]);
      vi.advanceTimersByTime(4000);
      expect(calls).toHaveLength(1); // one request on connect, no more
      // The 5 s fallback: any still, polled each second, as before.
      props.freshOnly = false;
      flushSync();
      vi.advanceTimersByTime(1000);
      expect(calls).toHaveLength(2);
      calls[1].resolve(true, Date.now() - 90_000);
      await settle();
      expect(img()).not.toBeNull();
      expect(active).toEqual([true]);
    });

    it('goes on to the fallback without a new request or a flicker', async () => {
      const active: boolean[] = [];
      const props = render({ cameraId: 'den', freshOnly: true, onactive: (on) => active.push(on) });
      calls[0].resolve(true, Date.now() - 2_000);
      await settle();
      props.freshOnly = false;
      flushSync();
      expect(calls).toHaveLength(1);
      expect(img()).toBe('blob:still-1');
      expect(active).toEqual([true]);
    });

    it("never shows the old camera's still after a camera switch", async () => {
      const props = render({ cameraId: 'den', freshOnly: true });
      props.cameraId = 'porch';
      flushSync();
      expect(calls.map((c) => c.url.split('?')[0])).toEqual(['/api/cameras/den/still/latest.jpg', '/api/cameras/porch/still/latest.jpg']);
      calls[0].resolve(true, Date.now() - 1_000); // den's late answer
      await settle();
      expect(q('live-still')).toBeNull();
      calls[1].resolve(true, Date.now() - 2_000);
      await settle();
      expect(img()).toBe('blob:still-1'); // porch's: den's never became an image
      expect(q('stills-badge')!.textContent).toMatch(/2 s old$/);
    });
  });
});
