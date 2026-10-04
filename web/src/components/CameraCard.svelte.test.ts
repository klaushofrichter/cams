// web/src/components/CameraCard.svelte.test.ts
// @vitest-environment jsdom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import CameraCard from './CameraCard.svelte';
import { liveUi } from '../lib/liveUi';
import { cameras } from '../lib/stores';
import { setCameraName } from '../lib/cameraName';

let component: Record<string, unknown> | undefined;
let target: HTMLDivElement | undefined;
beforeEach(() => {
  cameras.set([
    { id: 'cam1', name: 'Den', webUiUrl: 'https://cam1.example/', proxy: true, proxyConfigured: true },
    { id: 'cam2', name: 'Sim', webUiUrl: null, webUiNote: 'Simulated: no web page' },
  ]);
  liveUi.update((u) => ({ ...u, status: { id: 'cam1', online: true }, checking: false }));
});
afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  component = target = undefined;
  vi.unstubAllGlobals();
});
function render(props: Record<string, unknown> = {}) {
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(CameraCard, { target, props: { cameraId: 'cam1', proxyInfo: null, ...props } });
  flushSync();
  return target;
}
const q = (id: string) => target!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

describe('CameraCard', () => {
  it('links the camera’s name to its web page', () => {
    render();
    const name = q('camera-card-name') as HTMLAnchorElement;
    expect(name.tagName).toBe('A');
    expect(name.textContent).toBe('Den');
    expect(name.href).toBe('https://cam1.example/');
    expect(name.target).toBe('_blank');
    expect(name.rel).toContain('noopener');
  });

  it('shows the web page note on hover for a camera without one', () => {
    liveUi.update((u) => ({ ...u, status: { id: 'cam2', online: true } }));
    render({ cameraId: 'cam2' });
    const name = q('camera-card-name')!;
    expect(name.tagName).toBe('SPAN');
    expect(name.title).toBe('Simulated: no web page');
  });

  // Klaus, 2026-10-04: the card showed the old name ("Den") after a rename.
  it('follows a rename at once (the camera store, #169)', () => {
    render();
    setCameraName('cam1', 'Den Loft');
    flushSync();
    expect(q('camera-card-name')!.textContent).toBe('Den Loft');
  });

  it('has no Proxy link without a cam-proxy', () => {
    render();
    expect(q('camera-card-proxy')).toBeNull();
  });

  it('links "Proxy" to the cam-proxy through a one-time login link', async () => {
    const opened = { location: { href: '' }, opener: {} as unknown, close: vi.fn() };
    vi.stubGlobal('open', vi.fn(() => opened));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ url: 'https://proxy.example/login?t=1' }), { status: 200 })));
    render({ proxyInfo: { reachable: true, webUrl: 'https://proxy.example/' } });
    const link = q('camera-card-proxy') as HTMLAnchorElement;
    expect(link.tagName).toBe('A');
    expect(link.textContent!.trim()).toBe('Proxy');
    expect(link.href).toBe('https://proxy.example/');
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    await vi.waitFor(() => expect(opened.location.href).toBe('https://proxy.example/login?t=1'));
    expect(fetch).toHaveBeenCalledWith('/api/cameras/cam1/proxy/login-link', expect.objectContaining({ method: 'POST' }));
  });

  it('shows "Proxy" without a link while the proxy isn’t reachable', () => {
    render({ proxyInfo: { reachable: false, webUrl: null } });
    const p = q('camera-card-proxy')!;
    expect(p.tagName).toBe('SPAN');
    expect(p.title).toBe("cam-proxy isn't reachable right now");
  });

  it('puts "Proxy" after the name, at the right', () => {
    render({ proxyInfo: { reachable: true, webUrl: 'https://proxy.example/' } });
    expect(q('camera-card-name')!.compareDocumentPosition(q('camera-card-proxy')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows the camera’s state as a dot: online, offline, checking', () => {
    render();
    expect(q('camera-status')!.dataset.state).toBe('online');
    expect(q('camera-status')!.getAttribute('aria-label')).toBe('Online');
    liveUi.update((u) => ({ ...u, status: { id: 'cam1', online: false, error: 'camera_offline' } }));
    flushSync();
    expect(q('camera-status')!.dataset.state).toBe('offline');
    liveUi.update((u) => ({ ...u, status: null, checking: true }));
    flushSync();
    expect(q('camera-status')!.dataset.state).toBe('checking');
    // Another camera's status is no answer for this one.
    liveUi.update((u) => ({ ...u, status: { id: 'cam2', online: true }, checking: false }));
    flushSync();
    expect(q('camera-status')!.dataset.state).toBe('checking');
  });

  it('shows the offline banner with since when, and Retry checks again', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ id: 'cam1', online: true }), { status: 200 });
    });
    liveUi.update((u) => ({ ...u, status: { id: 'cam1', online: false, error: 'camera_offline', offlineSince: Date.now() - 12 * 60_000 } }));
    render();
    expect(q('offline-banner')!.textContent).toContain('Den is offline.');
    expect(q('offline-reason')!.textContent).toBe('The camera could not be reached.');
    expect(q('live-offline-since')!.textContent).toContain('12 minutes ago');
    q('retry')!.click();
    await vi.waitFor(() => expect(get(liveUi).status?.online).toBe(true));
    expect(urls).toContain('/api/cameras/cam1/status');
    flushSync();
    expect(q('offline-banner')).toBeNull();
  });

  it('no longer shows model, firmware or streams (Settings has them)', () => {
    liveUi.update((u) => ({ ...u, status: { id: 'cam1', online: true, model: 'RLC-1224A', firmware: 'v3', simulator: null, streams: { main: null, sub: null } } }));
    render();
    expect(target!.textContent).not.toContain('RLC-1224A');
    expect(q('camera-card-sim')).toBeNull();
  });

  // Review of #173: a simulated camera says so, its version on hover.
  it('tags a simulated camera, with the simulator’s version', () => {
    liveUi.update((u) => ({ ...u, status: { id: 'cam1', online: true, simulator: 'cam-sim 2026.09.29.1' } }));
    render();
    const tag = q('camera-card-sim')!;
    expect(tag.textContent!.trim()).toBe('Simulated');
    expect(tag.title).toBe('Simulated camera: cam-sim 2026.09.29.1');
  });
});
