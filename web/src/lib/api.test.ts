// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apiFetch,
  checkSession,
  getJson,
  HttpError,
  renewalUrl,
  resetSessionState,
  safeReturnPath,
  SILENT_GAP_MS,
  SILENT_KEY,
  UnauthorizedError,
  watchMediaErrors,
} from './api';
import { putJson } from './settings';

// An expired session (issue #153, R2): a silent renewal back to the same
// page, else the start page; once per page load, never in a loop.

const expired = () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

let assign: ReturnType<typeof vi.fn>;
function page(path: string) {
  const u = new URL(path, 'http://cams.test');
  assign = vi.fn();
  vi.stubGlobal('location', { href: u.href, origin: u.origin, pathname: u.pathname, search: u.search, hash: u.hash, assign });
}

class MemoryStore {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
}

beforeEach(() => {
  resetSessionState();
  sessionStorage.clear();
  page('/app/recordings?cam=den&panel=history#x');
});
afterEach(() => vi.unstubAllGlobals());

describe('safeReturnPath (web copy)', () => {
  it.each(['/app', '/app/live', '/app/recordings?cam=cam1&panel=history', '/app/timeline#t'])('accepts %s', (p) => expect(safeReturnPath(p)).toBe(p));
  it.each([
    '//evil.example', '/\\evil.example', 'https://evil.example/app', 'javascript:alert(1)', '/apps', '/application', '/app//evil.example',
    '/app/../x', '/app/%2e%2e/x', '/app/\t/x', '/app\n', '', undefined, 42, 'app/live', ' /app',
  ])('rejects %s', (p) => expect(safeReturnPath(p)).toBeNull());
});

describe('renewalUrl', () => {
  it('tries the silent renewal first, back to the same page', () => {
    const store = new MemoryStore();
    expect(renewalUrl('/app/settings?cam=cam1', store, 1_000_000)).toBe(`/auth/google/login?silent=1&returnTo=${encodeURIComponent('/app/settings?cam=cam1')}`);
    expect(store.getItem(SILENT_KEY)).toBe('1000000');
  });

  it('goes to the start page instead when a silent attempt was made in the last minutes', () => {
    const store = new MemoryStore();
    renewalUrl('/app/live', store, 1_000_000);
    expect(renewalUrl('/app/live', store, 1_000_000 + SILENT_GAP_MS - 1)).toBe(`/?returnTo=${encodeURIComponent('/app/live')}`);
    // Later on, a new silent attempt is fine again.
    expect(renewalUrl('/app/live', store, 1_000_000 + SILENT_GAP_MS)).toMatch(/^\/auth\/google\/login\?silent=1&/);
  });

  it('never tries silently without sessionStorage (no loop guard, no attempt)', () => {
    expect(renewalUrl('/app/live', null)).toBe('/?returnTo=%2Fapp%2Flive');
    const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => undefined };
    expect(renewalUrl('/app/live', throwing)).toBe('/?returnTo=%2Fapp%2Flive');
  });

  it('never carries an unsafe page as returnTo', () => {
    expect(renewalUrl('//evil.example/app', null)).toBe('/?returnTo=%2Fapp');
    expect(renewalUrl('/app/../admin', null)).toBe('/?returnTo=%2Fapp');
  });
});

describe('an expired session', () => {
  it('getJson leaves once for the silent renewal, with this page as returnTo', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => expired()));
    await expect(getJson('/api/me')).rejects.toBeInstanceOf(UnauthorizedError);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(`/auth/google/login?silent=1&returnTo=${encodeURIComponent('/app/recordings?cam=den&panel=history#x')}`);
  });

  it('several 401s at once redirect only once', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => expired()));
    const all = await Promise.allSettled([getJson('/api/me'), getJson('/api/cameras'), putJson('/api/preferences', {}), apiFetch('/api/x', { method: 'POST' })]);
    expect(all.every((r) => r.status === 'rejected' && r.reason instanceof UnauthorizedError)).toBe(true);
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it('the next page load within minutes goes to the start page, not silently again', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => expired()));
    await getJson('/api/me').catch(() => undefined);
    resetSessionState(); // the page we came back to
    page('/app/live');
    await getJson('/api/me').catch(() => undefined);
    expect(assign).toHaveBeenCalledWith('/?returnTo=%2Fapp%2Flive');
  });

  it('a camera or cam-proxy refusing its credentials is not a session expiry', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      url.endsWith('/a')
        ? new Response(JSON.stringify({ error: 'auth_failed' }), { status: 503 })
        : new Response(JSON.stringify({ error: 'proxy_unauthorized' }), { status: 401 })));
    const a = await getJson('/api/cameras/den/a').catch((e: unknown) => e);
    expect(a).toBeInstanceOf(HttpError);
    expect((a as HttpError).code).toBe('auth_failed');
    const b = await getJson('/api/cameras/den/b').catch((e: unknown) => e);
    expect(b).toBeInstanceOf(HttpError);
    expect((b as HttpError).status).toBe(401);
    expect(assign).not.toHaveBeenCalled();
  });

  it('a 401 without a JSON body is not taken for one either', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>401</html>', { status: 401 })));
    const res = await apiFetch('/api/x');
    expect(res.status).toBe(401);
    expect(assign).not.toHaveBeenCalled();
  });

  it('apiFetch leaves the body for the caller', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ a: 1 })));
    expect(await (await apiFetch('/api/x')).json()).toEqual({ a: 1 });
  });
});

describe('images, videos and the event stream', () => {
  it('a failed /api image asks /api/me, at most every 30 s', async () => {
    const fetch = vi.fn(async () => expired());
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('location', { ...location, href: 'http://localhost:3000/app/live', origin: 'http://localhost:3000', pathname: '/app/live', search: '', hash: '' });
    const stop = watchMediaErrors();
    try {
      const img = document.createElement('img');
      img.setAttribute('src', '/api/cameras/den/clips/1/thumb.jpg');
      document.body.appendChild(img);
      img.dispatchEvent(new Event('error'));
      img.dispatchEvent(new Event('error'));
      await vi.waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith('/api/me', expect.anything());
    } finally {
      stop();
    }
  });

  it('ignores images that are not from /api', () => {
    const fetch = vi.fn(async () => ok({}));
    vi.stubGlobal('fetch', fetch);
    const stop = watchMediaErrors();
    try {
      for (const src of ['https://other.example/api/x.jpg', '/favicon.svg', 'blob:http://cams.test/abc']) {
        const img = document.createElement('img');
        img.setAttribute('src', src);
        document.body.appendChild(img);
        img.dispatchEvent(new Event('error'));
      }
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it('checkSession does nothing while the session is fine', async () => {
    const fetch = vi.fn(async () => ok({ email: 'a@b.c' }));
    vi.stubGlobal('fetch', fetch);
    checkSession(1_000);
    checkSession(2_000);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(assign).not.toHaveBeenCalled();
    checkSession(1_000 + 30_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('several accounts, none chosen (migration P4, R4-13)', () => {
  const choose = () => new Response(JSON.stringify({ error: 'choose_account' }), { status: 409, headers: { 'Content-Type': 'application/json' } });
  it('a 409 choose_account opens the account picker, once', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => choose()));
    await expect(getJson('/api/cameras')).rejects.toThrow();
    await expect(getJson('/api/preferences')).rejects.toThrow();
    expect(assign.mock.calls).toEqual([['/app/accounts']]);
  });
  it('not on the picker page itself', async () => {
    page('/app/accounts');
    vi.stubGlobal('fetch', vi.fn(async () => choose()));
    await expect(getJson('/api/cameras')).rejects.toThrow();
    expect(assign).not.toHaveBeenCalled();
  });
});
