// @vitest-environment jsdom
//
// About requests each camera's device info once. It used to re-run its
// effect every time one answer landed in `devices`, and re-request every
// camera still in flight.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import About from './About.svelte';
import { cameras } from '../lib/stores';

let component: Record<string, unknown> | undefined;
let target: HTMLDivElement | undefined;

afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  component = target = undefined;
  cameras.set([]);
  vi.unstubAllGlobals();
});

describe('About', () => {
  it('requests each camera once, even while others are still loading', async () => {
    const calls: string[] = [];
    const pending: ((r: Response) => void)[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      calls.push(url);
      return new Promise<Response>((resolve) => pending.push(resolve));
    });
    cameras.set([
      { id: 'cam1', name: 'Den', webUiUrl: '' },
      { id: 'cam2', name: 'Porch', webUiUrl: '' },
    ]);
    target = document.createElement('div');
    document.body.appendChild(target);
    component = mount(About, { target });
    flushSync();
    expect(calls).toEqual(['/api/cameras/cam1/device', '/api/cameras/cam2/device']);

    // cam1 answers; cam2 is still in flight.
    pending[0](new Response(JSON.stringify({ model: 'RLC-1224A', firmware: 'v3' }), { status: 200 }));
    await vi.waitFor(() => expect(target!.textContent).toContain('RLC-1224A'));
    // Give a re-run of the effect (the bug) time to fire its request.
    await new Promise((r) => setTimeout(r, 20));
    flushSync();
    expect(calls).toEqual(['/api/cameras/cam1/device', '/api/cameras/cam2/device']);
  });
});

describe('About: Signed in as', () => {
  async function render(me: Record<string, unknown>) {
    const { me: meStore } = await import('../lib/stores');
    vi.stubGlobal('fetch', () => new Promise<Response>(() => undefined));
    meStore.set(me as never);
    target = document.createElement('div');
    document.body.appendChild(target);
    component = mount(About, { target });
    flushSync();
    return target.querySelector('[data-testid="about-signed-in"]')!.textContent;
  }

  it('a Google user: the address', async () => {
    expect(await render({ email: 'klaus@example.org', via: 'google', version: 'v', buildDate: null })).toBe('klaus@example.org');
  });

  it('a viewer token: its name and "valid until"', async () => {
    const until = Date.UTC(2026, 10, 12, 18, 30);
    const text = await render({ email: 'viewer-token:vtk_00000000000000000001', via: 'viewer-token', name: 'Kitchen tablet', validUntil: until, version: 'v', buildDate: null });
    expect(text).toBe(`Kitchen tablet, valid until ${new Date(until).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`);
    expect(text).not.toContain('vtk_');
  });

  it('the Pi\'s login token: its user', async () => {
    expect(await render({ email: 'local', via: 'token', version: 'v', buildDate: null })).toBe('local');
  });
});
