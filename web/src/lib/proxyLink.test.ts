// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openProxyClick, openProxyUi } from './proxyLink';

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

  // Issue #69 items.
  it('leaves Ctrl, ⌘, Shift and middle clicks to the browser', () => {
    fakeWindow();
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { button: 1 }]) {
      const e = new MouseEvent('click', { ...init, cancelable: true });
      openProxyClick(e, 'cam2', 'https://proxy.example');
      expect(e.defaultPrevented).toBe(false);
    }
    expect(window.open).not.toHaveBeenCalled();
  });

  it('lets the link open the plain address itself when the popup is blocked', () => {
    vi.stubGlobal('open', vi.fn(() => null));
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    const e = new MouseEvent('click', { cancelable: true });
    openProxyClick(e, 'cam2', 'https://proxy.example');
    expect(e.defaultPrevented).toBe(false); // the <a target=_blank> opens it
    expect(assign).not.toHaveBeenCalled();
  });

  it('takes over a plain click and sends the new tab to the link', async () => {
    const w = fakeWindow();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ url: 'https://proxy.example/control/login-link?code=abc' }), { status: 200 })));
    const e = new MouseEvent('click', { cancelable: true });
    await openProxyClick(e, 'cam2', 'https://proxy.example');
    expect(e.defaultPrevented).toBe(true);
    expect(w.location.href).toBe('https://proxy.example/control/login-link?code=abc');
  });
});
