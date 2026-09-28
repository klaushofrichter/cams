// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openProxyUi } from './proxyLink';

// Opening the cam-proxy UI signs a cams user in with a one-time link
// (Klaus, 2026-09-28); without one it opens the plain address.
function fakeWindow() {
  const w = { opener: {} as unknown, location: { href: 'about:blank' } };
  vi.stubGlobal('open', vi.fn(() => w));
  return w;
}
afterEach(() => vi.unstubAllGlobals());

describe('openProxyUi', () => {
  it('opens a tab at once, then sends it to the one-time link', async () => {
    const w = fakeWindow();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ url: 'https://proxy.example/control/login-link?code=abc' }), { status: 200 })));
    await openProxyUi('cam2', 'https://proxy.example');
    expect(window.open).toHaveBeenCalledWith('', '_blank');
    expect(fetch).toHaveBeenCalledWith('/api/cameras/cam2/proxy/login-link', expect.objectContaining({ method: 'POST' }));
    expect(w.opener).toBeNull();
    expect(w.location.href).toBe('https://proxy.example/control/login-link?code=abc');
  });

  it('falls back to the plain address (token login) when there is no link', async () => {
    const w = fakeWindow();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'no_login_link' }), { status: 409 })));
    await openProxyUi('cam1', 'http://192.168.1.35:8480');
    expect(w.location.href).toBe('http://192.168.1.35:8480');
  });

  it('never follows a link to another address', async () => {
    const w = fakeWindow();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ url: 'https://evil.example/x' }), { status: 200 })));
    await openProxyUi('cam2', 'https://proxy.example');
    expect(w.location.href).toBe('https://proxy.example');
  });
});
