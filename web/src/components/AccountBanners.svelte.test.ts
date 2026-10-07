// @vitest-environment jsdom
//
// The account menu and the admin banners (migration P4, M §9.4, §9.5, §9.7):
// "Switch account" only with several accounts; held connection changes and
// a stale configuration for admins only; the camera login.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AccountMenu from './AccountMenu.svelte';
import HeldBanner from './HeldBanner.svelte';
import StaleBanner from './StaleBanner.svelte';
import CameraLogin from './CameraLogin.svelte';
import { cameras, me, type Me } from '../lib/stores';

const BASE: Me = { email: 'a@example.org', version: 'v', buildDate: null, account: { id: 'acc_A', name: 'alpha', displayName: 'Alpha' }, role: 'admin', accounts: 2, configSource: 'cams-admin', staleSince: null, configProblem: null, held: 0 };
let calls: { url: string; init?: RequestInit }[] = [];
let answers: Record<string, { status: number; body: unknown }> = {};
let component: Record<string, unknown> | undefined;
let target: HTMLDivElement | undefined;

beforeEach(() => {
  calls = [];
  answers = {};
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const a = answers[`${init?.method ?? 'GET'} ${url}`] ?? { status: 200, body: {} };
    return new Response(a.status === 204 ? null : JSON.stringify(a.body), { status: a.status, headers: { 'Content-Type': 'application/json' } });
  });
});
afterEach(() => {
  if (component) unmount(component);
  target?.remove();
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
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
  flushSync();
};
const q = (id: string) => target!.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe('AccountMenu', () => {
  it('shows the account; "Switch account" only with more than one', () => {
    me.set(BASE);
    render(AccountMenu);
    expect(q('account-name')!.textContent).toContain('Alpha');
    expect(q('switch-account')!.getAttribute('href')).toBe('/app/accounts');
    unmount(component!);
    target!.remove();
    me.set({ ...BASE, accounts: 1 });
    render(AccountMenu);
    expect(q('switch-account')).toBeNull();
  });
  it('shows nothing in file mode (no account)', () => {
    me.set({ email: 'a', version: 'v', buildDate: null });
    render(AccountMenu);
    expect(q('account-name')).toBeNull();
  });
});

describe('HeldBanner', () => {
  it('lists from → to per camera with Confirm / Keep old (admins only); Confirm posts and reloads', async () => {
    me.set({ ...BASE, held: 1 });
    answers['GET /api/admin/held'] = { status: 200, body: { items: [{ camsId: 'cam1', fields: ['host'], from: { host: '192.0.2.5' }, to: { host: '192.0.2.99' }, keptOld: false }] } };
    answers['POST /api/admin/held/confirm'] = { status: 200, body: { confirmed: ['cam1'] } };
    render(HeldBanner);
    await settle();
    expect(q('held-banner')!.textContent).toContain('192.0.2.5');
    expect(q('held-banner')!.textContent).toContain('192.0.2.99');
    answers['GET /api/admin/held'] = { status: 200, body: { items: [] } };
    q('held-confirm-cam1')!.click();
    await settle();
    expect(calls.some((c) => c.url === '/api/admin/held/confirm' && JSON.parse(String(c.init!.body)).camsIds[0] === 'cam1')).toBe(true);
    expect(q('held-banner')).toBeNull();
  });
  it('a viewer sees no banner and nothing is asked', async () => {
    me.set({ ...BASE, role: 'viewer', held: 0 });
    render(HeldBanner);
    await settle();
    expect(q('held-banner')).toBeNull();
    expect(calls).toEqual([]);
  });
  it('Keep old posts keep', async () => {
    me.set({ ...BASE, held: 1 });
    answers['GET /api/admin/held'] = { status: 200, body: { items: [{ camsId: 'cam1', fields: ['proxyUrl'], from: { proxyUrl: 'http://a' }, to: { proxyUrl: 'http://b' }, keptOld: false }] } };
    render(HeldBanner);
    await settle();
    q('held-keep-cam1')!.click();
    await settle();
    expect(calls.some((c) => c.url === '/api/admin/held/keep')).toBe(true);
  });
});

describe('StaleBanner', () => {
  it('shows "Configuration not refreshed since …" to admins when staleSince is set', () => {
    me.set({ ...BASE, staleSince: Date.UTC(2026, 9, 5, 12, 0) });
    render(StaleBanner);
    expect(q('stale-banner')!.textContent).toMatch(/Configuration not refreshed since/);
  });
  it('says when cams-admin refuses this instance', () => {
    me.set({ ...BASE, configProblem: 'revoked' });
    render(StaleBanner);
    expect(q('stale-banner')!.textContent).toMatch(/enroll/i);
  });
  it('nothing for viewers or when fresh', () => {
    me.set({ ...BASE, role: 'viewer', staleSince: 5 });
    render(StaleBanner);
    expect(q('stale-banner')).toBeNull();
  });
});

describe('CameraLogin', () => {
  beforeEach(() => cameras.set([{ id: 'cam1', name: 'Den', webUiUrl: null, credentials: 'missing' }]));
  it('shows a password field and saves it', async () => {
    me.set(BASE);
    answers['PUT /api/cameras/cam1/credentials'] = { status: 204, body: null };
    render(CameraLogin, { cameraId: 'cam1' });
    const input = q('camera-password') as HTMLInputElement;
    input.value = 'pw-1';
    input.dispatchEvent(new Event('input'));
    flushSync();
    q('camera-password-save')!.click();
    await settle();
    expect(calls.find((c) => c.init?.method === 'PUT')!.init!.body).toBe(JSON.stringify({ password: 'pw-1' }));
    expect(q('camera-login-status')!.textContent).toMatch(/saved/i);
  });
  it('a read-only credentials file: the Secret instructions with <password>, never the typed one', async () => {
    me.set(BASE);
    answers['PUT /api/cameras/cam1/credentials'] = { status: 409, body: { error: 'credentials_read_only', secretKey: 'home/cam1', user: 'cams' } };
    render(CameraLogin, { cameraId: 'cam1' });
    const input = q('camera-password') as HTMLInputElement;
    input.value = 'typed-secret';
    input.dispatchEvent(new Event('input'));
    flushSync();
    q('camera-password-save')!.click();
    await settle();
    const text = q('camera-login-secret')!.textContent!;
    expect(text).toContain('home/cam1');
    expect(text).toContain('<password>');
    expect(text).not.toContain('typed-secret');
  });
  it('nothing for a camera with its password, or for a viewer', () => {
    me.set({ ...BASE, role: 'viewer' });
    render(CameraLogin, { cameraId: 'cam1' });
    expect(q('camera-login')).toBeNull();
  });
});

describe('AccountMenu in the phone drawer', () => {
  it('has its own test ids', () => {
    me.set(BASE);
    render(AccountMenu, { drawer: true });
    expect(q('drawer-switch-account')).not.toBeNull();
    expect(q('switch-account')).toBeNull();
  });
});
