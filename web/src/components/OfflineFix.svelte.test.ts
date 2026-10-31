// @vitest-environment jsdom
//
// The offline box's fixes for a camera behind a cam-proxy (spec §6.2): enter
// the camera's password, or trust the certificate the proxy measured; both
// relayed by cams with its proxy-admin token. Admins only.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OfflineFix from './OfflineFix.svelte';
import CameraTrust from './CameraTrust.svelte';
import CameraLogin from './CameraLogin.svelte';
import { cameras, me, type Me } from '../lib/stores';

const BASE: Me = { email: 'a@example.org', version: 'v', buildDate: null, account: { id: 'acc_A', name: 'alpha', displayName: 'Alpha' }, role: 'admin', accounts: 1, configSource: 'file', staleSince: null, configProblem: null, held: 0 };
const FP = `SHA256:${'AB'.repeat(32)}`;
const FP2 = `SHA256:${'CD'.repeat(32)}`;
let calls: { url: string; init?: RequestInit }[] = [];
let answers: Record<string, { status: number; body: unknown; headers?: Record<string, string> }[]> = {};
let component: Record<string, unknown> | undefined;
let target: HTMLDivElement | undefined;

beforeEach(() => {
  calls = [];
  answers = {};
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const list = answers[`${init?.method ?? 'GET'} ${url}`];
    const a = (list && list.length > 1 ? list.shift() : list?.[0]) ?? { status: 200, body: {} };
    return new Response(a.status === 204 ? null : JSON.stringify(a.body), { status: a.status, headers: { 'Content-Type': 'application/json', ...a.headers } });
  });
  me.set(BASE);
  cameras.set([{ id: 'den', name: 'Den', webUiUrl: null, throughProxy: true }]);
});
afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  document.body.innerHTML = '';
  component = target = undefined;
  vi.unstubAllGlobals();
  me.set(null);
  cameras.set([]);
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function render(C: any, props: Record<string, unknown> = {}) {
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(C, { target, props });
  flushSync();
  return target;
}
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  flushSync();
};
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const type = (id: string, value: string) => {
  const input = q(id) as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event('input'));
  flushSync();
};

describe('OfflineFix', () => {
  it('shows Enter password for a login problem, Trust certificate for a trust problem', () => {
    render(OfflineFix, { cameraId: 'den', fix: { login: 'refused', trust: null, canFix: true } });
    expect(q('offline-password')).not.toBeNull();
    expect(q('offline-trust')).toBeNull();
    unmount(component!);
    target!.remove();
    render(OfflineFix, { cameraId: 'den', fix: { login: null, trust: { fingerprint: FP }, canFix: true } });
    expect(q('offline-password')).toBeNull();
    expect(q('offline-trust')).not.toBeNull();
  });

  it('disables both without an admin token, with the admin-page hint', () => {
    render(OfflineFix, { cameraId: 'den', fix: { login: 'missing', trust: { fingerprint: FP }, canFix: false } });
    expect((q('offline-password') as HTMLButtonElement).disabled).toBe(true);
    expect((q('offline-trust') as HTMLButtonElement).disabled).toBe(true);
    expect(q('offline-fix-hint')!.textContent).toMatch(/admin page/);
  });

  it('shows nothing to viewers', () => {
    me.set({ ...BASE, role: 'viewer' });
    render(OfflineFix, { cameraId: 'den', fix: { login: 'missing', trust: { fingerprint: FP }, canFix: true } });
    expect(q('offline-fix')).toBeNull();
  });

  it('opens the password dialog, saves, and checks the camera again', async () => {
    answers['PUT /api/cameras/den/credentials'] = [{ status: 204, body: null }];
    render(OfflineFix, { cameraId: 'den', fix: { login: 'refused', trust: null, canFix: true } });
    q('offline-password')!.click();
    flushSync();
    expect(q('offline-password-dialog')).not.toBeNull();
    type('camera-password', 'pw-1');
    q('camera-password-save')!.click();
    await settle();
    expect(q('offline-password-dialog')).toBeNull();
    expect(calls.some((c) => c.url === '/api/cameras/den/status')).toBe(true);
  });
});

describe('CameraLogin for a camera behind a cam-proxy', () => {
  it('asks to save the login on the cam-proxy, without Secret instructions', async () => {
    answers['PUT /api/cameras/den/credentials'] = [{ status: 204, body: null }];
    render(CameraLogin, { cameraId: 'den', authFailed: true });
    expect(q('camera-login')!.textContent).toContain('Save the login for Den on its cam-proxy?');
    type('camera-password', 'pw-1');
    q('camera-password-save')!.click();
    await settle();
    expect(calls.find((c) => c.init?.method === 'PUT')!.init!.body).toBe(JSON.stringify({ password: 'pw-1' }));
    expect(q('camera-login-status')!.textContent).toMatch(/saved/i);
    expect(q('camera-login-secret')).toBeNull();
  });

  it.each([
    [{ status: 422, body: { error: 'camera_refused' } }, 'The camera refused this password.'],
    [{ status: 503, body: { error: 'camera_offline' } }, "The camera can't be reached."],
    [{ status: 429, body: { error: 'too_many_attempts', retryAfterS: 90 } }, 'Too many tries; wait 90 s.'],
    [{ status: 409, body: { error: 'env_password' } }, 'This proxy has a password in its settings file; remove it there first.'],
    [{ status: 403, body: { error: 'proxy_admin_missing' } }, "cams has no admin token for this proxy: use the proxy's admin page."],
  ])('says the proxy\'s answer %j in words', async (answer, text) => {
    answers['PUT /api/cameras/den/credentials'] = [answer];
    render(CameraLogin, { cameraId: 'den', missing: true });
    type('camera-password', 'typed-secret');
    q('camera-password-save')!.click();
    await settle();
    expect(q('camera-login-status')!.textContent).toBe(text);
    expect(document.body.textContent).not.toContain('typed-secret');
  });

  it('is there for admins in file mode too', () => {
    render(CameraLogin, { cameraId: 'den' });
    expect(q('camera-login')).not.toBeNull();
    expect(q('camera-password-change')).not.toBeNull();
  });
});

describe('CameraTrust', () => {
  it('shows the fingerprint the proxy measured and pins it', async () => {
    const saved = vi.fn();
    answers['POST /api/cameras/den/trust'] = [{ status: 200, body: { mode: 'pinned' } }];
    render(CameraTrust, { cameraId: 'den', fingerprint: FP, onsaved: saved });
    expect(q('trust-fingerprint')!.textContent).toBe(FP);
    expect(document.querySelector('input')).toBeNull(); // never typed
    q('trust-confirm')!.click();
    await settle();
    expect(calls.at(-1)!.init!.body).toBe(JSON.stringify({ fingerprint: FP }));
    expect(saved).toHaveBeenCalledOnce();
  });

  it('on 409 shows the new fingerprint for another confirm', async () => {
    answers['POST /api/cameras/den/trust'] = [{ status: 409, body: { error: 'fingerprint_changed', fingerprint: FP2 } }, { status: 200, body: { mode: 'pinned' } }];
    const saved = vi.fn();
    render(CameraTrust, { cameraId: 'den', fingerprint: FP, onsaved: saved });
    q('trust-confirm')!.click();
    await settle();
    expect(q('trust-fingerprint')!.textContent).toBe(FP2);
    expect(q('trust-status')!.textContent).toMatch(/another certificate/);
    expect(saved).not.toHaveBeenCalled();
    q('trust-confirm')!.click();
    await settle();
    expect(calls.at(-1)!.init!.body).toBe(JSON.stringify({ fingerprint: FP2 }));
    expect(saved).toHaveBeenCalledOnce();
  });
});

describe('OfflineFix while the proxy has not measured the certificate yet', () => {
  it('asks for the status every 5 s, at most a minute, until the Trust button can show', async () => {
    vi.useFakeTimers();
    try {
      render(OfflineFix, { cameraId: 'den', fix: { login: null, trust: null, canFix: true }, error: 'camera_untrusted' });
      const asks = () => calls.filter((c) => c.url === '/api/cameras/den/status').length;
      expect(asks()).toBe(0);
      await vi.advanceTimersByTimeAsync(5000);
      expect(asks()).toBe(1);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(asks()).toBe(12);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not ask for a viewer or another problem', async () => {
    vi.useFakeTimers();
    try {
      render(OfflineFix, { cameraId: 'den', fix: { login: null, trust: null, canFix: true }, error: 'camera_offline' });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(calls.filter((c) => c.url === '/api/cameras/den/status')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
