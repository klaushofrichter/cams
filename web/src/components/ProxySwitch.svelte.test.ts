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
    calls.push({ url, init });
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
});
