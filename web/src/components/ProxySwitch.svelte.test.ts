// @vitest-environment jsdom
//
// The Settings page's "use cam-proxy" switch (Klaus, 2026-09-27): one per
// camera, for all users. It sends the PUT, updates the camera list the other
// pages read, and puts the switch back when the server refuses.
import { flushSync, mount, unmount } from 'svelte';
import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProxySwitch from './ProxySwitch.svelte';
import { cameras } from '../lib/stores';

const calls: { url: string; init: RequestInit }[] = [];
let answer = { status: 200, body: {} as unknown };
let component: Record<string, unknown> | undefined;
let target: HTMLDivElement | undefined;

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (init?.method === 'PUT') calls.push({ url, init }); // the switch's requests (not the info lookup)
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  });
  cameras.set([
    { id: 'den', name: 'Den', webUiUrl: null, proxy: true, proxyConfigured: true },
    { id: 'shed', name: 'Shed', webUiUrl: null, proxy: false, proxyConfigured: false },
  ]);
});
afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  component = target = undefined;
  vi.unstubAllGlobals();
  cameras.set([]);
});

function render(cameraId: string) {
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(ProxySwitch, { target, props: { cameraId } });
  flushSync();
  return target;
}
const box = () => target!.querySelector<HTMLInputElement>('[data-testid="proxy-toggle"]');
const settle = () => new Promise((r) => setTimeout(r, 0)).then(() => flushSync());

describe('ProxySwitch', () => {
  it('shows nothing for a camera without a cam-proxy', () => {
    render('shed');
    expect(box()).toBeNull();
  });

  it('turns the proxy off and on, and updates the camera list', async () => {
    render('den');
    expect(box()!.checked).toBe(true);
    answer = { status: 200, body: { enabled: false } };
    box()!.click();
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/cameras/den/proxy');
    expect(calls[0].init.method).toBe('PUT');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ enabled: false });
    expect(get(cameras).find((c) => c.id === 'den')?.proxy).toBe(false);
    expect(box()!.checked).toBe(false);
    expect(target!.textContent).toMatch(/only from the camera/i);

    answer = { status: 200, body: { enabled: true } };
    box()!.click();
    await settle();
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ enabled: true });
    expect(get(cameras).find((c) => c.id === 'den')?.proxy).toBe(true);
  });

  it('puts the switch back and says so when the server refuses', async () => {
    render('den');
    answer = { status: 500, body: { error: 'internal' } };
    box()!.click();
    await settle();
    expect(box()!.checked).toBe(true);
    expect(get(cameras).find((c) => c.id === 'den')?.proxy).toBe(true);
    expect(target!.querySelector('[data-testid="proxy-error"]')?.textContent).toMatch(/could not/i);
  });

  it('updates the camera it was switched for, even after the picker moved on (M4)', async () => {
    cameras.set([
      { id: 'den', name: 'Den', webUiUrl: null, proxy: true, proxyConfigured: true },
      { id: 'barn', name: 'Barn', webUiUrl: null, proxy: true, proxyConfigured: true },
    ]);
    let release!: () => void;
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      if (init?.method !== 'PUT') return Promise.resolve(new Response(JSON.stringify({ reachable: false, webUrl: null }), { status: 200 }));
      calls.push({ url, init });
      return new Promise<Response>((r) => (release = () => r(new Response(JSON.stringify({ enabled: false }), { status: 200 }))));
    });
    target = document.createElement('div');
    document.body.appendChild(target);
    const props = $state({ cameraId: 'den' });
    component = mount(ProxySwitch, { target, props });
    flushSync();
    box()!.click();
    props.cameraId = 'barn';
    flushSync();
    release();
    await settle();
    expect(get(cameras).find((c) => c.id === 'den')?.proxy).toBe(false);
    expect(get(cameras).find((c) => c.id === 'barn')?.proxy).toBe(true);
  });

  it('links to the camera’s cam-proxy while it answers', async () => {
    vi.stubGlobal('fetch', async (url: string) =>
      new Response(JSON.stringify(url.endsWith('/proxy/info') ? { reachable: true, webUrl: 'https://proxy.example' } : {}), { status: 200 }));
    render('den');
    await settle();
    const a = target!.querySelector('[data-testid="proxy-web-link"]') as HTMLAnchorElement;
    expect(a.getAttribute('href')).toBe('https://proxy.example');
    expect(a.getAttribute('target')).toBe('_blank');
  });

  it('shows no link when the proxy is unreachable', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ reachable: false, webUrl: null }), { status: 200 }));
    render('den');
    await settle();
    expect(target!.querySelector('[data-testid="proxy-web-link"]')).toBeNull();
    expect(target!.querySelector('[data-testid="proxy-unreachable"]')).not.toBeNull();
  });
});


describe('ProxySwitch for a viewer (migration P4, M §9.5)', () => {
  it('no switch; the state is shown', async () => {
    const { me } = await import('../lib/stores');
    me.set({ email: 'v@example.org', version: 'v', buildDate: null, role: 'viewer' });
    try {
      render('den');
      expect(box()).toBeNull();
      expect(target!.querySelector('[data-testid="proxy-note"]')!.textContent).toContain('cam-proxy');
    } finally {
      me.set(null);
    }
  });
});
